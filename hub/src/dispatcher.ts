import crypto from 'node:crypto';
import type { DB } from './db.js';
import type { HubConfig } from './config.js';
import { getSettings } from './settings.js';
import { dequeueAndAudit, type AttemptSnapshot, type QueuedTaskRow } from './audit.js';
import { findAgent } from './registry.js';
import type { AgentRow } from './auth.js';
import { counters, gauges, incr, latency } from './metrics.js';

interface DeliveryPayload {
  task_id: string;
  from: { agent_id: string; name: string };
  content: { title: string | null; body: string; format: string; priority: string; deadline: string | null };
  meta: { attempt: number; enqueued_at: string; hub: string };
}

type Outcome = 'ack' | 'bad_ack' | 'http_4xx' | 'http_5xx' | 'timeout' | 'network_error';

interface AttemptResult {
  outcome: Outcome;
  httpStatus?: number;
  latencyMs: number;
  detail?: string;
}

const TICK_MS = 1000;

export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  /** 同一目标串行：正在投递中的目标编号 */
  private busyTargets = new Set<string>();
  private stopped = false;

  constructor(
    private readonly db: DB,
    private readonly config: HubConfig,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
  ) {}

  start(): void {
    // 崩溃恢复：delivering 复位为 queued（端侧以 task_id 幂等去重，重投安全）
    const recovered = this.db
      .prepare(`UPDATE tasks SET status = 'queued', next_action_at = ? WHERE status = 'delivering'`)
      .run(new Date().toISOString());
    if (recovered.changes > 0) this.log.warn({ recovered: recovered.changes }, 'recovered delivering tasks on boot');
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    this.log.info({ tick_ms: TICK_MS }, 'dispatcher started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** 供测试与重投接口手动触发一次扫描（通常无需调用） */
  tick(): void {
    if (this.stopped) return;
    const settings = getSettings(this.db);
    const now = new Date().toISOString();
    gauges.queueDepth = (this.db.prepare(`SELECT COUNT(*) AS c FROM tasks`).get() as { c: number }).c;
    gauges.retrying = (this.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'wait_retry'`).get() as { c: number }).c;
    this.refreshOnlineGauge();

    if (this.inFlight >= settings.delivery_concurrency) return;
    const candidates = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('queued','wait_retry') AND next_action_at <= ?
         ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, next_action_at
         LIMIT 64`,
      )
      .all(now) as QueuedTaskRow[];

    for (const task of candidates) {
      if (this.inFlight >= settings.delivery_concurrency) break;
      if (this.busyTargets.has(task.to_agent)) continue; // 同目标串行，下个 tick 再取
      // 抢占式置为 delivering，防止下个 tick 重复投递
      const claim = this.db
        .prepare(`UPDATE tasks SET status = 'delivering' WHERE task_id = ? AND status IN ('queued','wait_retry')`)
        .run(task.task_id);
      if (claim.changes !== 1) continue;
      this.inFlight += 1;
      this.busyTargets.add(task.to_agent);
      void this.deliver(task).finally(() => {
        this.inFlight -= 1;
        this.busyTargets.delete(task.to_agent);
      });
    }
  }

  private refreshOnlineGauge(): void {
    const windowStart = new Date(Date.now() - getSettings(this.db).heartbeat_window_s * 1000).toISOString();
    const online = this.db
      .prepare(`SELECT COUNT(*) AS c FROM agents WHERE enabled = 1 AND last_seen_at IS NOT NULL AND last_seen_at >= ?`)
      .get(windowStart) as { c: number };
    gauges.agentsOnline = online.c;
  }

  // ---------- 投递单发 ----------

  private async deliver(task: QueuedTaskRow): Promise<void> {
    const target = findAgent(this.db, task.to_agent);
    // 目标消失/停用/无 webhook：不重试，直接出队留痕（02 §4 设计决策）
    if (!target || target.enabled !== 1 || !target.webhook_url) {
      const attempts = this.attemptsOf(task.task_id);
      const reason = !target ? '目标编号不存在' : target.enabled !== 1 ? '目标已停用' : '目标缺少 webhook';
      this.finalize(task, 'invalid_target', attempts, reason);
      return;
    }

    const settings = getSettings(this.db);
    const attemptNo = task.attempt_count + 1;
    const payload = this.buildPayload(task, attemptNo);
    const rawBody = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const signature =
      'sha256=' + crypto.createHmac('sha256', target.endpoint_secret).update(timestamp + '.' + rawBody).digest('hex');

    const url = this.deliverUrl(target.webhook_url);
    const result = await this.post(url, rawBody, {
      'content-type': 'application/json',
      'x-kizuna-task-id': task.task_id,
      'x-kizuna-timestamp': timestamp,
      'x-kizuna-signature': signature,
      'x-kizuna-attempt': String(attemptNo),
    }, settings.ack_timeout_s * 1000);

    incr(counters.deliveriesTotal, result.outcome);
    latency.count += 1;
    latency.sumMs += result.latencyMs;

    // 尝试明细先落库（在途可查；终态整体快照进留痕）
    const attemptedAt = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO task_attempts (task_id, n, attempted_at, outcome, http_status, latency_ms, detail)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(task.task_id, attemptNo, attemptedAt, result.outcome, result.httpStatus ?? null, result.latencyMs, result.detail ?? null);

    const attempts = this.attemptsOf(task.task_id);

    if (result.outcome === 'ack') {
      this.finalize(task, 'delivered_confirmed', attempts);
      this.log.info({ task_id: task.task_id, attempt: attemptNo, latency_ms: result.latencyMs }, 'delivery acknowledged');
      return;
    }

    const maxAttempts = settings.retry_ladder_s.length + 1;
    if (attemptNo >= maxAttempts) {
      this.finalize(task, 'delivery_failed', attempts, `${maxAttempts} 次尝试均失败`);
      this.log.warn({ task_id: task.task_id, attempt: attemptNo, last_outcome: result.outcome }, 'delivery failed permanently');
      return;
    }

    const delayS = settings.retry_ladder_s[attemptNo - 1] ?? settings.retry_ladder_s[settings.retry_ladder_s.length - 1]!;
    const jitter = settings.jitter_s > 0 ? Math.round((Math.random() * 2 - 1) * settings.jitter_s) : 0;
    const nextAt = new Date(Date.now() + Math.max(1, delayS + jitter) * 1000).toISOString();
    this.db
      .prepare(`UPDATE tasks SET status = 'wait_retry', attempt_count = ?, next_action_at = ? WHERE task_id = ?`)
      .run(attemptNo, nextAt, task.task_id);
    this.log.info(
      { task_id: task.task_id, attempt: attemptNo, outcome: result.outcome, http_status: result.httpStatus, next_action_at: nextAt },
      'delivery failed, retry scheduled',
    );
  }

  private deliverUrl(webhookUrl: string): string {
    const base = webhookUrl.replace(/\/+$/, '');
    return base.endsWith('/kizuna/deliver') ? base : base + '/kizuna/deliver';
  }

  private buildPayload(task: QueuedTaskRow, attemptNo: number): DeliveryPayload {
    let fromName = task.from_agent;
    if (task.from_agent !== 'admin') {
      const from = findAgent(this.db, task.from_agent);
      if (from) fromName = from.name;
    }
    return {
      task_id: task.task_id,
      from: { agent_id: task.from_agent, name: fromName },
      content: JSON.parse(task.content) as DeliveryPayload['content'],
      meta: { attempt: attemptNo, enqueued_at: task.created_at, hub: this.config.publicUrl },
    };
  }

  /** 回执判定（03 §3）：2xx + task_id 一致 → ack；整体超时默认 10s */
  private async post(url: string, body: string, headers: Record<string, string>, timeoutMs: number): Promise<AttemptResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      const latencyMs = Date.now() - started;
      const text = await res.text().catch(() => '');
      if (res.status >= 200 && res.status < 300) {
        try {
          const ack = JSON.parse(text) as { task_id?: string };
          if (ack.task_id === JSON.parse(body).task_id) {
            return { outcome: 'ack', httpStatus: res.status, latencyMs };
          }
          return { outcome: 'bad_ack', httpStatus: res.status, latencyMs, detail: `回执 task_id 不一致: ${String(ack.task_id)}` };
        } catch {
          return { outcome: 'bad_ack', httpStatus: res.status, latencyMs, detail: '回执不是合法 JSON' };
        }
      }
      const detail = text.slice(0, 300);
      return res.status < 500
        ? { outcome: 'http_4xx', httpStatus: res.status, latencyMs, detail }
        : { outcome: 'http_5xx', httpStatus: res.status, latencyMs, detail };
    } catch (e) {
      const latencyMs = Date.now() - started;
      if (controller.signal.aborted) {
        return { outcome: 'timeout', latencyMs, detail: `整体超时（${Math.round(timeoutMs / 1000)}s）` };
      }
      return { outcome: 'network_error', latencyMs, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private attemptsOf(taskId: string): AttemptSnapshot[] {
    return this.db
      .prepare('SELECT n, attempted_at, outcome, http_status, latency_ms, detail FROM task_attempts WHERE task_id = ? ORDER BY n')
      .all(taskId) as AttemptSnapshot[];
  }

  /** 终态：留痕（含全部尝试快照）→ 出队删除。 */
  private finalize(task: QueuedTaskRow, outcome: 'delivered_confirmed' | 'delivery_failed' | 'invalid_target', attempts: AttemptSnapshot[], reason?: string): void {
    dequeueAndAudit(this.db, { task, outcome, attempts, reason });
    incr(counters.auditDeletionsTotal, outcome);
  }
}
