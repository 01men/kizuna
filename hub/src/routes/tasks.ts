import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { RouteCtx } from '../ctx.js';
import { err } from '../errors.js';
import { requireAny, requireAdmin, rateLimit, type AgentRow } from '../auth.js';
import { findAgent } from '../registry.js';
import { newTaskId, isSafeId } from '../ids.js';
import { dequeueAndAudit, type AttemptSnapshot, type QueuedTaskRow } from '../audit.js';

const TASK_BODY_SCHEMA = {
  type: 'object',
  required: ['to', 'content'],
  properties: {
    to: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    from: { type: 'string', maxLength: 64 },
    content: {
      type: 'object',
      required: ['body'],
      properties: {
        title: { type: 'string', maxLength: 500 },
        // A2A 兼容：format=json 时 body 允许直接携带 A2A Message/Task 等对象，原样透传
        body: { type: ['string', 'object'] },
        format: { type: 'string', enum: ['text', 'markdown', 'json'] },
        priority: { type: 'string', enum: ['normal', 'high'] },
        deadline: { type: ['string', 'null'], maxLength: 40 },
      },
    },
  },
} as const;

/** 任务内容总体上限（序列化后） */
const MAX_CONTENT_BYTES = 512 * 1024;

function taskView(t: QueuedTaskRow) {
  return {
    task_id: t.task_id,
    from: t.from_agent,
    to: t.to_agent,
    title: t.title,
    content: JSON.parse(t.content) as unknown,
    format: t.format,
    priority: t.priority,
    deadline: t.deadline,
    status: t.status,
    attempt_count: t.attempt_count,
    next_action_at: t.next_action_at,
    created_at: t.created_at,
    reply_to: (t as { reply_to?: string | null }).reply_to ?? null,
  };
}

function getTaskRow(db: RouteCtx['db'], taskId: string): QueuedTaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as QueuedTaskRow | undefined;
}

function attemptsOf(db: RouteCtx['db'], taskId: string): AttemptSnapshot[] {
  return db
    .prepare('SELECT n, attempted_at, outcome, http_status, latency_ms, detail FROM task_attempts WHERE task_id = ? ORDER BY n')
    .all(taskId) as AttemptSnapshot[];
}

function canSee(auth: { role: string; agent?: AgentRow }, task: QueuedTaskRow): boolean {
  if (auth.role === 'admin') return true;
  return auth.agent !== undefined && (task.from_agent === auth.agent.agent_id || task.to_agent === auth.agent.agent_id);
}

