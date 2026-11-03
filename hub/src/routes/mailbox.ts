import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../ctx.js';
import { err } from '../errors.js';
import { requireAgent, rateLimit } from '../auth.js';
import { isSafeId } from '../ids.js';

/**
 * Hub 托管信箱（拉取模式，v0.4）：
 * 无 webhook 的 Agent（自主注册 / 内网 / NAT 后）由 Hub 代收信件，凭 agent_token 拉取。
 * 每封信下发与推送投递完全一致的签名信封，收信方用 endpoint_secret 本地验签，
 * 安全模型与推送模式一字不差；ack 仅作已读标记（幂等），不影响投递语义。
 */
export default async function mailboxRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db } = ctx;

  // ---------- 待读列表 ----------
  fastify.get('/api/v1/mailbox', async (req) => {
    const agent = requireAgent(req);
    rateLimit(`mailbox:${agent.agent_id}`, 120);
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 500);
    const total = (db
      .prepare(`SELECT COUNT(*) AS c FROM mailbox WHERE to_agent = ? AND state = 'pending'`)
      .get(agent.agent_id) as { c: number }).c;
    const rows = db
      .prepare(
        `SELECT seq, task_id, payload, signature, signed_at, created_at FROM mailbox
         WHERE to_agent = ? AND state = 'pending' ORDER BY seq LIMIT ?`,
      )
      .all(agent.agent_id, limit) as Array<{
      seq: number;
      task_id: string;
      payload: string;
      signature: string;
      signed_at: string;
      created_at: string;
    }>;
    return {
      agent_id: agent.agent_id,
      total,
      limit,
      items: rows.map((r) => ({
        seq: r.seq,
        task_id: r.task_id,
        // 原样下发投递信封原文与签名：hex(HMAC_SHA256(endpoint_secret, signed_at + "." + payload)) === signature
        payload: r.payload,
        signature: r.signature,
        signed_at: r.signed_at,
        queued_at: r.created_at,
      })),
    };
  });

  // ---------- 单封信（含已读） ----------
  fastify.get('/api/v1/mailbox/:task_id', async (req) => {
    const agent = requireAgent(req);
    const { task_id } = req.params as { task_id: string };
    if (!isSafeId(task_id)) throw err.taskNotFound(task_id);
    const row = db.prepare('SELECT * FROM mailbox WHERE to_agent = ? AND task_id = ?').get(agent.agent_id, task_id) as
      | { task_id: string; payload: string; signature: string; signed_at: string; state: string; created_at: string; read_at: string | null }
      | undefined;
    if (!row) throw err.taskNotFound(task_id);
    return {
      task_id: row.task_id,
      state: row.state,
      payload: row.payload,
      signature: row.signature,
      signed_at: row.signed_at,
      queued_at: row.created_at,
      read_at: row.read_at,
    };
  });

  // ---------- 签收（幂等已读标记） ----------
  fastify.post('/api/v1/mailbox/:task_id/ack', async (req) => {
    const agent = requireAgent(req);
    rateLimit(`mailbox_ack:${agent.agent_id}`, 240);
    const { task_id } = req.params as { task_id: string };
    if (!isSafeId(task_id)) throw err.taskNotFound(task_id);
    const marked = db
      .prepare(`UPDATE mailbox SET state = 'read', read_at = ? WHERE to_agent = ? AND task_id = ? AND state = 'pending'`)
      .run(new Date().toISOString(), agent.agent_id, task_id);
    return { ok: true, task_id, acked: marked.changes === 1 };
  });
}
