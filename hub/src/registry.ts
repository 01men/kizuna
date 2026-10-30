import type { DB } from './db.js';
import { getSettings } from './settings.js';
import type { AgentRow } from './auth.js';

export function parseTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 心跳窗口内 → online；有心跳但超窗 → offline；从无心跳 → unknown。仅展示用，不影响投递 */
export function computeStatus(agent: AgentRow, now = Date.now()): 'online' | 'offline' | 'unknown' {
  if (!agent.last_seen_at || !dbHolder.db) return 'unknown';
  const last = Date.parse(agent.last_seen_at);
  if (Number.isNaN(last)) return 'unknown';
  return now - last <= getSettings(dbHolder.db).heartbeat_window_s * 1000 ? 'online' : 'offline';
}

const dbHolder: { db: DB | null } = { db: null };
/** 模块初始化时注入 db（index.ts 启动时调用一次） */
export function bindRegistryDb(db: DB): void {
  dbHolder.db = db;
}

export interface AgentView {
  agent_id: string;
  name: string;
  capabilities: string;
  capability_tags: string[];
  webhook_url: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'unknown';
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  /** A2A Agent Card（对象）；未发布为 null */
  agent_card: Record<string, unknown> | null;
  /** 对外卡片地址（公开，无需鉴权） */
  agent_card_url: string | null;
}

function parseCard(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function toView(agent: AgentRow): AgentView {
  const card = parseCard((agent as { agent_card?: string | null }).agent_card);
  return {
    agent_id: agent.agent_id,
    name: agent.name,
    capabilities: agent.capabilities,
    capability_tags: parseTags(agent.capability_tags),
    webhook_url: agent.webhook_url,
    enabled: agent.enabled === 1,
    status: computeStatus(agent),
    last_seen_at: agent.last_seen_at,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
    agent_card: card,
    agent_card_url: card ? `/api/v1/agents/${encodeURIComponent(agent.agent_id)}/agent-card.json` : null,
  };
}

export function findAgent(db: DB, agentId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) as AgentRow | undefined;
}
