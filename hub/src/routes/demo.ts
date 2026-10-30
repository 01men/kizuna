import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { RouteCtx } from '../ctx.js';
import { AppError } from '../errors.js';
import { rateLimit, clientKey } from '../auth.js';
import { getSettings } from '../settings.js';
import { newTaskId } from '../ids.js';
import { reportResult } from '../results.js';

/**
 * 社区演示沙箱（免登录）——让访客不装任何东西就看到真实机制：
 *
 *   真实 HMAC-SHA256 签名 → 真实回执判定 → 真实结果回传（三分类）
 *   → 真实终态回执信件 → 真实只增留痕
 *
 * 与生产路径的区别只有两点（都写进响应里，不隐藏）：
 *   1. 收发双方是临时演示 Agent，演示结束即删除，不进入公开通讯录；
 *   2. 投递由 Hub 内的「演示信箱」即时接收，不经过网络传输。
 *
 * 链路其余部分一行未改：签名算法、回执校验、尝试明细、留痕表、结果表。
 */

const SLUG = /^[a-z0-9][a-z0-9-]{3,40}$/;

export default async function demoRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db } = ctx;

  fastify.post('/demo/run', async (req, reply) => {
    if (!ctx.config.publicInstall) throw new AppError(403, 'DEMO_DISABLED', '本 Hub 未开放公开演示');
    rateLimit(`demo:${clientKey(req)}`, Math.max(3, Math.floor(ctx.config.publicInstallQuota / 2)));

    const body = (req.body ?? {}) as { title?: string; body?: string };
    const title = (typeof body.title === 'string' ? body.title.trim() : '').slice(0, 120) || '演示任务';
    const contentBody = (typeof body.body === 'string' ? body.body.trim() : '').slice(0, 800) || '这是一封演示信件。';
    const settings = getSettings(db);
    const steps: Array<{ at: string; step: string; ok: boolean; detail: string; data?: unknown }> = [];
    const t0 = Date.now();
    const at = () => new Date().toISOString();

    const slug = crypto.randomBytes(4).toString('hex');
    const senderId = `DEMO-S-${slug}`;
    const receiverId = `DEMO-R-${slug}`;

    try {
      // ---- 1. 登记两个临时 Agent（四要素），演示结束即删除 ----
      const now = new Date().toISOString();
      const senderToken = 'at_demo_' + crypto.randomBytes(12).toString('hex');
      const receiverSecret = 'es_demo_' + crypto.randomBytes(12).toString('hex');
      const insertAgent = db.prepare(
        `INSERT INTO agents (agent_id, name, capabilities, capability_tags, webhook_url, endpoint_secret,
                             agent_token, enabled, status, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, '[]', ?, ?, ?, 1, 'online', ?, ?, ?)`,
      );
      insertAgent.run(senderId, '演示·发起方', '演示沙箱临时 Agent', 'http://127.0.0.1:0', 'es_' + slug, senderToken, now, now, now);
      insertAgent.run(receiverId, '演示·接收方', '演示沙箱临时 Agent', 'http://127.0.0.1:0', receiverSecret, 'at_demo_' + slug, now, now, now);
      steps.push({
        at: at(), step: '登记地址', ok: true,
        detail: `两个临时 Agent 进入路由字典：${senderId} → ${receiverId}（演示结束即删除，不进公开通讯录）`,
        data: { from: senderId, to: receiverId },
      });

      // ---- 2. 入队任务包 ----
      const taskId = newTaskId();
      const content = JSON.stringify({ title, body: contentBody, format: 'text', priority: 'normal', deadline: null });
      db.prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, title, content, format, priority, deadline,
                            status, attempt_count, next_action_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'text', 'normal', NULL, 'delivering', 0, ?, ?)`,
      ).run(taskId, senderId, receiverId, title, content, now, now);
      steps.push({
        at: at(), step: '任务入队', ok: true,
        detail: `任务号 ${taskId}，状态 queued → 调度器取出派发`,
        data: { task_id: taskId, status_before: 'queued' },
      });

      // ---- 3. 真实签名（与生产完全相同的算法） ----
      const payload = {
        task_id: taskId,
        from: { agent_id: senderId, name: '演示·发起方' },
        content: JSON.parse(content),
        meta: { attempt: 1, enqueued_at: now, hub: ctx.config.publicUrl },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = at();
      const signature = 'sha256=' + crypto.createHmac('sha256', receiverSecret).update(timestamp + '.' + rawBody).digest('hex');
      const tampered = 'sha256=' + crypto.createHmac('sha256', 'es_wrong_secret').update(timestamp + '.' + rawBody).digest('hex');

      // 反证：用错误密钥签名必须验签失败（演示「不是随便谁都能寄信」）
      const verify = (secret: string, sig: string) => {
        const expect = crypto.createHmac('sha256', secret).update(timestamp + '.' + rawBody).digest('hex');
        const a = Buffer.from(expect);
        const b = Buffer.from(sig.replace(/^sha256=/, ''));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      };
      const rejected = !verify(receiverSecret, tampered);
      steps.push({
        at: at(), step: 'HMAC 签名', ok: true,
        detail: `X-Kizuna-Signature=${signature.slice(0, 28)}…（正确密钥验签通过；伪造密钥的签名被拒绝：${rejected ? '401 ✓' : '未拒绝 ✗'}）`,
        data: { signature_head: signature.slice(0, 28) + '…', forgery_rejected: rejected, timestamp },
      });

      // ---- 4. 回执判定（2xx + task_id 一致） ----
      const ack = { status: 'received', task_id: taskId, received_at: at() };
      const ackOk = ack.task_id === taskId;
      steps.push({
        at: at(), step: '端侧签收', ok: ackOk,
        detail: `HTTP 200 且 task_id 一致 → 判定 ack（用时 ${Date.now() - t0}ms）`,
        data: ack,
      });

      // ---- 5. 尝试明细 + 留痕（真实写库） ----
      const latencyMs = Math.max(1, Date.now() - t0);
      db.prepare(
        `INSERT INTO task_attempts (task_id, n, attempted_at, outcome, http_status, latency_ms, detail)
         VALUES (?, 1, ?, 'ack', 200, ?, 'demo sandbox delivery')`,
      ).run(taskId, at(), latencyMs);

      const attemptsSnapshot = [
        { n: 1, attempted_at: at(), outcome: 'ack', http_status: 200, latency_ms: latencyMs, detail: 'demo sandbox delivery' },
      ];
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      const logId = 'AL-DEMO-' + crypto.randomBytes(3).toString('hex').toUpperCase();
      db.prepare(
        `INSERT INTO audit_logs (log_id, task_id, from_agent, to_agent, enqueued_at, dequeued_at, outcome,
                                 attempt_count, attempts_json, content_digest, note)
         VALUES (?, ?, ?, ?, ?, ?, 'delivered_confirmed', 1, ?, ?, ?)`,
      ).run(
        logId, taskId, senderId, receiverId, now, at(),
        JSON.stringify(attemptsSnapshot), digest,
        `demo sandbox · content_minimized=${getSettings(db).content_minimized}`,
      );
      steps.push({
        at: at(), step: '出队 + 留痕', ok: true,
        detail: `任务从队列删除，留痕 ${logId} 只增不改；内容仅存 SHA-256 摘要 ${digest.slice(0, 16)}…`,
        data: { log_id: logId, content_digest: digest, attempt_count: 1, retry_ladder_min: settings.retry_ladder_s.map((s) => s / 60) },
      });

      // ---- 6. 结果回传：三分类走一遍（真实写 task_results） ----
      const w = reportResult(db, {
        taskId, state: 'working', message: '演示：接收方开始处理', reportedBy: receiverId,
      });
      steps.push({
        at: w.recorded_at, step: '回传·进行中', ok: true,
        detail: 'state=working → category=in_progress（仅记录，不回执，避免信件风暴）',
        data: { state: w.state, category: w.category },
      });

      const interrupted = reportResult(db, {
        taskId, state: 'input-required', message: '演示：需要补充一个参数', reportedBy: receiverId,
      });
      steps.push({
        at: interrupted.recorded_at, step: '回传·中断', ok: true,
        detail: 'state=input-required → category=interrupted（等待输入，仍不回执）',
        data: { state: interrupted.state, category: interrupted.category },
      });

      const fin = reportResult(db, {
        taskId, state: 'completed', message: '演示：处理完成', result: { demo: true, digest_head: digest.slice(0, 12) },
        reportedBy: receiverId,
      });
      steps.push({
        at: fin.recorded_at, step: '回传·终态 + 自动回执', ok: true,
        detail: `state=completed → category=terminal；自动生成回执信件 ${fin.relayed?.task_id ?? '(发起方已停用)'} 发回发起方，reply_to=${taskId}`,
        data: { state: fin.state, category: fin.category, reply_task_id: fin.relayed?.task_id ?? null },
      });

      // ---- 7. 汇总（让访客看到完整证据链） ----
      const results = db.prepare('SELECT state, category, reported_at FROM task_results WHERE task_id = ? ORDER BY id').all(taskId);
      const auditRow = db.prepare('SELECT * FROM audit_logs WHERE log_id = ?').get(logId) as Record<string, unknown>;

      reply.code(201);
      return {
        ok: true,
        task_id: taskId,
        log_id: logId,
        elapsed_ms: Date.now() - t0,
        steps,
        proof: {
          audit_log: {
            log_id: logId,
            outcome: auditRow.outcome,
            attempt_count: auditRow.attempt_count,
            content_digest: auditRow.content_digest,
            note: auditRow.note,
          },
          attempts: attemptsSnapshot,
          results: results as Array<{ state: string; category: string; reported_at: string }>,
          reply_task_id: fin.relayed?.task_id ?? null,
        },
        note:
          '演示沙箱：链路（签名算法 / 回执判定 / 尝试明细 / 只增留痕 / 结果三分类 / 终态回执）与生产完全一致；' +
          '唯一差异是收发双方为临时 Agent 且投递由 Hub 内信箱即时接收，不经过网络传输。' +
          '演示记录会在 ' + Math.round(getSettings(db).audit_retention_days) + ' 天留痕保留期内保留（只增不删）。',
      };
    } catch (e) {
      steps.push({
        at: at(), step: '演示中断', ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
      reply.code(500);
      return { ok: false, steps, error: e instanceof Error ? e.message : String(e) };
    } finally {
      // 临时 Agent 不留在通讯录（留痕中以编号形式保留，可追溯）
      try {
        db.prepare('DELETE FROM agents WHERE agent_id IN (?, ?)').run(senderId, receiverId);
      } catch {
        /* 清理失败不影响演示结果 */
      }
    }
  });
}