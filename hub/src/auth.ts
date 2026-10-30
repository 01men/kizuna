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

// ---------- 简易限流：每键固定 60s 窗口（白名单豁免） ----------

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

export interface RateLimitOptions {
  /** 白名单命中时跳过限流（演示/公开安装等对外端点使用） */
  allowlist?: string[];
  /** 单次限额（默认 60 秒窗口） */
  limit: number;
  /** 超限时附加在异常上的信息（供路由返回提额入口） */
  onLimited?: () => unknown;
}

export function rateLimit(key: string, limitPerMinute: number, opts?: { allowlist?: string[]; peerIp?: string }): void {
  const now = Date.now();
  sweep(now);
  if (opts?.allowlist && opts.peerIp && isAllowlisted(opts.peerIp, opts.allowlist)) return;
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= 60_000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return;
  }
  b.count += 1;
  if (b.count > limitPerMinute) {
    const retryAfter = Math.ceil((b.windowStart + 60_000 - now) / 1000);
    throw Object.assign(err.rateLimited(), { retryAfter, resetInSeconds: retryAfter });
  }
}

export function clientKey(req: FastifyRequest): string {
  return normalizeIp(req.ip ?? 'unknown');
}

/** IPv4-mapped IPv6 → IPv4；去空白与端口 */
export function normalizeIp(raw: string): string {
  let ip = String(raw).trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) return bracket[1]!;
  // 纯 IPv4 带端口（少见）：1.2.3.4:5678
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (v4port) return v4port[1]!;
  return ip;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

function ipv6ToBytes(ip: string): number[] | null {
  // 支持 :: 压缩
  const zone = ip.split('%')[0]!;
  if (!zone.includes(':')) return null;
  const [head, tail] = zone.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - (headParts.length + tailParts.length);
  if (tail === undefined && headParts.length !== 8) return null;
  if (missing < 0) return null;
  const all = [...headParts, ...Array(tail === undefined ? 0 : missing).fill('0'), ...tailParts];
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const seg of all) {
    const v = parseInt(seg, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** 判断 IP 是否命中白名单（支持单地址与 CIDR） */
export function isAllowlisted(ip: string, allowlist: string[]): boolean {
  if (!allowlist.length) return false;
  const peer = normalizeIp(ip);
  for (const entryRaw of allowlist) {
    const entry = entryRaw.trim().toLowerCase();
    if (!entry) continue;
    const slash = entry.indexOf('/');
    const netAddr = slash >= 0 ? entry.slice(0, slash) : entry;
    const bits = slash >= 0 ? Number(entry.slice(slash + 1)) : null;

    const peerV4 = ipv4ToInt(peer);
    const netV4 = ipv4ToInt(netAddr);
    if (peerV4 !== null && netV4 !== null) {
      if (bits === null) {
        if (peerV4 === netV4) return true;
        continue;
      }
      if (bits === 0) return true;
      const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
      if ((peerV4 & mask) === (netV4 & mask)) return true;
      continue;
    }

    const peerV6 = ipv6ToBytes(peer);
    const netV6 = ipv6ToBytes(netAddr);
    if (peerV6 && netV6) {
      const b = bits === null ? 128 : bits;
      let matched = true;
      for (let i = 0; i < 16 && matched; i++) {
        const remaining = b - i * 8;
        if (remaining >= 8) {
          if (peerV6[i] !== netV6[i]) matched = false;
        } else if (remaining > 0) {
          const mask = (0xff << (8 - remaining)) & 0xff;
          if ((peerV6[i]! & mask) !== (netV6[i]! & mask)) matched = false;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}
