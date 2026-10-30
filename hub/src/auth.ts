import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { err } from './errors.js';

export interface AgentRow {
  agent_id: string;
  name: string;
  capabilities: string;
  capability_tags: string;
  webhook_url: string;
  endpoint_secret: string;
  agent_token: string;
  enabled: number;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthContext {
  role: 'admin' | 'agent';
  agent?: AgentRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

function makeAuthenticator(db: DB, adminToken: string) {
  const byToken = () => db.prepare('SELECT * FROM agents WHERE agent_token = ?');

  return function authenticate(req: FastifyRequest): AuthContext {
    const token = bearerToken(req);
    if (!token) throw err.unauthorized();
    if (token === adminToken) return { role: 'admin' };
    const agent = byToken().get(token) as AgentRow | undefined;
    if (agent) return { role: 'agent', agent };
    throw err.unauthorized();
  };
}

/** 所有 /api/v1 路由的入口鉴权：
 *  - 带 Bearer 头 → 立即校验（无效即 401）；
 *  - 不带 → req.auth 留空，由路由自行决定（如注册接口可凭一次性 enroll 令牌，或最终 401）。 */
export function buildAuthHook(db: DB, adminToken: string) {
  const authenticate = makeAuthenticator(db, adminToken);
  return async (req: FastifyRequest) => {
    if (!bearerToken(req)) {
      req.auth = undefined;
      return;
    }
    req.auth = authenticate(req);
  };
}

export function requireAdmin(req: FastifyRequest): AuthContext & { role: 'admin' } {
  const a = req.auth;
  if (!a) throw err.unauthorized();
  if (a.role !== 'admin') throw err.forbidden('该操作需要管理员令牌');
  return a as AuthContext & { role: 'admin' };
}

export function requireAny(req: FastifyRequest): AuthContext {
  if (!req.auth) throw err.unauthorized();
  return req.auth;
}

export function requireAgent(req: FastifyRequest): AgentRow {
  const a = req.auth;
  if (!a) throw err.unauthorized();
  if (a.role !== 'agent' || !a.agent) throw err.forbidden('该操作需要 Agent 令牌');
  return a.agent;
}

// ---------- 简易限流：每键固定 60s 窗口 ----------

interface Bucket {
  windowStart: number;
  count: number;
}
const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.windowStart >= 60_000) buckets.delete(k);
  }
}

export function rateLimit(key: string, limitPerMinute: number): void {
  const now = Date.now();
  sweep(now);
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= 60_000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return;
  }
  b.count += 1;
  if (b.count > limitPerMinute) {
    const retryAfter = Math.ceil((b.windowStart + 60_000 - now) / 1000);
    throw Object.assign(err.rateLimited(), { retryAfter });
  }
}

export function clientKey(req: FastifyRequest): string {
  return req.ip ?? 'unknown';
}
