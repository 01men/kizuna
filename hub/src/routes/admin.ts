import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../ctx.js';
import { err } from '../errors.js';
import { requireAdmin } from '../auth.js';
import { getSettings, validateSettings, saveSettings } from '../settings.js';
import { renderPrometheus } from '../metrics.js';

const OUTCOMES = ['delivered_confirmed', 'delivery_failed', 'invalid_target', 'cancelled'];

interface AuditRow {
  id: number;
  log_id: string;
  task_id: string;
  from_agent: string;
  to_agent: string;
  enqueued_at: string;
  dequeued_at: string;
  outcome: string;
  attempt_count: number;
  attempts_json: string;
  content_digest: string | null;
  note: string | null;
}

function auditView(r: AuditRow) {
  return {
    log_id: r.log_id,
    task_id: r.task_id,
    from: r.from_agent,
    to: r.to_agent,
    enqueued_at: r.enqueued_at,
    dequeued_at: r.dequeued_at,
    outcome: r.outcome,
    attempt_count: r.attempt_count,
    attempts: JSON.parse(r.attempts_json) as unknown[],
    content_digest: r.content_digest,
    note: r.note,
  };
}

function todayStartIso(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export default async function adminRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db } = ctx;

  // ---------- 总览（05 §2 页面一） ----------
  fastify.get('/api/v1/overview', async (req) => {
    requireAdmin(req);
    const dayStart = todayStartIso();
    const windowStart = new Date(Date.now() - getSettings(db).heartbeat_window_s * 1000).toISOString();

    const agentTotal = (db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
    const agentOnline = (db
      .prepare(`SELECT COUNT(*) AS c FROM agents WHERE enabled = 1 AND last_seen_at IS NOT NULL AND last_seen_at >= ?`)
      .get(windowStart) as { c: number }).c;
    const agentNeverSeen = (db
      .prepare(`SELECT COUNT(*) AS c FROM agents WHERE last_seen_at IS NULL`)
      .get() as { c: number }).c;
    const queueDepth = (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
    const retrying = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'wait_retry'`).get() as { c: number }).c;
    const delivering = (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE status = 'delivering'`).get() as { c: number }).c;
    const todayDelivered = (db
      .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE outcome = 'delivered_confirmed' AND dequeued_at >= ?`)
      .get(dayStart) as { c: number }).c;
    const todayFailed = (db
      .prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE outcome IN ('delivery_failed','invalid_target') AND dequeued_at >= ?`)
      .get(dayStart) as { c: number }).c;

    const recent = db
      .prepare(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 10`)
      .all() as AuditRow[];

    return {
      agents: { total: agentTotal, online: agentOnline, offline: agentTotal - agentOnline - agentNeverSeen, unknown: agentNeverSeen },
      queue: { depth: queueDepth, retrying, delivering },
      today: { delivered: todayDelivered, failed: todayFailed },
      recent_audit: recent.map(auditView),
      generated_at: new Date().toISOString(),
    };
  });

  // ---------- 留痕查询（只读，无删除通道） ----------
  fastify.get('/api/v1/audit', async (req) => {
    requireAdmin(req);
    const q = req.query as { outcome?: string; from?: string; to?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 1000);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.outcome) {
      if (!OUTCOMES.includes(q.outcome)) throw err.validation(`outcome 仅支持: ${OUTCOMES.join('/')}`);
      where.push('outcome = ?');
      params.push(q.outcome);
    }
    if (q.from) {
      where.push('dequeued_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('dequeued_at <= ?');
      params.push(q.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`).get(...params) as { c: number }).c;
    const rows = db
      .prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as AuditRow[];
    return { items: rows.map(auditView), total, limit, offset };
  });

  // ---------- 留痕导出（JSONL / CSV） ----------
  fastify.get('/api/v1/audit/export', async (req, reply) => {
    requireAdmin(req);
    const q = req.query as { outcome?: string; from?: string; to?: string; format?: string };
    const format = q.format === 'csv' ? 'csv' : 'jsonl';

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.outcome && OUTCOMES.includes(q.outcome)) {
      where.push('outcome = ?');
      params.push(q.outcome);
    }
    if (q.from) {
      where.push('dequeued_at >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('dequeued_at <= ?');
      params.push(q.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY id ASC`)
      .all(...params) as AuditRow[];

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply.header('content-disposition', `attachment; filename="kizuna-audit-${stamp}.${format}"`);
    if (format === 'jsonl') {
      reply.type('application/x-ndjson; charset=utf-8');
      return rows.map((r) => JSON.stringify(auditView(r))).join('\n') + (rows.length ? '\n' : '');
    }
    reply.type('text/csv; charset=utf-8');
    const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const head = 'log_id,task_id,from,to,enqueued_at,dequeued_at,outcome,attempt_count,attempts_json,content_digest,note';
    const body = rows
      .map((r) =>
        [r.log_id, r.task_id, r.from_agent, r.to_agent, r.enqueued_at, r.dequeued_at, r.outcome, r.attempt_count, r.attempts_json, r.content_digest, r.note]
          .map(esc)
          .join(','),
      )
      .join('\n');
    return head + '\n' + body + (rows.length ? '\n' : '');
  });

  // ---------- 设置 ----------
  fastify.get('/api/v1/settings', async (req) => {
    requireAdmin(req);
    return { settings: getSettings(db) };
  });

  fastify.put('/api/v1/settings', async (req) => {
    const admin = requireAdmin(req);
    const actor = admin.agent?.agent_id ?? 'admin';
    const next = validateSettings(req.body);
    saveSettings(db, next, actor);
    fastify.log.info({ by: actor }, 'settings updated');
    return { settings: next, saved_at: new Date().toISOString() };
  });

  // ---------- 配置变更历史 ----------
  fastify.get('/api/v1/config-audit', async (req) => {
    requireAdmin(req);
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 500);
    const rows = db.prepare('SELECT at, actor, change FROM config_audit ORDER BY id DESC LIMIT ?').all(limit);
    return { items: rows };
  });

  // ---------- Prometheus 指标 ----------
  fastify.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return renderPrometheus();
  });
}
