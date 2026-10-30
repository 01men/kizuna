import type { DB } from './db.js';
import { err } from './errors.js';

export interface Settings {
  /** 重试梯度（秒，自上次失败起算）；长度 N → 最多 N+1 次尝试。默认 3/10/30/60/120 分钟 */
  retry_ladder_s: number[];
  /** 回执整体超时（秒），默认 10 */
  ack_timeout_s: number;
  /** 投递全局并发，默认 32 */
  delivery_concurrency: number;
  /** 每次重试随机抖动（±秒），默认 5 */
  jitter_s: number;
  /** 留痕保留期（天），默认 180 */
  audit_retention_days: number;
  /** 内容最小化：留痕只存摘要不存标题，默认 true */
  content_minimized: boolean;
  /** 心跳离线判定窗口（秒），默认 300 */
  heartbeat_window_s: number;
  /** 公开安装配额：每 IP 每分钟次数，默认 10 */
  public_install_per_minute: number;
  /** 演示沙箱配额：每 IP 每分钟次数，默认 10 */
  demo_per_minute: number;
  /** 白名单（IP 或 CIDR）：命中后不限流。用于社区机器人/官方巡检/自有固定出口 */
  rate_limit_allowlist: string[];
  /** 提额联系方式（超限时展示给访客） */
  quota_contact: string;
}

export const DEFAULT_SETTINGS: Settings = {
  retry_ladder_s: [180, 600, 1800, 3600, 7200],
  ack_timeout_s: 10,
  delivery_concurrency: 32,
  jitter_s: 5,
  audit_retention_days: 180,
  content_minimized: true,
  heartbeat_window_s: 300,
  public_install_per_minute: 10,
  demo_per_minute: 10,
  rate_limit_allowlist: [],
  quota_contact: 'https://github.com/01men/kizuna/issues/new?labels=quota&title=%5B%E6%8F%90%E9%A2%9D%5D+',
};

const KEY = 'settings_json';

export function getSettings(db: DB): Settings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function validateSettings(input: unknown): Settings {
  if (typeof input !== 'object' || input === null) throw err.validation('设置必须是 JSON 对象');
  const o = input as Record<string, unknown>;
  const s: Settings = { ...DEFAULT_SETTINGS };

  if (o.retry_ladder_s !== undefined) {
    if (!Array.isArray(o.retry_ladder_s) || o.retry_ladder_s.length === 0 || o.retry_ladder_s.length > 10 ||
        !o.retry_ladder_s.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 7 * 86400)) {
      throw err.validation('retry_ladder_s 必须是 1~604800 秒的整数数组（1~10 项）');
    }
    s.retry_ladder_s = o.retry_ladder_s as number[];
  }
for (const [k, lo, hi] of [
    ['ack_timeout_s', 1, 120],
    ['delivery_concurrency', 1, 256],
    ['jitter_s', 0, 300],
    ['audit_retention_days', 1, 3650],
    ['heartbeat_window_s', 30, 3600],
    ['public_install_per_minute', 1, 600],
    ['demo_per_minute', 1, 600],
  ] as const) {
    if (o[k] !== undefined) {
      const n = o[k];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) {
        throw err.validation(`${k} 必须是 ${lo}~${hi} 的数值`);
      }
      (s as unknown as Record<string, number>)[k] = n;
    }
  }
  if (o.content_minimized !== undefined) {
    if (typeof o.content_minimized !== 'boolean') throw err.validation('content_minimized 必须是布尔值');
    s.content_minimized = o.content_minimized;
  }
  if (o.rate_limit_allowlist !== undefined) {
    if (!Array.isArray(o.rate_limit_allowlist)) throw err.validation('rate_limit_allowlist 必须是字符串数组');
    const list = o.rate_limit_allowlist.map((v) => String(v).trim()).filter(Boolean);
    if (list.length > 200) throw err.validation('白名单最多 200 条');
    for (const entry of list) {
      if (!isValidAllowEntry(entry)) {
        throw err.validation(`白名单条目不合法: ${entry}（需为 IPv4/IPv6 地址或 CIDR，如 1.2.3.4、10.0.0.0/8、2001:db8::/32）`);
      }
    }
    s.rate_limit_allowlist = list;
  }
  if (o.quota_contact !== undefined) {
    const v = String(o.quota_contact).trim();
    if (v.length > 500) throw err.validation('quota_contact 过长（≤500）');
    s.quota_contact = v;
  }
  return s;
}

/** 白名单条目校验：IPv4 / IPv6 / 各自的 CIDR */
export function isValidAllowEntry(entry: string): boolean {
  const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(entry);
  if (!m) return false;
  const [, addr, bitsRaw] = m;
  const isV4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(addr!);
  const isV6 = !isV4 && addr!.includes(':') && /^[0-9a-fA-F:.]+$/.test(addr!);
  if (!isV4 && !isV6) return false;
  if (isV4 && addr!.split('.').some((p) => Number(p) > 255)) return false;
  if (bitsRaw !== undefined) {
    const bits = Number(bitsRaw);
    if (isV4 && bits > 32) return false;
    if (isV6 && bits > 128) return false;
  }
  return true;
}

export function saveSettings(db: DB, s: Settings, actor: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(KEY, JSON.stringify(s));
    db.prepare('INSERT INTO config_audit(at, actor, change) VALUES(?, ?, ?)').run(
      new Date().toISOString(),
      actor,
      JSON.stringify({ type: 'settings_update', settings: s }),
    );
  });
}
