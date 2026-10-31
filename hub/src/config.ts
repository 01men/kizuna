import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface HubConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  adminToken: string;
  /** 对外可达地址（安装提示词/脚本内嵌用） */
  publicUrl: string;
  /** kizuna-box 单文件源码路径（/install/box.js 下发用） */
  boxSourcePath: string;
  logLevel: string;
  /** 公开免登录安装（社区落地页用）：false 时 /install/self 关闭 */
  publicInstall: boolean;
  /** 允许跨域来源（逗号分隔；默认包含 GitHub Pages） */
  corsOrigins: string[];
  /** 公开端点（安装/演示）每 IP 每分钟限额；0 表示用设置页的值 */
  publicInstallQuota: number;
  /** 一次性注册令牌有效期（毫秒）。含装运行时与下载服务的耗时，默认 3 小时 */
  enrollTtlMs: number;
}

/** 默认令牌有效期 3 小时：覆盖 Homebrew 装 Node、下载 box.js 等前置步骤 */
export const DEFAULT_ENROLL_TTL_MS = 3 * 60 * 60 * 1000;

function resolveBoxSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.KIZUNA_BOX_FILE,
    path.resolve(here, '../../box/kizuna-box'),
    path.resolve(here, '../static/kizuna-box.js'),
    path.resolve(here, '../../static/kizuna-box.js'),
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // 都不存在时仍返回第一个候选，启动时再报错
  return candidates[candidates.length - 1] ?? 'box/kizuna-box';
}

function loadOrCreateAdminToken(dataDir: string): string {
  const fromEnv = process.env.KIZUNA_ADMIN_TOKEN;
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'admin-token.json');
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8')) as { admin_token?: string };
    if (prev.admin_token) return prev.admin_token;
  } catch {
    /* 首次启动 */
  }
  const token = 'kad_' + crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ admin_token: token, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  return token;
}

export function loadConfig(): HubConfig {
  const dataDir = process.env.KIZUNA_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    host: process.env.KIZUNA_HOST ?? '0.0.0.0',
    port: Number(process.env.KIZUNA_PORT ?? 7700),
    dataDir,
    dbPath: process.env.KIZUNA_DB_PATH ?? path.join(dataDir, 'kizuna.db'),
    adminToken: loadOrCreateAdminToken(dataDir),
    publicUrl: (process.env.KIZUNA_PUBLIC_URL ?? `http://127.0.0.1:${process.env.KIZUNA_PORT ?? 7700}`).replace(/\/+$/, ''),
    boxSourcePath: resolveBoxSource(),
    logLevel: process.env.KIZUNA_LOG_LEVEL ?? 'info',
    publicInstall: (process.env.KIZUNA_PUBLIC_INSTALL ?? 'true') !== 'false',
    corsOrigins: (process.env.KIZUNA_CORS_ORIGINS ??
      'https://01men.github.io,http://127.0.0.1:8099,http://localhost:8099')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicInstallQuota: Math.max(0, Number(process.env.KIZUNA_PUBLIC_INSTALL_QUOTA ?? 0)),
    enrollTtlMs: (() => {
      const sec = Number(process.env.KIZUNA_ENROLL_TTL_SECONDS);
      if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_ENROLL_TTL_MS;
      return Math.floor(sec) * 1000;
    })(),
  };
}
