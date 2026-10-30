#!/usr/bin/env node
/*
 * Kizuna 端到端测试：真实 hub + 真实 kizuna-box 全链路
 * 覆盖：签收闭环 / 先落盘后回执 / 幂等去重 / 验签失败 / 重试梯度→delivery_failed /
 *       invalid_target / cancelled / 停用目标 / 冲突 / 三级鉴权 / 心跳在线 / 限流 /
 *       enroll 一次性令牌 / 总览 / 留痕导出 / metrics / 管理台静态资源
 * 运行：node test/e2e.mjs   （需先 cd hub && npm run build）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HUB_DIR = path.join(ROOT, 'hub');
const HUB_PORT = 17700;
const BOX_PORT = 17888;
const HUB = `http://127.0.0.1:${HUB_PORT}`;
const ADMIN = 'e2e-admin-token';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等子进程退出；超时则强杀（防止 keep-alive 等原因挂起拖垮整个测试） */
async function waitChildExit(child, timeoutMs = 15000) {
  child.on('error', () => { /* spawn 失败也要让 race 结束 */ });
  await Promise.race([
    new Promise((r) => child.on('exit', r)),
    sleep(timeoutMs).then(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }),
  ]);
}
let passed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(p, { method = 'GET', token = ADMIN, body, box = false } = {}) {
  const base = box ? `http://127.0.0.1:${BOX_PORT}` : HUB;
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function waitFor(desc, fn, timeoutMs = 20000, everyMs = 250) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${desc}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kizuna-e2e-'));
  const hubData = path.join(tmp, 'hub');
  const boxHome = path.join(tmp, 'box');
  fs.mkdirSync(hubData); fs.mkdirSync(boxHome, { recursive: true });

  const hub = spawn(process.execPath, ['dist/index.js'], {
    cwd: HUB_DIR,
    env: {
      ...process.env,
      KIZUNA_DATA_DIR: hubData,
      KIZUNA_PORT: String(HUB_PORT),
      KIZUNA_ADMIN_TOKEN: ADMIN,
      KIZUNA_PUBLIC_URL: HUB,
      KIZUNA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let hubLog = '';
  hub.stdout.on('data', (d) => { hubLog += d; });
  hub.stderr.on('data', (d) => { hubLog += d; });

  // 端侧 box 配置（真实凭据稍后 enroll 后由 box 自行落盘）
  const boxCfgPath = path.join(boxHome, 'config.json');

  let boxProc, enrollRun, box;
  try {
    console.log('▶ 启动与基础');
    await waitFor('hub healthz', () => api('/healthz').then((r) => r.status === 200));
    ok('hub /healthz 200', true);

    // 管理台静态资源
    const adminHtml = await fetch(`${HUB}/admin`);
    ok('GET /admin 200 HTML', adminHtml.status === 200 && (await adminHtml.text()).includes('Kizuna'));
    const adminJs = await fetch(`${HUB}/admin/app.js`);
    ok('GET /admin/app.js 200', adminJs.status === 200);

    console.log('▶ 设置（测试用快速重试梯度）');
    const setRes = await api('/api/v1/settings', { method: 'PUT', body: { retry_ladder_s: [1, 1, 1], jitter_s: 0 } });
    ok('PUT /settings 200', setRes.status === 200, setRes.text);
    const badSet = await api('/api/v1/settings', { method: 'PUT', body: { retry_ladder_s: 'fast' } });
    ok('PUT /settings 非法梯度 → 422', badSet.status === 422 && badSet.json.error.code === 'VALIDATION_FAILED');

    console.log('▶ 注册（路由字典）');
    const ra = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-TARGET', name: '目标信箱', capabilities: '收信', capability_tags: ['收'], webhook_url: `http://127.0.0.1:${BOX_PORT}` } });
    ok('注册目标 A-TARGET 201', ra.status === 201 && /^A-/.test(ra.json.agent_id), ra.text);
    const targetCred = ra.json;
    const rb = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-SENDER', name: '发信 Agent', webhook_url: 'http://127.0.0.1:1' } });
    ok('注册发送方 A-SENDER 201', rb.status === 201, rb.text);
    const senderToken = rb.json.agent_token;
    const conflict = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-TARGET', name: '重复', webhook_url: 'http://x' } });
    ok('编号冲突 → 409 AGENT_CONFLICT', conflict.status === 409 && conflict.json.error.code === 'AGENT_CONFLICT');

    console.log('▶ 端侧 enroll（真实 kizuna-box）');
    // box 测试端口用 17888，避免与本机已有 7788 服务冲突
    fs.writeFileSync(boxCfgPath, JSON.stringify({ hub_url: HUB, listen: { host: '127.0.0.1', port: BOX_PORT } }), { mode: 0o600 });
    boxProc = spawn(process.execPath, [path.join(ROOT, 'box', 'kizuna-box'), 'enroll', '--config', boxCfgPath], {
      env: { ...process.env, KIZUNA_ENROLL_TOKEN: 'invalid-token', KIZUNA_WEBHOOK_URL: `http://127.0.0.1:${BOX_PORT}` },
      stdio: 'ignore',
    });
    await waitChildExit(boxProc);
    ok('box enroll 无效令牌失败（配置未写凭据）', !JSON.parse(fs.readFileSync(boxCfgPath, 'utf8')).agent_id);

    // 签发一次性令牌 → box enroll 真实注册
    const et = await api('/api/v1/enroll-tokens', { method: 'POST', body: { name: '目标信箱', agent_id: 'A-TARGET' } });
    // 注意：A-TARGET 已存在 → 改为注册新 agent A-BOXTEST
    const et2 = await api('/api/v1/enroll-tokens', { method: 'POST', body: { name: '测试信箱', agent_id: 'A-BOXTEST', capability_tags: ['e2e'] } });
    ok('签发 enroll 令牌 201', et2.status === 201 && et2.json.token.startsWith('et_'));
    ok('提示词内嵌 HUB 与令牌', et2.json.install_prompt.includes(HUB) && et2.json.install_prompt.includes(et2.json.token));
    const promptTxt = await fetch(`${HUB}/install/prompt?token=${et2.json.token}`);
    ok('GET /install/prompt 200', promptTxt.status === 200 && (await promptTxt.text()).includes('Kizuna Box'));
    const scriptTxt = await (await fetch(`${HUB}/install/linux.sh?token=${et2.json.token}`)).text();
    ok('GET /install/linux.sh 内嵌 HUB+TOKEN', scriptTxt.includes('__KIZUNA_HUB__') === false && scriptTxt.includes(HUB) && scriptTxt.includes(et2.json.token));

    enrollRun = spawn(process.execPath, [path.join(ROOT, 'box', 'kizuna-box'), 'enroll', '--config', boxCfgPath], {
      env: { ...process.env, KIZUNA_ENROLL_TOKEN: et2.json.token, KIZUNA_WEBHOOK_URL: `http://127.0.0.1:${BOX_PORT}` },
      stdio: 'ignore',
    });
    await waitChildExit(enrollRun);
    const boxCfg = JSON.parse(fs.readFileSync(boxCfgPath, 'utf8'));
    ok('enroll 写回凭据（agent_id/双 token）', boxCfg.agent_id === 'A-BOXTEST' && boxCfg.agent_token?.startsWith('at_') && boxCfg.endpoint_secret?.startsWith('es_'));
    ok('enroll 回填局域网 webhook', boxCfg.webhook_url?.startsWith('http://'), boxCfg.webhook_url);
    const enrollAgain = await api('/api/v1/enroll', { method: 'POST', body: { token: et2.json.token, webhook_url: 'http://127.0.0.1:9' } });
    ok('令牌二次使用 → 410 ENROLL_TOKEN_USED', enrollAgain.status === 410 && enrollAgain.json.error.code === 'ENROLL_TOKEN_USED');
    const promptUsed = await fetch(`${HUB}/install/prompt?token=${et2.json.token}`);
    ok('已用令牌查看提示词 → 410', promptUsed.status === 410);

    console.log('▶ 启动真实 kizuna-box');
    box = spawn(process.execPath, [path.join(ROOT, 'box', 'kizuna-box'), 'run', '--config', boxCfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let boxErr = '';
    box.stderr.on('data', (d) => { boxErr += d; });
    const hz = await waitFor('box healthz', () =>
      api('/healthz', { token: null, box: true }).then((r) => (r.status === 200 && r.json.ok === true ? r.json : null)));
    ok('box /healthz ok=true agent_id 非空', hz.agent_id === 'A-BOXTEST');
    const nonLocal = await fetch(`http://127.0.0.1:${BOX_PORT}/tasks/pending`, { localAddress: '127.0.0.2' }).catch((e) => ({ error: e }));
    // localAddress 绑定仍可能被视为 loopback；以 403/200 均可接受（实现按 remoteAddress 判定），仅记录
    void nonLocal;

    console.log('▶ 投递闭环（签收 + 先落盘后回执）');
    const t1 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-BOXTEST', content: { title: '第一封信', body: '请整理今日报销单', priority: 'high' } } });
    ok('提交任务 202 queued', t1.status === 202 && t1.json.status === 'queued', t1.text);
    const audit1 = await waitFor('audit delivered_confirmed', async () => {
      const r = await api('/api/v1/audit?outcome=delivered_confirmed&limit=10');
      return r.json.items.find((x) => x.task_id === t1.json.task_id);
    });
    ok('留痕 delivered_confirmed', audit1.attempt_count >= 1);
    ok('留痕含内容摘要且无标题（最小化）', audit1.content_digest?.length === 64 && !String(audit1.note ?? '').includes('第一封信'), audit1.note);

    const letterPath = path.join(boxHome, 'spool', `${t1.json.task_id}.json`);
    await waitFor('spool 落盘', () => fs.existsSync(letterPath));
    const letter = JSON.parse(fs.readFileSync(letterPath, 'utf8'));
    ok('信件含 content.title/body 与 from', letter.content?.body === '请整理今日报销单' && letter.from?.agent_id === 'A-SENDER');

    console.log('▶ 端侧本地 API（回环）');
    const pending = await api('/tasks/pending', { token: null, box: true });
    ok('GET /tasks/pending 列出 1 封', pending.json.total === 1);
    const one = await api(`/tasks/${t1.json.task_id}`, { token: null, box: true });
    ok('GET /tasks/{id} 读到同一封', one.json.task_id === t1.json.task_id);
    const done = await api(`/tasks/${t1.json.task_id}/complete`, { method: 'POST', token: null, box: true, body: {} });
    ok('POST complete 归档', done.status === 200);
    const pending2 = await api('/tasks/pending', { token: null, box: true });
    ok('complete 后 pending 归零', pending2.json.total === 0 && fs.existsSync(path.join(boxHome, 'spool', 'done', `${t1.json.task_id}.json`)));

    console.log('▶ 幂等去重与验签');
    const t2 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-BOXTEST', content: { body: '第二封' } } });
    await waitFor('第二封落盘', () => fs.existsSync(path.join(boxHome, 'spool', `${t2.json.task_id}.json`)));
    // 手工重放同一投递（模拟 Hub 重试窗口内重发）
    const raw = JSON.stringify({ task_id: t2.json.task_id, from: { agent_id: 'A-SENDER', name: '发信 Agent' }, content: { body: '第二封' }, meta: { attempt: 2 } });
    const ts = new Date().toISOString();
    const sig = 'sha256=' + crypto.createHmac('sha256', boxCfg.endpoint_secret).update(ts + '.' + raw).digest('hex');
    const dup = await fetch(`http://127.0.0.1:${BOX_PORT}/kizuna/deliver`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kizuna-task-id': t2.json.task_id, 'x-kizuna-timestamp': ts, 'x-kizuna-signature': sig, 'x-kizuna-attempt': '2' }, body: raw });
    const dupJson = await dup.json();
    ok('重复投递幂等返回 duplicate:true', dup.status === 200 && dupJson.duplicate === true);
    const pendCount = await api('/tasks/pending', { token: null, box: true });
    ok('重放不产生第二条信件', pendCount.json.total === 1);

    const badSig = await fetch(`http://127.0.0.1:${BOX_PORT}/kizuna/deliver`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kizuna-task-id': 'T-X', 'x-kizuna-timestamp': ts, 'x-kizuna-signature': 'sha256=' + '0'.repeat(64), 'x-kizuna-attempt': '1' }, body: raw });
    ok('错误签名 → 401', badSig.status === 401);
    const staleTs = new Date(Date.now() - 3600_000).toISOString();
    const staleSig = 'sha256=' + crypto.createHmac('sha256', boxCfg.endpoint_secret).update(staleTs + '.' + raw).digest('hex');
    const stale = await fetch(`http://127.0.0.1:${BOX_PORT}/kizuna/deliver`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kizuna-task-id': t2.json.task_id, 'x-kizuna-timestamp': staleTs, 'x-kizuna-signature': staleSig }, body: raw });
    ok('超时窗签名（重放）→ 401', stale.status === 401);

    console.log('▶ 重试梯度 → delivery_failed');
    const rc = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-DEAD', name: '死信箱', webhook_url: 'http://127.0.0.1:1' } });
    const t3 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-DEAD', content: { body: '投不出去' } } });
    ok('目标存在但不可达 → 202 照常入队', t3.status === 202);
    const audit3 = await waitFor('audit delivery_failed', async () => {
      const r = await api('/api/v1/audit?outcome=delivery_failed&limit=10');
      return r.json.items.find((x) => x.task_id === t3.json.task_id);
    }, 30000);
    ok('梯度 [1,1,1] → 共 4 次尝试', audit3.attempt_count === 4, `实际 ${audit3.attempt_count}`);
    ok('尝试历史快照完整', Array.isArray(audit3.attempts) && audit3.attempts.length === 4 && audit3.attempts[0].outcome === 'network_error');
    const goneTask = await api(`/api/v1/tasks/${t3.json.task_id}`);
    ok('终态任务已出队（留痕可查）', goneTask.json.finalized === true && goneTask.json.status === 'delivery_failed');

    console.log('▶ invalid_target（目标注销后不重试）');
    await api('/api/v1/settings', { method: 'PUT', body: { retry_ladder_s: [3600], jitter_s: 0 } });
    const rd = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-GONE', name: '将注销', webhook_url: 'http://127.0.0.1:1' } });
    void rd;
    const t4 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-GONE', content: { body: '目标要消失' } } });
    await waitFor('第一次尝试失败进入 wait_retry', async () => {
      const r = await api(`/api/v1/tasks/${t4.json.task_id}`);
      return r.json.attempt_count === 1;
    }, 15000);
    await api('/api/v1/agents/A-GONE', { method: 'DELETE' });
    await api(`/api/v1/tasks/${t4.json.task_id}/retry`, { method: 'POST', body: {} });
    const audit4 = await waitFor('audit invalid_target', async () => {
      const r = await api('/api/v1/audit?outcome=invalid_target&limit=5');
      return r.json.items.find((x) => x.task_id === t4.json.task_id);
    });
    ok('目标注销 → invalid_target 且 note 注明', String(audit4.note ?? '').includes('目标编号不存在'));

    console.log('▶ 人工取消 / 停用目标');
    const re = await api('/api/v1/agents', { method: 'POST', body: { agent_id: 'A-CXL', name: '将被取消', webhook_url: 'http://127.0.0.1:1' } });
    void re;
    const t5 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-CXL', content: { body: '取消我' } } });
    await api(`/api/v1/tasks/${t5.json.task_id}/cancel`, { method: 'POST', body: {} });
    const audit5 = await waitFor('audit cancelled', async () => {
      const r = await api('/api/v1/audit?outcome=cancelled&limit=5');
      return r.json.items.find((x) => x.task_id === t5.json.task_id);
    });
    ok('取消 → 留痕 cancelled', audit5.outcome === 'cancelled');

    const dis = await api('/api/v1/agents/A-TARGET', { method: 'PATCH', body: { enabled: false } });
    ok('PATCH 停用 Agent', dis.status === 200 && dis.json.enabled === false);
    const t6 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-TARGET', content: { body: 'x' } } });
    ok('停用目标 → 422 TARGET_DISABLED', t6.status === 422 && t6.json.error.code === 'TARGET_DISABLED');
    await api('/api/v1/agents/A-TARGET', { method: 'PATCH', body: { enabled: true } });

    const t7 = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-NOSUCH', content: { body: 'x' } } });
    ok('未知目标 → 404 AGENT_NOT_FOUND（不入队）', t7.status === 404 && t7.json.error.code === 'AGENT_NOT_FOUND');

    console.log('▶ 鉴权与限流');
    const noAuth = await api('/api/v1/tasks', { token: null });
    ok('无令牌 → 401', noAuth.status === 401);
    const badAuth = await api('/api/v1/tasks', { token: 'at_wrong' });
    ok('伪造令牌 → 401', badAuth.status === 401);
    const agentOnAdmin = await api('/api/v1/settings', { token: targetCred.agent_token });
    ok('Agent 令牌访问管理接口 → 403', agentOnAdmin.status === 403);
    const agentReads = await api('/api/v1/tasks?limit=5', { token: senderToken });
    ok('Agent 只见自己相关任务', agentReads.status === 200 && agentReads.json.items.every((t) => ['A-SENDER'].includes(t.from) || ['A-SENDER'].includes(t.to)));

    let limited = null;
    for (let i = 0; i < 35; i++) {
      const r = await api('/api/v1/heartbeat', { method: 'POST', token: senderToken, body: {} });
      if (r.status === 429) { limited = r; break; }
    }
    ok('心跳 31+ 次/分钟 → 429 RATE_LIMITED', limited?.status === 429);

    console.log('▶ 心跳在线状态');
    await api('/api/v1/heartbeat', { method: 'POST', token: targetCred.agent_token, body: {} });
    const list = await api('/api/v1/agents?status=online');
    ok('心跳后目标在线', list.json.items.some((a) => a.agent_id === 'A-TARGET'));

    console.log('▶ 汇总接口');
    const ov = await api('/api/v1/overview');
    ok('overview 计数合理', ov.status === 200 && ov.json.agents.total >= 3 && ov.json.today.delivered >= 1 && Array.isArray(ov.json.recent_audit));
    const exp = await fetch(`${HUB}/api/v1/audit/export?format=jsonl`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const expText = await exp.text();
    ok('留痕导出 JSONL ≥ 4 条', exp.status === 200 && expText.trim().split('\n').length >= 4);
    const csv = await fetch(`${HUB}/api/v1/audit/export?format=csv`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const csvText = await csv.text();
    ok('留痕导出 CSV 表头', csv.status === 200 && csvText.startsWith('log_id,task_id'));
    const met = await (await fetch(`${HUB}/metrics`)).text();
    ok('metrics 含 ack 计数', met.includes('kizuna_deliveries_total{outcome="ack"}'));

    console.log('▶ box 心跳循环（10s 间隔）');
    await waitFor('box 自动心跳上报', async () => {
      const r = await api('/api/v1/agents?status=online');
      return r.json.items.some((a) => a.agent_id === 'A-BOXTEST');
    }, 25000, 1000);
    ok('box 心跳使 A-BOXTEST 在线', true);

    console.log('▶ A2A 兼容 v0.1：content.format=json 透传 Message/Task');
    const a2aMessage = {
      role: 'agent',
      parts: [{ kind: 'text', text: '请预审 T25JH142 报关单', metadata: { source: 'a2a-demo' } }],
      messageId: 'msg-e2e-001',
      kind: 'message',
    };
    const ta = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-BOXTEST', content: { title: 'A2A 透传', body: a2aMessage, format: 'json' } } });
    ok('A2A Message 对象直接入队 202', ta.status === 202, ta.text);
    await waitFor('A2A 信件落盘', () => fs.existsSync(path.join(boxHome, 'spool', `${ta.json.task_id}.json`)));
    const a2aLetter = JSON.parse(fs.readFileSync(path.join(boxHome, 'spool', `${ta.json.task_id}.json`), 'utf8'));
    ok('A2A Message 原样到达端侧（messageId 一致）', a2aLetter.content?.body?.messageId === 'msg-e2e-001' && a2aLetter.content?.format === 'json');
    await waitFor('A2A 信件签收', async () => {
      const r = await api('/api/v1/audit?outcome=delivered_confirmed&limit=5');
      return r.json.items.find((x) => x.task_id === ta.json.task_id);
    });
    ok('A2A 透传信件正常签收', true);

    console.log('▶ A2A 兼容 v0.2：Agent Card 与 /.well-known/agent-card.json');
    const hubCard = await fetch(`${HUB}/.well-known/agent-card.json`);
    const hubCardJson = await hubCard.json();
    ok('Hub 自身卡片 200 且含 skills/kizuna 扩展', hubCard.status === 200 && Array.isArray(hubCardJson.skills) && hubCardJson.kizuna?.enqueue?.path === '/api/v1/tasks');
    const noCard = await fetch(`${HUB}/api/v1/agents/A-BOXTEST/agent-card.json`);
    ok('未发布卡片 → 404 AGENT_CARD_NOT_FOUND', noCard.status === 404);
    const setCard = await api('/api/v1/agents/A-BOXTEST', { method: 'PATCH', body: { agent_card: { name: '测试信箱', description: 'e2e 卡片', url: `http://127.0.0.1:${BOX_PORT}`, skills: [{ id: 'letterbox', name: '收信', tags: ['box'] }] } } });
    ok('PATCH 发布 agent_card', setCard.status === 200 && setCard.json.agent_card?.name === '测试信箱');
    const cardPub = await fetch(`${HUB}/api/v1/agents/A-BOXTEST/agent-card.json`);
    ok('公开卡片下发（无需鉴权）', cardPub.status === 200 && (await cardPub.json()).skills?.[0]?.id === 'letterbox');
    const cardWk = await fetch(`${HUB}/.well-known/agent-card.json?agent=A-BOXTEST`);
    ok('well-known?agent= 下发同一张卡', cardWk.status === 200 && (await cardWk.json()).name === '测试信箱');
    const badCard = await api('/api/v1/agents/A-BOXTEST', { method: 'PATCH', body: { agent_card: { description: '缺 name' } } });
    ok('卡片缺 name → 422', badCard.status === 422);
    const clearCard = await api('/api/v1/agents/A-BOXTEST', { method: 'PATCH', body: { agent_card: null } });
    ok('agent_card=null 撤卡', clearCard.status === 200 && clearCard.json.agent_card === null);
    const cardGone = await fetch(`${HUB}/api/v1/agents/A-BOXTEST/agent-card.json`);
    ok('撤卡后 404', cardGone.status === 404);
    await api('/api/v1/agents/A-BOXTEST', { method: 'PATCH', body: { agent_card: { name: '测试信箱' } } });

    console.log('▶ v1.1 结果回传：三分类 + 终态自动回执');
    const boxToken = boxCfg.agent_token;
    const notMine = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { method: 'POST', token: senderToken, body: { state: 'completed' } });
    ok('非接收方回传 → 403', notMine.status === 403);
    const bogus = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { method: 'POST', token: boxToken, body: { state: 'doing' } });
    ok('非法 state → 422', bogus.status === 422);
    const w1 = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { method: 'POST', token: boxToken, body: { state: 'working', message: '处理中 30%' } });
    ok('working（进行中）202 且不回执', w1.status === 202 && w1.json.category === 'in_progress' && w1.json.relayed === null, JSON.stringify(w1.json).slice(0, 160));
    const w2 = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { method: 'POST', token: boxToken, body: { state: 'input-required', message: '请补充发票号' } });
    ok('input-required（中断）202', w2.status === 202 && w2.json.category === 'interrupted');
    const fin = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { method: 'POST', token: boxToken, body: { state: 'completed', message: '已处理完毕', result: { summary: 'ok', items: 3 } } });
    ok('completed（终态）202 且自动生成回执任务', fin.status === 202 && fin.json.relayed?.to === 'A-SENDER', JSON.stringify(fin.json).slice(0, 200));
    const relayedTask = await api(`/api/v1/tasks/${fin.json.relayed.task_id}`, { token: ADMIN });
    ok('回执任务 reply_to 指向原任务、format=json、kind=kizuna.task-result',
      relayedTask.json.reply_to === t2.json.task_id && relayedTask.json.format === 'json' && relayedTask.json.content?.body?.kind === 'kizuna.task-result');
    const results = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { token: boxToken });
    ok('结果历史 3 条（三分类齐全）', results.json.items.length === 3 && results.json.items.map((x) => x.category).join(',') === 'in_progress,interrupted,terminal');
    const resultsSender = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { token: senderToken });
    ok('发起方也可读结果', resultsSender.status === 200);
    const resultsOutsider = await api(`/api/v1/tasks/${t2.json.task_id}/result`, { token: targetCred.agent_token });
    ok('无关方读结果 → 403', resultsOutsider.status === 403);
    const undeclared = await api('/api/v1/tasks/T-NOSUCH/result', { method: 'POST', token: boxToken, body: { state: 'completed' } });
    ok('未签收任务回传 → 422', undeclared.status === 422);
    const cxl = await api(`/api/v1/tasks/${fin.json.relayed.task_id}/cancel`, { method: 'POST', body: {} });
    ok('回执任务可取消（出队留痕）', cxl.status === 200);

    console.log('▶ box 结果回传转发（回环 API）');
    const tResult = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-BOXTEST', content: { body: '结果回传载体' } } });
    await waitFor('载体信件签收', async () => {
      const r = await api('/api/v1/audit?outcome=delivered_confirmed&limit=5');
      return r.json.items.find((x) => x.task_id === tResult.json.task_id);
    });
    const viaBox = await api(`/tasks/${tResult.json.task_id}/result`, { method: 'POST', token: null, box: true, body: { state: 'working', message: '经 box 转发' } });
    ok('box 回环 result 转发 202', viaBox.status === 202 && viaBox.json.state === 'working', JSON.stringify(viaBox.json ?? viaBox).slice(0, 160));

    console.log('▶ 校验失败样例');
    const badTask = await api('/api/v1/tasks', { method: 'POST', token: senderToken, body: { to: 'A-TARGET', content: {} } });
    ok('缺 content.body → 422 VALIDATION_FAILED', badTask.status === 422 && badTask.json.error.code === 'VALIDATION_FAILED');
  const nf = await api('/api/v1/agents/A-NOSUCH');
    ok('详情不存在 → 404', nf.status === 404);

    console.log('▶ 社区公开安装（免登录）+ CORS');
    const pub = await fetch(`${HUB}/install/self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '社区访客 Agent', capabilities: '公开安装验证' }),
    });
    const pubJson = await pub.json();
    ok('POST /install/self 免令牌 201', pub.status === 201 && pubJson.token?.startsWith('et_'), JSON.stringify(pubJson).slice(0, 150));
    ok('返回提示词与 MCP 配置', pubJson.install_prompt?.includes(pubJson.token) && pubJson.mcp?.command === 'npx');
    const pubEnroll = await fetch(`${HUB}/api/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pubJson.token, webhook_url: 'http://127.0.0.1:19999' }),
    });
    const pubEnrollJson = await pubEnroll.json();
    ok('公开令牌可完成 enroll 拿凭据', pubEnroll.status === 200 && Boolean(pubEnrollJson.agent_id) && pubEnrollJson.agent_token?.startsWith('at_'), JSON.stringify(pubEnrollJson).slice(0, 150));
    const pubAgent = await api(`/api/v1/agents/${encodeURIComponent(pubEnrollJson.agent_id)}`);
    ok('公开注册的 Agent 名称来自落地页输入', pubAgent.json.name === '社区访客 Agent' && pubAgent.json.capabilities === '公开安装验证');
    const pre = await fetch(`${HUB}/install/self`, { method: 'OPTIONS', headers: { origin: 'https://01men.github.io', 'access-control-request-method': 'POST' } });
    ok('CORS 预检（GitHub Pages 来源）204 + 允许头', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://01men.github.io', String(pre.status));
    const evil = await fetch(`${HUB}/install/self`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' } });
    ok('非白名单来源不下发 CORS 头', evil.headers.get('access-control-allow-origin') === null);
    let pubLimited = false;
    for (let i = 0; i < 24; i++) {
      const r = await fetch(`${HUB}/install/self`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (r.status === 429) { pubLimited = true; break; }
    }
    ok('公开安装限额触发 429', pubLimited);

    console.log('▶ MCP server（JSON-RPC over stdio，真实进程）');
    const mcpEnv = { ...process.env, KIZUNA_HUB_URL: HUB, KIZUNA_AGENT_TOKEN: senderToken, KIZUNA_BOX_URL: `http://127.0.0.1:${BOX_PORT}` };
    const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp', 'kizuna-mcp')], { env: mcpEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let mcpBuf = '';
    const mcpMsgs = [];
    let mcpResolve = null;
    mcp.stdout.on('data', (d) => {
      mcpBuf += d.toString();
      let idx;
      while ((idx = mcpBuf.indexOf('\n')) >= 0) {
        const line = mcpBuf.slice(0, idx).trim();
        mcpBuf = mcpBuf.slice(idx + 1);
        if (!line) continue;
        try { mcpMsgs.push(JSON.parse(line)); } catch { /* 跳过非 JSON 行 */ }
        mcpResolve?.();
      }
    });
    const rpc = async (method, params, id) => {
      const before = mcpMsgs.length;
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return Promise.race([
        new Promise((res) => { mcpResolve = () => { if (mcpMsgs.length > before) res(mcpMsgs[mcpMsgs.length - 1]); }; }),
        sleep(15000).then(() => null),
      ]);
    };
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }, 1);
    ok('MCP initialize 返回 serverInfo/能力', init?.result?.serverInfo?.name === 'kizuna' && Boolean(init.result.capabilities?.tools));
    const mcpToolList = await rpc('tools/list', {}, 2);
    const toolNames = (mcpToolList?.result?.tools ?? []).map((t) => t.name);
    ok('MCP tools/list 暴露 11 个工具', toolNames.length === 11 && toolNames.includes('kizuna_send_task') && toolNames.includes('kizuna_report_result'), toolNames.join(','));
    const who = await rpc('tools/call', { name: 'kizuna_whoami', arguments: {} }, 3);
    ok('MCP whoami 读到 hub/token', String(who?.result?.content?.[0]?.text ?? '').includes('has_agent_token": true'));
    const mcpList = await rpc('tools/call', { name: 'kizuna_list_agents', arguments: { q: '信箱' } }, 4);
    const mcpAgents = JSON.parse(mcpList?.result?.content?.[0]?.text ?? '[]');
    ok('MCP 检索通讯录命中 A-BOXTEST', Array.isArray(mcpAgents) && mcpAgents.some((a) => a.agent_id === 'A-BOXTEST'));
    const mcpSend = await rpc('tools/call', { name: 'kizuna_send_task', arguments: { to: 'A-BOXTEST', title: '经 MCP 投递', body: '来自 MCP 客户端的一封信' } }, 5);
    const sent = JSON.parse(mcpSend?.result?.content?.[0]?.text ?? '{}');
    ok('MCP 发任务成功返回 task_id', String(sent.task_id ?? '').startsWith('T-'), JSON.stringify(sent).slice(0, 150));
    // 等调度器投递完成（1s tick）再读信箱
    await waitFor('MCP 信件签收', async () => {
      const r = await api('/api/v1/audit?outcome=delivered_confirmed&limit=5');
      return r.json.items.find((x) => x.task_id === sent.task_id);
    });
    const mcpPending = await rpc('tools/call', { name: 'kizuna_list_my_letters', arguments: {} }, 6);
    const pendingLetters = JSON.parse(mcpPending?.result?.content?.[0]?.text ?? '{}');
    ok('MCP 读到本机信箱（含刚发出的信）', Array.isArray(pendingLetters.items) && pendingLetters.items.some((x) => x.task_id === sent.task_id), JSON.stringify(pendingLetters).slice(0, 160));
    const mcpCard = await rpc('tools/call', { name: 'kizuna_get_agent_card', arguments: {} }, 7);
    ok('MCP 取 Hub A2A 卡片', String(mcpCard?.result?.content?.[0]?.text ?? '').includes('Kizuna Hub'));
    const badTool = await rpc('tools/call', { name: 'kizuna_nope', arguments: {} }, 8);
    ok('未知工具返回 isError 而非崩溃', badTool?.result?.isError === true);
    mcp.kill('SIGKILL');

    box.kill('SIGTERM');
  } catch (e) {
    failures.push(`异常中断: ${e.message}\n${e.stack}`);
  } finally {
    hub.kill('SIGTERM');
    await sleep(1200);
    hub.kill('SIGKILL');
    try { boxProc?.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { enrollRun?.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { box?.kill('SIGKILL'); } catch { /* 已退出 */ }
  }

  console.log('\n========================================');
  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 ✅'}`);
  for (const f of failures) console.log('  ✗ ' + f.split('\n')[0]);
  if (failures.length) {
    console.log('\n--- hub 日志尾部 ---');
    console.log(hubLog.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

main();
