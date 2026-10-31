import Fastify from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { bindRegistryDb } from './registry.js';
import { buildAuthHook, clientKey, rateLimit } from './auth.js';
import { AppError, err } from './errors.js';
import { Dispatcher } from './dispatcher.js';
import { loadScriptTemplates } from './prompt.js';
import agentsRoutes from './routes/agents.js';
import tasksRoutes from './routes/tasks.js';
import installRoutes from './routes/install.js';
import adminRoutes from './routes/admin.js';
import demoRoutes from './routes/demo.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // 安装脚本模板（hub 仓库根 install/ 目录；找不到直接快速失败）
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  loadScriptTemplates([pkgRoot, path.resolve(pkgRoot, '..'), process.cwd()]);

  const db = openDb(config);
  bindRegistryDb(db);

  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: undefined,
    },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });

  // ---- 统一错误规范：{"error":{"code","message","details"}} ----
  fastify.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      const headers = (error as AppError & { retryAfter?: number }).retryAfter
        ? { 'retry-after': String((error as AppError & { retryAfter?: number }).retryAfter) }
        : undefined;
      if (error.status >= 500) {
        req.log.error({ err: error }, error.message);
      } else {
        req.log.info({ code: error.code, path: req.url }, error.message);
      }
      reply.code(error.status).headers(headers ?? {}).send({
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
      return;
    }
    // Fastify schema 校验错误 → 422 VALIDATION_FAILED
    const validation = (error as { validation?: unknown }).validation;
    if (validation) {
      reply.code(422).send({
        error: { code: 'VALIDATION_FAILED', message: '请求字段校验失败', details: validation },
      });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.code(429).send({ error: { code: 'RATE_LIMITED', message: '请求过于频繁' } });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大（上限 1MB）' } });
      return;
    }
    req.log.error({ err: error }, 'internal error');
    reply.code(500).send({ error: { code: 'INTERNAL', message: '服务内部错误（可安全重试）' } });
  });

  fastify.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `路径不存在: ${req.method} ${req.url}` } });
  });

  // ---- 全局限流兜底（细粒度限流在各路由内） ----
  fastify.addHook('onRequest', async (req, _reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/install/')) {
      rateLimit(`ip:${clientKey(req)}:${req.method}`, 600);
    }
  });

  // ---- CORS（社区落地页在 GitHub Pages，需跨域拿安装提示词；白名单制） ----
  fastify.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'authorization,content-type');
      reply.header('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      return reply;
    }
    return undefined;
  });

  // ---- 三级鉴权解出（不强制，路由内决定角色） ----
  fastify.addHook('preHandler', buildAuthHook(db, config.adminToken));

  // ---- 探活（安装脚本 hub 连通性检查用；enroll_ttl_seconds 供落地页/管理台渲染令牌有效期文案） ----
  fastify.get('/healthz', async () => ({
    ok: true,
    service: 'kizuna-hub',
    time: new Date().toISOString(),
    enroll_ttl_seconds: Math.round(config.enrollTtlMs / 1000),
  }));

  // ---- 根路径：引导到管理台 ----
  fastify.get('/', async (_req, reply) => {
    reply.redirect('/admin');
  });

  await fastify.register(agentsRoutes, { db, config });
  await fastify.register(tasksRoutes, { db, config });
  await fastify.register(installRoutes, { db, config });
  await fastify.register(adminRoutes, { db, config });
  await fastify.register(demoRoutes, { db, config });

  // ---- Web 管理台（/admin 静态托管，与 API 同源） ----
  const adminDir = path.join(pkgRoot, 'public', 'admin');
  fastify.get('/admin', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return fs.createReadStream(path.join(adminDir, 'index.html'));
  });
  fastify.get('/admin/*', async (req, reply) => {
    const rel = (req.params as { '*': string })['*'];
    const file = path.normalize(path.join(adminDir, rel));
    if (!file.startsWith(adminDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new AppError(404, 'NOT_FOUND', `静态文件不存在: ${rel}`);
    }
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    reply.type(types[path.extname(file)] ?? 'application/octet-stream');
    return fs.createReadStream(file);
  });

  // ---- 投递调度器 ----
  const dispatcher = new Dispatcher(db, config, {
    info: (o, m) => fastify.log.info(o, m),
    warn: (o, m) => fastify.log.warn(o, m),
    error: (o, m) => fastify.log.error(o, m),
  });
  dispatcher.start();

  const shutdown = async (signal: string) => {
    fastify.log.info({ signal }, 'shutting down');
    dispatcher.stop();
    // 兜底：keep-alive 连接可能令 close() 挂起，3s 后强制退出
    setTimeout(() => process.exit(0), 3000).unref();
    try {
      await fastify.close();
    } catch { /* 已超时兜底 */ }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await fastify.listen({ host: config.host, port: config.port });
  fastify.log.info(
    { port: config.port, data_dir: config.dataDir, public_url: config.publicUrl },
    `Kizuna Hub 就绪 · 管理台 ${config.publicUrl}/admin`,
  );
  if (!process.env.KIZUNA_ADMIN_TOKEN) {
    fastify.log.warn('未设置 KIZUNA_ADMIN_TOKEN：已自动生成并写入 data/admin-token.json（600 权限）');
  }
}

main().catch((e) => {
  console.error('[kizuna-hub] 启动失败:', e);
  process.exit(1);
});
