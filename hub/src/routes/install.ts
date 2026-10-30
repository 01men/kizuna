import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import type { RouteCtx } from '../ctx.js';
import { AppError, err } from '../errors.js';
import { requireAdmin, rateLimit, clientKey, isAllowlisted } from '../auth.js';
import { getSettings, type Settings } from '../settings.js';
import { newEnrollToken } from '../ids.js';
import { createAgent } from '../agentService.js';
import { renderPrompt, renderScript } from '../prompt.js';
import { enforcePublicQuota } from '../quota.js';

interface EnrollRow {
  token: string;
  agent_draft: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export const ENROLL_TTL_MS = 10 * 60 * 1000;

/** 校验一次性令牌（不消费）。view/prompt 等只读场景用 */
function peekToken(db: RouteCtx['db'], token: string): EnrollRow {
  const row = db.prepare('SELECT * FROM enroll_tokens WHERE token = ?').get(token) as EnrollRow | undefined;
  if (!row) throw err.unauthorized('注册令牌无效');
  if (row.used_at) throw err.tokenUsed();
  if (Date.parse(row.expires_at) < Date.now()) throw err.tokenExpired();
  return row;
}

export default async function installRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db, config } = ctx;

  // ---------- 签发一次性注册令牌（Admin） ----------
  fastify.post('/api/v1/enroll-tokens', async (req, reply) => {
    requireAdmin(req);
    rateLimit(`enroll_tokens:${req.ip}`, 60);
    const body = (req.body ?? {}) as {
      agent_id?: string;
      name?: string;
      capabilities?: string;
      capability_tags?: string[];
      webhook_url?: string;
    };
    if (body.agent_id && !/^[A-Za-z0-9_-]{1,64}$/.test(body.agent_id)) {
      throw err.validation('agent_id 含非法字符');
    }
    if (body.webhook_url && !/^https?:\/\/.+/.test(body.webhook_url)) {
      throw err.validation('webhook_url 必须是 http/https 地址');
    }
    const now = new Date();
    const token = newEnrollToken();
    const draft = JSON.stringify({
      agent_id: body.agent_id,
      name: body.name,
      capabilities: body.capabilities,
      capability_tags: body.capability_tags,
      webhook_url: body.webhook_url,
    });
    db.prepare('INSERT INTO enroll_tokens (token, agent_draft, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token,
      draft,
      now.toISOString(),
      new Date(now.getTime() + ENROLL_TTL_MS).toISOString(),
    );
    fastify.log.info({ enroll_issued: true }, 'enroll token issued');
    reply.code(201);
    return {
      token,
      expires_at: new Date(now.getTime() + ENROLL_TTL_MS).toISOString(),
      ttl_seconds: ENROLL_TTL_MS / 1000,
      install_prompt: renderPrompt(config.publicUrl, token),
    };
  });

  // ---------- 公开安装（社区落地页：免登录拿一句话提示词） ----------
  // 安全：每 IP 每小时限额、令牌仍是一次性 10 分钟、名称/能力裁剪长度；
  //      全局总开关 KIZUNA_PUBLIC_INSTALL=false 可随时关闭。
  fastify.post('/install/self', async (req, reply) => {
    if (!config.publicInstall) throw new AppError(403, 'PUBLIC_INSTALL_DISABLED', '本 Hub 未开放公开安装');
    const settings = getSettings(db);
    const peer = clientKey(req);
    enforcePublicQuota(fastify, settings.public_install_per_minute, settings.rate_limit_allowlist, peer, 'public_install');
    const body = (req.body ?? {}) as { name?: string; capabilities?: string };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
    const capabilities = typeof body.capabilities === 'string' ? body.capabilities.trim().slice(0, 300) : '';
    const now = new Date();
    const token = newEnrollToken();
    db.prepare('INSERT INTO enroll_tokens (token, agent_draft, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token,
      JSON.stringify({ name: name || '社区 Agent', capabilities, capability_tags: [] }),
      now.toISOString(),
      new Date(now.getTime() + ENROLL_TTL_MS).toISOString(),
    );
    fastify.log.info({ via: 'public-install', ip: clientKey(req) }, 'public enroll token issued');
    reply.code(201);
    return {
      token,
      expires_at: new Date(now.getTime() + ENROLL_TTL_MS).toISOString(),
      ttl_seconds: ENROLL_TTL_MS / 1000,
      hub_url: config.publicUrl,
      install_prompt: renderPrompt(config.publicUrl, token),
      quota: {
        limit_per_minute: settings.public_install_per_minute,
        allowlisted: isAllowlisted(peer, settings.rate_limit_allowlist),
        raise_quota: settings.quota_contact || null,
      },
      mcp: {
        name: 'kizuna',
        command: 'npx',
        // 无需 npm 账号：走 GitHub 源安装（仓库根的 package.json 提供 bin）
        args: ['-y', 'github:01men/kizuna'],
        env: { KIZUNA_HUB_URL: config.publicUrl, KIZUNA_AGENT_TOKEN: '<安装后自动写入 ~/.kizuna-box/config.json>' },
      },
    };
  });

  // ---------- 安装提示词（凭令牌查看，不消费） ----------
  fastify.get('/install/prompt', async (req, reply) => {
    const token = (req.query as { token?: string }).token;
    if (!token) throw err.validation('缺少 token 参数');
    rateLimit(`install:${clientKey(req)}`, 120);
    peekToken(db, token);
    reply.type('text/plain; charset=utf-8');
    return renderPrompt(config.publicUrl, token);
  });

  // ---------- 平台一键脚本（脚本内嵌 HUB + 令牌） ----------
  const SCRIPT_TYPES: Record<string, string> = {
    'linux.sh': 'text/x-shellscript; charset=utf-8',
    'macos.sh': 'text/x-shellscript; charset=utf-8',
    'termux.sh': 'text/x-shellscript; charset=utf-8',
    'windows.ps1': 'text/plain; charset=utf-8',
  };
  for (const name of Object.keys(SCRIPT_TYPES)) {
    fastify.get(`/install/${name}`, async (req, reply) => {
      const token = (req.query as { token?: string }).token;
      if (!token) throw err.validation('缺少 token 参数');
      rateLimit(`install:${clientKey(req)}`, 60);
      peekToken(db, token); // 脚本下载不消费令牌，真正的注册发生在 /api/v1/enroll
      const text = renderScript(name, config.publicUrl, token);
      if (text === null) throw err.internal('安装脚本未加载');
      reply.type(SCRIPT_TYPES[name]!);
      reply.header('cache-control', 'no-store');
      return text;
    });
  }

  // ---------- kizuna-box 单文件源码下发 ----------
  fastify.get('/install/box.js', async (_req, reply) => {
    if (!fs.existsSync(ctx.config.boxSourcePath)) {
      throw err.internal('kizuna-box 源码文件缺失（KIZUNA_BOX_FILE 或仓库 box/kizuna-box）');
    }
    reply.type('text/javascript; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return fs.createReadStream(ctx.config.boxSourcePath);
  });

  // ---------- 注册（安装脚本回调）：令牌换正式凭据，令牌即作废 ----------
  fastify.post('/api/v1/enroll', async (req, reply) => {
    rateLimit(`enroll:${clientKey(req)}`, 30);
    const body = (req.body ?? {}) as {
      token?: string;
      name?: string;
      capabilities?: string;
      capability_tags?: string[];
      webhook_url?: string;
      agent_card?: unknown;
    };
    if (!body.token) throw err.validation('缺少 token');
    if (!body.webhook_url || !/^https?:\/\/.+/.test(body.webhook_url)) {
      throw err.validation('webhook_url 必须是 http/https 地址');
    }
    const row = peekToken(db, body.token);
    const draft = JSON.parse(row.agent_draft) as {
      agent_id?: string;
      name?: string;
      capabilities?: string;
      capability_tags?: string[];
      webhook_url?: string;
      agent_card?: unknown;
    };
    // 消费令牌（先占位，防止并发双用）
    const marked = db
      .prepare('UPDATE enroll_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL')
      .run(new Date().toISOString(), body.token);
    if (marked.changes !== 1) throw err.tokenUsed();

    try {
      const result = createAgent(db, {
        agent_id: draft.agent_id,
        name: draft.name ?? body.name,
        capabilities: draft.capabilities ?? body.capabilities ?? '',
        capability_tags: draft.capability_tags ?? body.capability_tags ?? [],
        webhook_url: draft.webhook_url || body.webhook_url,
        agent_card: (draft.agent_card ?? body.agent_card ?? null) as Record<string, unknown> | null,
      });
      fastify.log.info({ agent_id: result.agent_id, via: 'enroll' }, 'agent enrolled');
      return {
        ok: true,
        agent_id: result.agent_id,
        agent_token: result.agent_token,
        endpoint_secret: result.endpoint_secret,
        webhook_url: result.webhook_url,
        hub_url: config.publicUrl,
        note: '凭据已下发端侧 config.json（600），不会再次展示',
      };
    } catch (e) {
      // 注册失败（如编号冲突）：回滚令牌占用，允许修复后重试
      db.prepare('UPDATE enroll_tokens SET used_at = NULL WHERE token = ?').run(body.token);
      throw e;
    }
  });
}
