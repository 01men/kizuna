import type { DB } from './db.js';
import { err } from './errors.js';
import { findAgent } from './registry.js';
import { newAgentId, newAgentToken, newEndpointSecret, isSafeId } from './ids.js';

export interface CreateAgentInput {
  agent_id?: string;
  name?: string;
  capabilities?: string;
  capability_tags?: string[];
  webhook_url?: string;
  /** A2A Agent Card（对象，原样存储；null/缺省 = 不发布） */
  agent_card?: Record<string, unknown> | null;
}

export interface CreateAgentResult {
  agent_id: string;
  agent_token: string;
  endpoint_secret: string;
  webhook_url: string;
}

/** A2A Agent Card 最小校验：对象 + name 字符串；≤64KB；其余字段原样保留（A2A 规格演进不设障） */
export function validateAgentCard(card: unknown): Record<string, unknown> | null {
  if (card === null || card === undefined) return null;
  if (typeof card !== 'object' || Array.isArray(card)) throw err.validation('agent_card 必须是 JSON 对象（A2A Agent Card 格式）');
  const o = card as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name.trim()) throw err.validation('agent_card.name 必填（字符串）');
  const size = Buffer.byteLength(JSON.stringify(o));
  if (size > 64 * 1024) throw err.validation('agent_card 过大（≤64KB）');
  return o;
}

/** 路由字典唯一写入口：POST /agents 与 enroll 回调共用 */
export function createAgent(db: DB, input: CreateAgentInput): CreateAgentResult {
  const agentId = input.agent_id || newAgentId();
  if (!isSafeId(agentId)) throw err.validation('agent_id 含非法字符');
  if (findAgent(db, agentId)) throw err.agentConflict(agentId);

  const name = (input.name ?? '').trim();
  const webhook = (input.webhook_url ?? '').trim();
  if (!name) throw err.validation('缺少 name');
  if (!/^https?:\/\/.+/.test(webhook)) throw err.validation('webhook_url 必须是 http/https 地址');
  if ((input.capabilities ?? '').length > 2000) throw err.validation('capabilities 过长（≤2000）');
  const tags = Array.isArray(input.capability_tags) ? input.capability_tags : [];
  if (tags.length > 32) throw err.validation('capability_tags 最多 32 个');
  const card = validateAgentCard(input.agent_card);

  const now = new Date().toISOString();
  const agentToken = newAgentToken();
  const endpointSecret = newEndpointSecret();
  db.prepare(
    `INSERT INTO agents
       (agent_id, name, capabilities, capability_tags, webhook_url, endpoint_secret,
        agent_token, enabled, status, last_seen_at, created_at, updated_at, agent_card)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'unknown', NULL, ?, ?, ?)`,
  ).run(
    agentId,
    name,
    input.capabilities ?? '',
    JSON.stringify(tags.map((t) => String(t).trim()).filter(Boolean)),
    webhook,
    endpointSecret,
    agentToken,
    now,
    now,
    card === null ? null : JSON.stringify(card),
  );
  return { agent_id: agentId, agent_token: agentToken, endpoint_secret: endpointSecret, webhook_url: webhook };
}
