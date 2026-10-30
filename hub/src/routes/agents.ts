import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../ctx.js';
import { err } from '../errors.js';
import { requireAny, requireAdmin, rateLimit } from '../auth.js';
import { findAgent, toView } from '../registry.js';
import { createAgent, validateAgentCard } from '../agentService.js';
import { VERSION, A2A_PROTOCOL_VERSION } from '../version.js';

const AGENT_BODY_SCHEMA = {
  type: 'object',
  properties: {
    agent_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    capabilities: { type: 'string', maxLength: 2000 },
    capability_tags: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 32 },
    webhook_url: { type: 'string', pattern: '^https?://.+', maxLength: 2000 },
    agent_card: { type: ['object', 'null'] },
  },
} as const;

interface EnrollRow {
  token: string;
  agent_draft: string;
  expires_at: string;
  used_at: string | null;
}

export default async function agentsRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db } = ctx;

  // ---------- 注册（Admin / Enroll） ----------
  fastify.post('/api/v1/agents', { schema: { body: AGENT_BODY_SCHEMA } }, async (req, reply) => {
    const body = req.body as {
      agent_id?: string;
      name: string;
      capabilities?: string;
      capability_tags?: string[];
      webhook_url: string;
      enroll_token?: string;
    };

    // 鉴权：管理员令牌，或一次性 enroll 令牌（query ?token= 或 body.enroll_token）
    const enrollToken = (req.query as { token?: string }).token ?? body.enroll_token ?? null;
    let draft: {
      agent_id?: string;
      name?: string;
      capabilities?: string;
      capability_tags?: string[];
      webhook_url?: string;
    } = {};
    if (req.auth?.role !== 'admin') {
      if (!enrollToken) throw err.unauthorized('需要管理员令牌或一次性注册令牌');
      const row = db.prepare('SELECT * FROM enroll_tokens WHERE token = ?').get(enrollToken) as EnrollRow | undefined;
      if (!row) throw err.unauthorized('注册令牌无效');
      if (row.used_at) throw err.tokenUsed();
      if (Date.parse(row.expires_at) < Date.now()) throw err.tokenExpired();
      draft = JSON.parse(row.agent_draft);
      // 用后作废（原子占位，防并发双用）
      const marked = db
        .prepare('UPDATE enroll_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL')
        .run(new Date().toISOString(), enrollToken);
      if (marked.changes !== 1) throw err.tokenUsed();
      fastify.log.info({ enroll: true }, 'enroll token consumed');
    }

    rateLimit(`register:${req.auth?.agent?.agent_id ?? req.ip}`, 60);

    let result;
    try {
      result = createAgent(db, {
        agent_id: body.agent_id ?? draft.agent_id,
        name: body.name ?? draft.name,
        capabilities: body.capabilities ?? draft.capabilities ?? '',
        capability_tags: body.capability_tags ?? draft.capability_tags ?? [],
        webhook_url: body.webhook_url ?? draft.webhook_url,
        agent_card: ((body as { agent_card?: unknown }).agent_card ??
          (draft as { agent_card?: unknown }).agent_card ?? null) as Record<string, unknown> | null,
      });
    } catch (e) {
      // 注册失败（如编号冲突）：回滚令牌占用，允许换号重试
      if (enrollToken && req.auth?.role !== 'admin') {
        db.prepare('UPDATE enroll_tokens SET used_at = NULL WHERE token = ? AND used_at IS NOT NULL').run(enrollToken);
      }
      throw e;
    }
    fastify.log.info({ agent_id: result.agent_id }, 'agent registered');
    reply.code(201);
    return {
      agent_id: result.agent_id,
      agent_token: result.agent_token,
      endpoint_secret: result.endpoint_secret,
      webhook_url: result.webhook_url,
      note: 'agent_token 与 endpoint_secret 仅此一次返回，请妥善保存',
    };
  });

  // ---------- 列表 + 能力检索（Admin / Agent） ----------
  fastify.get('/api/v1/agents', async (req) => {
    requireAny(req);
    rateLimit(`agents_list:${req.auth?.agent?.agent_id ?? 'admin'}`, 300);
    const q = req.query as { q?: string; tag?: string; status?: string; enabled?: string; limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);

    const where: string[] = [];
    const params: unknown[] = [];
    if (q.q) {
      where.push('(agent_id LIKE ? OR name LIKE ? OR capabilities LIKE ?)');
      const like = `%${q.q}%`;
      params.push(like, like, like);
    }
    if (q.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(agents.capability_tags) WHERE json_each.value = ?)");
      params.push(q.tag);
    }
    if (q.enabled === 'true' || q.enabled === 'false') {
      where.push('enabled = ?');
      params.push(q.enabled === 'true' ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const all = db.prepare(`SELECT * FROM agents ${whereSql} ORDER BY created_at DESC`).all(...params) as import('../auth.js').AgentRow[];
    const views = all.map((r) => toView(r));
    const filtered = q.status ? views.filter((v) => v.status === q.status) : views;
    const items = filtered.slice(offset, offset + limit);
    return { items, total: filtered.length, limit, offset };
  });

  // ---------- 详情（Admin / Agent），含该 Agent 近期收发 ----------
  fastify.get('/api/v1/agents/:agent_id', async (req) => {
    requireAny(req);
    const { agent_id } = req.params as { agent_id: string };
    const row = findAgent(db, agent_id);
    if (!row) throw err.agentNotFound(agent_id);
    const recentIn = db
      .prepare('SELECT log_id, task_id, from_agent, outcome, dequeued_at FROM audit_logs WHERE to_agent = ? ORDER BY id DESC LIMIT 10')
      .all(agent_id);
    const recentOut = db
      .prepare('SELECT log_id, task_id, to_agent, outcome, dequeued_at FROM audit_logs WHERE from_agent = ? ORDER BY id DESC LIMIT 10')
      .all(agent_id);
    return { ...toView(row), recent_in: recentIn, recent_out: recentOut };
  });

  // ---------- 更新（Admin） ----------
  fastify.patch('/api/v1/agents/:agent_id', async (req) => {
    requireAdmin(req);
    const { agent_id } = req.params as { agent_id: string };
    const row = findAgent(db, agent_id);
    if (!row) throw err.agentNotFound(agent_id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw err.validation('name 不能为空');
      sets.push('name = ?');
      params.push(body.name.trim());
    }
    if (body.capabilities !== undefined) {
      sets.push('capabilities = ?');
      params.push(String(body.capabilities));
    }
    if (body.capability_tags !== undefined) {
      if (!Array.isArray(body.capability_tags)) throw err.validation('capability_tags 必须是字符串数组');
      sets.push('capability_tags = ?');
      params.push(JSON.stringify(body.capability_tags.map((t) => String(t).trim()).filter(Boolean)));
    }
    if (body.webhook_url !== undefined) {
      if (!/^https?:\/\/.+/.test(String(body.webhook_url))) throw err.validation('webhook_url 必须是 http/https 地址');
      sets.push('webhook_url = ?');
      params.push(String(body.webhook_url));
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw err.validation('enabled 必须是布尔值');
      sets.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }
    if (body.agent_card !== undefined) {
      // 对象 = 发布/更新；null = 撤卡
      const card = validateAgentCard(body.agent_card);
      sets.push('agent_card = ?');
      params.push(card === null ? null : JSON.stringify(card));
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(agent_id);
      db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE agent_id = ?`).run(...params);
      fastify.log.info({ agent_id, fields: sets.filter((s) => s !== 'updated_at = ?') }, 'agent updated');
    }
    return toView(findAgent(db, agent_id)!);
  });

  // ---------- 注销（Admin）：在途任务照常由调度器处理（目标消失 → invalid_target 留痕） ----------
  fastify.delete('/api/v1/agents/:agent_id', async (req) => {
    requireAdmin(req);
    const { agent_id } = req.params as { agent_id: string };
    const gone = db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agent_id);
    if (gone.changes === 0) throw err.agentNotFound(agent_id);
    fastify.log.info({ agent_id }, 'agent deleted');
    return { ok: true, agent_id };
  });

  // ---------- 心跳（Agent，60s 一次） ----------
  fastify.post('/api/v1/heartbeat', async (req) => {
    const agent = req.auth?.agent;
    if (!agent) throw err.forbidden('心跳需要 Agent 令牌');
    rateLimit(`heartbeat:${agent.agent_id}`, 30);
    const now = new Date().toISOString();
    db.prepare('UPDATE agents SET last_seen_at = ?, updated_at = ? WHERE agent_id = ?').run(now, now, agent.agent_id);
    return { ok: true, agent_id: agent.agent_id, at: now };
  });

  // ---------- A2A 兼容层（公开，无需鉴权） ----------

  /** Hub 自身卡片；?agent=<id> 下发指定 Agent 的已发布卡片 */
  fastify.get('/.well-known/agent-card.json', async (req) => {
    const q = (req.query as { agent?: string }).agent;
    if (!q) {
      return {
        name: 'Kizuna Hub',
        description: 'Agent 通讯录与任务可靠投递（Kizuna）——登记 Agent、可靠投递任务包、全程留痕；content.format=json 可原样透传 A2A Message/Task。',
        url: ctx.config.publicUrl,
        preferredTransport: 'HTTP+JSON',
        provider: { organization: 'Kizuna', url: ctx.config.publicUrl },
        version: VERSION,
        protocolVersion: A2A_PROTOCOL_VERSION,
        capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
        defaultInputModes: ['application/json', 'text/plain'],
        defaultOutputModes: ['application/json', 'text/plain'],
        skills: [
          {
            id: 'task-relay',
            name: '任务可靠投递',
            description: '按重试梯度（默认 3/10/30/60/120 分钟）可靠投递任务包，回执确认、只增留痕',
            tags: ['relay', 'delivery', 'queue'],
          },
          {
            id: 'agent-directory',
            name: 'Agent 通讯录',
            description: 'Agent 四要素登记与能力检索，支持发布 A2A Agent Card',
            tags: ['directory', 'registry', 'a2a'],
          },
          {
            id: 'result-relay',
            name: '结果回传',
            description: '签收后结果回传（进行中/中断/终态三分类），终态自动回执给发起方',
            tags: ['a2a', 'result', 'lifecycle'],
          },
        ],
        kizuna: {
          note: '核心投递协议为 Kizuna 自有协议，A2A 为兼容适配层；本卡片中的 kizuna 字段为非标扩展。',
          enqueue: { method: 'POST', path: '/api/v1/tasks' },
          directory: { method: 'GET', path: '/api/v1/agents' },
          agentCardPattern: '/.well-known/agent-card.json?agent=<agent_id>',
          resultReporting: { method: 'POST', path: '/api/v1/tasks/<task_id>/result' },
          states: { in_progress: ['working'], interrupted: ['input-required'], terminal: ['completed', 'failed', 'canceled'] },
        },
      };
    }
    const row = findAgent(db, q);
    if (!row || row.enabled !== 1) throw err.agentNotFound(q);
    const card = toView(row).agent_card;
    if (!card) throw err.cardNotFound(q);
    return card;
  });

  /** 单个 Agent 的公开卡片（A2A 发现习惯：url 指向 agent-card.json） */
  fastify.get('/api/v1/agents/:agent_id/agent-card.json', async (req) => {
    const { agent_id } = req.params as { agent_id: string };
    const row = findAgent(db, agent_id);
    if (!row || row.enabled !== 1) throw err.agentNotFound(agent_id);
    const card = toView(row).agent_card;
    if (!card) throw err.cardNotFound(agent_id);
    return card;
  });
}