export default async function tasksRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db } = ctx;

  // ---------- 提交任务包（Agent / Admin） ----------
  fastify.post('/api/v1/tasks', { schema: { body: TASK_BODY_SCHEMA } }, async (req, reply) => {
    const auth = requireAny(req);
    const body = req.body as {
      to: string;
      from?: string;
      content: { title?: string; body: string; format?: string; priority?: string; deadline?: string | null };
    };

    const principal = auth.role === 'admin' ? 'admin' : auth.agent!.agent_id;
    rateLimit(`tasks:${principal}`, 120);

    // from 一律取自令牌（防伪造）；管理员可声明 from
    const from = auth.role === 'admin' ? (body.from ?? 'admin') : auth.agent!.agent_id;

    const target = findAgent(db, body.to);
    if (!target) throw err.agentNotFound(body.to);
    if (target.enabled !== 1) throw err.targetDisabled(body.to);

    const now = new Date().toISOString();
    const content = {
      title: body.content.title ?? null,
      // A2A 透传：body 为对象时强制 format=json（对象原样到达端侧）
      body: body.content.body,
      format: typeof body.content.body === 'object' ? 'json' : (body.content.format ?? 'text'),
      priority: body.content.priority ?? 'normal',
      deadline: body.content.deadline ?? null,
    };
    const contentJson = JSON.stringify(content);
    if (Buffer.byteLength(contentJson) > MAX_CONTENT_BYTES) {
      throw err.validation('任务内容过大（序列化后 ≤512KB）');
    }

    let taskId = newTaskId();
    while (db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(taskId)) taskId = newTaskId();
    db.prepare(
      `INSERT INTO tasks (task_id, from_agent, to_agent, title, content, format, priority, deadline,
                          status, attempt_count, next_action_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ).run(taskId, from, body.to, content.title, contentJson,
      content.format, content.priority, content.deadline, now, now);

    fastify.log.info({ task_id: taskId, from, to: body.to, priority: body.content.priority ?? 'normal' }, 'task enqueued');
    reply.code(202);
    return { task_id: taskId, status: 'queued', enqueued_at: now };
  });

  // ---------- 队列查询（Admin 全量；Agent 仅自己相关） ----------
  fastify.get('/api/v1/tasks', async (req) => {
    const auth = requireAny(req);
    rateLimit(`tasks_list:${auth.agent?.agent_id ?? 'admin'}`, 300);
    const q = req.query as { status?: string; from?: string; to?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (auth.role !== 'admin' && auth.agent) {
      where.push('(from_agent = ? OR to_agent = ?)');
      params.push(auth.agent.agent_id, auth.agent.agent_id);
    }
    if (q.status) {
      where.push('status = ?');
      params.push(q.status);
    }
    if (q.from) {
      where.push('from_agent = ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('to_agent = ?');
      params.push(q.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM tasks ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db
      .prepare(`SELECT * FROM tasks ${whereSql}
                ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END, created_at DESC
                LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as QueuedTaskRow[];
    return { items: rows.map(taskView), total, limit, offset };
  });

  // ---------- 任务详情（含逐次尝试明细） ----------
  fastify.get('/api/v1/tasks/:task_id', async (req) => {
    const auth = requireAny(req);
    const { task_id } = req.params as { task_id: string };
    if (!isSafeId(task_id)) throw err.taskNotFound(task_id);
    const row = getTaskRow(db, task_id);
    // 在途不存在时，尝试从留痕找回终态视图
    if (!row) {
      const audit = db.prepare('SELECT * FROM audit_logs WHERE task_id = ? ORDER BY id DESC').get(task_id) as
        | { log_id: string; outcome: string; attempt_count: number; dequeued_at: string; attempts_json: string; enqueued_at: string; from_agent: string; to_agent: string }
        | undefined;
      if (!audit) throw err.taskNotFound(task_id);
      if (!canSee(auth, { ...(audit as unknown as QueuedTaskRow) })) throw err.forbidden('无权查看该任务');
      return {
        task_id,
        from: audit.from_agent,
        to: audit.to_agent,
        status: audit.outcome,
        finalized: true,
        log_id: audit.log_id,
        enqueued_at: audit.enqueued_at,
        dequeued_at: audit.dequeued_at,
        attempt_count: audit.attempt_count,
        attempts: JSON.parse(audit.attempts_json) as AttemptSnapshot[],
      };
    }
    if (!canSee(auth, row)) throw err.forbidden('无权查看该任务');
    return { ...taskView(row), attempts: attemptsOf(db, task_id), finalized: false };
  });

  // ---------- 立即重投（Admin） ----------
  fastify.post('/api/v1/tasks/:task_id/retry', async (req) => {
    requireAdmin(req);
    const { task_id } = req.params as { task_id: string };
    const row = getTaskRow(db, task_id);
    if (!row) throw err.taskNotFound(task_id);
    const now = new Date().toISOString();
    db.prepare(`UPDATE tasks SET status = 'queued', next_action_at = ? WHERE task_id = ?`).run(now, task_id);
    fastify.log.info({ task_id, by: 'admin' }, 'task retry scheduled');
    return taskView(getTaskRow(db, task_id)!);
  });

  // ---------- 人工取消（Admin）：出队 + 留痕 cancelled ----------
  fastify.post('/api/v1/tasks/:task_id/cancel', async (req) => {
    requireAdmin(req);
    const { task_id } = req.params as { task_id: string };
    const row = getTaskRow(db, task_id);
    if (!row) throw err.taskNotFound(task_id);
    const attempts = attemptsOf(db, task_id);
    dequeueAndAudit(db, { task: row, outcome: 'cancelled', attempts, reason: '管理员人工取消' });
    fastify.log.info({ task_id, by: 'admin' }, 'task cancelled');
    return { ok: true, task_id, outcome: 'cancelled' };
  });

  // ---------- 结果回传（v1.1，A2A 三分类）：接收方 → Hub →（终态自动回执）发起方 ----------

  const RESULT_STATES: Record<string, 'in_progress' | 'interrupted' | 'terminal'> = {
    working: 'in_progress',
    'input-required': 'interrupted',
    completed: 'terminal',
    failed: 'terminal',
    canceled: 'terminal',
  };

  interface ResultRow {
    id: number;
    task_id: string;
    reported_by: string;
    state: string;
    category: string;
    message: string | null;
    result_json: string | null;
    content_digest: string | null;
    relayed_to: string | null;
    reported_at: string;
  }

  function deliveredAuditOf(taskId: string) {
    return db
      .prepare(`SELECT * FROM audit_logs WHERE task_id = ? AND outcome = 'delivered_confirmed' ORDER BY id DESC LIMIT 1`)
      .get(taskId) as { to_agent: string; from_agent: string } | undefined;
  }

  fastify.post('/api/v1/tasks/:task_id/result', async (req, reply) => {
    const auth = requireAny(req);
    const { task_id } = req.params as { task_id: string };
    if (!isSafeId(task_id)) throw err.taskNotFound(task_id);
    const body = (req.body ?? {}) as {
      state?: string;
      message?: string;
      result?: unknown;
      suppress_reply?: boolean;
    };

    const state = String(body.state ?? '');
    const category = RESULT_STATES[state];
    if (!category) {
      throw err.validation(`state 必须是 ${Object.keys(RESULT_STATES).join(' / ')}（进行中/中断/终态三分类）`);
    }
    const message = body.message == null ? null : String(body.message);
    if (message && message.length > 4000) throw err.validation('message 过长（≤4000）');
    let resultJson: string | null = null;
    if (body.result !== undefined && body.result !== null) {
      resultJson = JSON.stringify(body.result);
      if (Buffer.byteLength(resultJson) > 256 * 1024) throw err.validation('result 过大（序列化后 ≤256KB）');
    }

    // 仅「已签收任务」的接收方可回传（管理员豁免）
    const audit = deliveredAuditOf(task_id);
    if (!audit) throw err.validation('任务尚未签收或不存在，不能回传结果');
    const principal = auth.agent?.agent_id ?? 'admin';
    if (auth.role !== 'admin' && auth.agent?.agent_id !== audit.to_agent) {
      throw err.forbidden('仅该任务的接收方可以回传结果');
    }
    rateLimit(`result:${principal}`, 120);

    // 终态默认自动回执：以接收方身份生成一条 json 任务发回发起方（带 reply_to 便于串联）
    let relayed: { task_id: string; to: string } | null = null;
    if (category === 'terminal' && body.suppress_reply !== true) {
      const sender = findAgent(db, audit.from_agent);
      if (sender && sender.enabled === 1) {
        const reportedAt = new Date().toISOString();
        let replyTaskId = newTaskId();
        while (db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(replyTaskId)) replyTaskId = newTaskId();
        const replyContent = JSON.stringify({
          title: `回执 ${task_id}`,
          body: {
            kind: 'kizuna.task-result',
            task_id,
            state,
            message,
            result: body.result ?? null,
            reported_by: audit.to_agent,
            reported_at: reportedAt,
          },
          format: 'json',
          priority: 'normal',
          deadline: null,
        });
        db.prepare(
          `INSERT INTO tasks (task_id, from_agent, to_agent, title, content, format, priority, deadline,
                              status, attempt_count, next_action_at, created_at, reply_to)
           VALUES (?, ?, ?, ?, ?, 'json', 'normal', NULL, 'queued', 0, ?, ?, ?)`,
        ).run(replyTaskId, audit.to_agent, audit.from_agent, `回执 ${task_id}`, replyContent, reportedAt, reportedAt, task_id);
        relayed = { task_id: replyTaskId, to: audit.from_agent };
        fastify.log.info({ task_id, reply_task_id: replyTaskId, state }, 'result relayed to sender');
      }
    }

    const reportedAt = new Date().toISOString();
    const digest = crypto.createHash('sha256').update(resultJson ?? '').digest('hex');
    db.prepare(
      `INSERT INTO task_results (task_id, reported_by, state, category, message, result_json, content_digest, relayed_to, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(task_id, principal, state, category, message, resultJson, digest, relayed?.task_id ?? null, reportedAt);

    fastify.log.info({ task_id, state, category, by: principal }, 'result reported');
    reply.code(202);
    return {
      ok: true,
      task_id,
      state,
      category,
      recorded_at: reportedAt,
      relayed,
    };
  });

  fastify.get('/api/v1/tasks/:task_id/result', async (req) => {
    const auth = requireAny(req);
    const { task_id } = req.params as { task_id: string };
    if (!isSafeId(task_id)) throw err.taskNotFound(task_id);
    const audit = deliveredAuditOf(task_id);
    const inFlight = getTaskRow(db, task_id);
    if (!audit && !inFlight) throw err.taskNotFound(task_id);
    // 发起方 / 接收方 / 管理员可见
    if (auth.role !== 'admin') {
      const me = auth.agent?.agent_id;
      const related = me && ((audit && (audit.from_agent === me || audit.to_agent === me)) ||
        (inFlight && (inFlight.from_agent === me || inFlight.to_agent === me)));
      if (!related) throw err.forbidden('仅任务相关方可以查看结果');
    }
    const rows = db
      .prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY id ASC')
      .all(task_id) as ResultRow[];
    return {
      task_id,
      items: rows.map((r) => ({
        state: r.state,
        category: r.category,
        message: r.message,
        result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
        content_digest: r.content_digest,
        reported_by: r.reported_by,
        relayed_to: r.relayed_to,
        reported_at: r.reported_at,
      })),
    };
  });
}
