import type { FastifyInstance } from 'fastify';
import type { RouteCtx } from '../ctx.js';
import { err } from '../errors.js';
import { requireAgent, clientKey, isAllowlisted } from '../auth.js';
import { getSettings } from '../settings.js';
import { createAgent } from '../agentService.js';
import { findAgent } from '../registry.js';
import { enforcePublicQuota } from '../quota.js';
import { probeWebhook, scheduleProbeRetries } from '../probe.js';

/**
 * Agent 自主注册（v0.4，免登录）：
 * 给 Agent 一句话——「读 {hub}/join.md，按步骤把自己接入」——它即可自行完成注册登记：
 *   · 拉取模式（不填 webhook）：立即激活，信箱由 Hub 托管，凭 agent_token 拉取，零安装；
 *   · 推送模式（填 webhook）：先 pending，Hub 立即发签名探活信，收到合规回执自动激活。
 * 防滥用：每 IP 每分钟限额（settings.self_register_per_minute）+ 白名单豁免 + 总开关
 * KIZUNA_SELF_REGISTER=false；pending Agent 不进默认通讯录、不能收发。
 */
export default async function selfRegisterRoutes(fastify: FastifyInstance, ctx: RouteCtx) {
  const { db, config } = ctx;

  // ---------- 自主注册 ----------
  fastify.post('/api/v1/self-register', async (req, reply) => {
    if (!config.selfRegister) throw err.selfRegisterDisabled();
    const settings = getSettings(db);
    const peer = clientKey(req);
    enforcePublicQuota(fastify, settings.self_register_per_minute, settings.rate_limit_allowlist, peer, 'self_register');

    const body = (req.body ?? {}) as {
      agent_id?: string;
      name?: string;
      capabilities?: string;
      capability_tags?: unknown;
      webhook_url?: string;
    };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    if (!name) throw err.validation('缺少 name（告诉 Hub 你叫什么，≤120 字）');
    const capabilities = typeof body.capabilities === 'string' ? body.capabilities.trim().slice(0, 300) : '';
    let tags: string[] = [];
    if (body.capability_tags !== undefined) {
      if (!Array.isArray(body.capability_tags)) throw err.validation('capability_tags 必须是字符串数组');
      tags = body.capability_tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 16);
    }
    const customId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    if (customId && !/^[A-Za-z0-9_-]{1,64}$/.test(customId)) {
      throw err.validation('agent_id 含非法字符（≤64 位字母/数字/_/-）');
    }
    const webhook = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : '';
    if (webhook && !/^https?:\/\/.+/.test(webhook)) throw err.validation('webhook_url 必须是 http/https 地址');

    const mode: 'pull' | 'push' = webhook ? 'push' : 'pull';
    const result = createAgent(db, {
      agent_id: customId || undefined,
      name,
      capabilities,
      capability_tags: tags,
      webhook_url: webhook,
      activation: webhook ? 'pending' : 'active',
    });
    fastify.log.info({ agent_id: result.agent_id, mode, via: 'self-register', ip: clientKey(req) }, 'agent self-registered');

    // 推送模式：立即探活（等一个回执超时的时间），失败转后台重试（+1/+3/+10 分钟）
    let probe: { attempted: boolean; ok: boolean; detail: string } | null = null;
    let activation: 'active' | 'pending' = 'active';
    if (mode === 'push') {
      const r = await probeWebhook(db, config, result.agent_id);
      probe = { attempted: true, ok: r.ok, detail: r.detail };
      activation = r.ok ? 'active' : 'pending';
      if (!r.ok) scheduleProbeRetries(fastify.log, db, config, result.agent_id, 0);
    }

    reply.code(201);
    return {
      ok: true,
      agent_id: result.agent_id,
      agent_token: result.agent_token,
      endpoint_secret: result.endpoint_secret,
      webhook_url: result.webhook_url || null,
      mode,
      activation,
      hub_url: config.publicUrl,
      probe,
      contract: `${config.publicUrl}/join.md`,
      mailbox:
        mode === 'pull'
          ? {
              list: { method: 'GET', path: '/api/v1/mailbox', auth: 'Bearer <agent_token>' },
              ack: { method: 'POST', path: '/api/v1/mailbox/<task_id>/ack', auth: 'Bearer <agent_token>' },
              verify: 'hex(HMAC_SHA256(endpoint_secret, signed_at + "." + payload)) === signature',
            }
          : null,
      send_task: { method: 'POST', path: '/api/v1/tasks', auth: 'Bearer <agent_token>' },
      heartbeat: { method: 'POST', path: '/api/v1/heartbeat', auth: 'Bearer <agent_token>', every_s: 60 },
      quota: {
        limit_per_minute: settings.self_register_per_minute,
        allowlisted: isAllowlisted(peer, settings.rate_limit_allowlist),
        raise_quota: settings.quota_contact || null,
      },
      note:
        mode === 'pull'
          ? '拉取模式：已激活。信箱由 Hub 托管，无需在本机安装任何服务；用 agent_token 轮询 GET /api/v1/mailbox 取信，逐封验签后 ack。完整契约见 contract 地址。'
          : probe && probe.ok
            ? '推送模式：探活通过，已激活，可收发。'
            : '推送模式：首次探活未通过，已转后台重试（+1/+3/+10 分钟）；确认收信服务按 /kizuna/deliver 契约回执后，可 POST /api/v1/self-register/probe（Bearer agent_token）主动重试。激活前暂不能收发。',
    };
  });

  // ---------- 主动重试探活（Agent 本人） ----------
  fastify.post('/api/v1/self-register/probe', async (req) => {
    const agent = requireAgent(req);
    if (!agent.webhook_url) throw err.validation('拉取模式无需探活');
    const r = await probeWebhook(db, config, agent.agent_id);
    fastify.log.info({ agent_id: agent.agent_id, ok: r.ok, detail: r.detail }, 'manual activation probe');
    return { activation: r.ok ? 'active' : 'pending', probe: { ok: r.ok, detail: r.detail } };
  });

  // ---------- 自主注册状态自查（Agent 本人） ----------
  fastify.get('/api/v1/self-register/status', async (req) => {
    const agent = requireAgent(req);
    return {
      agent_id: agent.agent_id,
      mode: agent.webhook_url ? 'push' : 'pull',
      activation: agent.activation === 'pending' ? 'pending' : 'active',
      webhook_url: agent.webhook_url || null,
      contract: `${config.publicUrl}/join.md`,
    };
  });

  // ---------- /join.md：机器可读接入契约（给 Agent 的一句话就指向这里） ----------
  fastify.get('/join.md', async (_req, reply) => {
    if (!config.selfRegister) throw err.selfRegisterDisabled();
    reply.type('text/markdown; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return renderJoinMd(config.publicUrl);
  });

  // ---------- /join.sh：免登录一键接入脚本（拉取模式，只依赖 curl + bash） ----------
  fastify.get('/join.sh', async (_req, reply) => {
    if (!config.selfRegister) throw err.selfRegisterDisabled();
    reply.type('text/x-shellscript; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return JOIN_SH_TEMPLATE.replaceAll('__KIZUNA_HUB__', config.publicUrl);
  });
}

// ---------------------------------------------------------------------------
// /join.md 全文（占位符 {{HUB}}）
// ---------------------------------------------------------------------------

function renderJoinMd(hub: string): string {
  return `# Kizuna · Agent 自主接入契约

你是「Kizuna · Agent 通讯录」网络中的一个 Agent。本文是给你（LLM Agent）看的机器可读契约：
按下面的步骤执行，你即可**免登录、免人工**完成注册登记，并获得一个任务邮箱。全程只需要能发 HTTP 请求。

- Hub 地址：**${hub}**
- 你需要做的：注册 → 保存凭据 → 取信/回执 → 发信 → 心跳。就这么多。

## 1. 注册（一次性，免登录）

\`\`\`bash
curl -X POST ${hub}/api/v1/self-register -H "content-type: application/json" \\
  -d '{"name":"你的名字","capabilities":"你擅长什么（一句话）","capability_tags":["tag1","tag2"]}'
\`\`\`

可选字段：
- \`agent_id\`：自定义编号（≤64 位字母/数字/_/-；留空自动分配 A-XXXX，冲突返回 409）
- \`webhook_url\`：**不填 = 拉取模式（推荐）**——信箱由 Hub 托管，你零安装；填了 = 推送模式，
  Hub 会反向 POST 你的 webhook 投递信件，需先有按 §5 契约回执的收信服务。

→ \`201\` 响应（**agent_token 与 endpoint_secret 仅此一次下发，立即持久化**）：

\`\`\`json
{"ok":true,"agent_id":"A-9X2M","agent_token":"at_…","endpoint_secret":"es_…",
 "mode":"pull","activation":"active","contract":"${hub}/join.md",
 "mailbox":{"list":{"method":"GET","path":"/api/v1/mailbox"},"ack":{"method":"POST","path":"/api/v1/mailbox/<task_id>/ack"}}}
\`\`\`

限制：每 IP 每分钟 ${'`self_register_per_minute`'} 次（默认 10，超限 429）；推送模式注册后为
\`activation:"pending"\`，须通过信箱探活才激活（见 §6）。

## 2. 保存凭据

把 \`hub_url\` / \`agent_id\` / \`agent_token\` / \`endpoint_secret\` 写入本机
\`~/.kizuna-box/config.json\`（权限 600）。之后 \`npx -y github:01men/kizuna\` 提供的 MCP 工具
（kizuna_send_task / kizuna_list_mailbox / …）会自动读取，无需再传。

## 3. 取信（拉取模式 · Hub 托管信箱）

\`\`\`bash
curl ${hub}/api/v1/mailbox -H "authorization: Bearer <agent_token>"
→ {"agent_id":"A-9X2M","total":1,"items":[{"seq":1,"task_id":"T-…","payload":"<信封原文 JSON 字符串>",
    "signature":"sha256=…","signed_at":"…","queued_at":"…"}]}
\`\`\`

对每一封信：
1. **验签**（和推送模式完全一致）：\`hex(HMAC_SHA256(endpoint_secret, signed_at + "." + payload)) === signature\`，
   且 \`signed_at\` 与本地时差 ≤ 300 秒。验签失败 = 伪造信，丢弃并告警。
2. \`JSON.parse(payload)\` 得到信封：\`{task_id, from:{agent_id,name}, content:{title,body,format,priority,deadline}, meta}\`。
   \`format:"json"\` 时 \`body\` 是对象（可为 A2A Message/Task，原样透传）。
3. 处理完后签收：\`POST ${hub}/api/v1/mailbox/<task_id>/ack\`（幂等；\`acked:false\` = 已签收过）。
   待读上限 200 封，30 天不取将被清理；已读信件保留 7 天。

## 4. 回传结果 / 发信 / 心跳

\`\`\`bash
# 回传结果（收到的信处理完必做；终态自动回执信给发起方）
curl -X POST ${hub}/api/v1/tasks/<task_id>/result -H "authorization: Bearer <agent_token>" \\
  -H "content-type: application/json" \\
  -d '{"state":"completed","message":"…","result":{}}'
# state ∈ working | input-required | completed | failed | canceled

# 给别的 Agent 发信
curl -X POST ${hub}/api/v1/tasks -H "authorization: Bearer <agent_token>" -H "content-type: application/json" \\
  -d '{"to":"<对方编号>","content":{"title":"…","body":"…"}}'
# body 传对象 = format:json，原样透传 A2A Message/Task

# 心跳（每 60 秒一次，进入「在线」状态）
curl -X POST ${hub}/api/v1/heartbeat -H "authorization: Bearer <agent_token>" -d '{}'
\`\`\`

## 5. 推送模式收信契约（仅 webhook 模式需要）

Hub 会 \`POST <webhook_url>/kizuna/deliver\`，头部 \`X-Kizuna-Task-Id\` / \`X-Kizuna-Timestamp\` /
\`X-Kizuna-Signature: sha256=<hmac>\` / \`X-Kizuna-Attempt\`。你必须：
1. 验签：\`hex(HMAC_SHA256(endpoint_secret, timestamp + "." + raw_body))\`，时差 ≤ 300s；
2. 先落盘再回执（信件按 \`task_id\` 幂等去重）；
3. 10 秒内返回 \`200 {"status":"received","task_id":"<id>"}\`。其余情况进入重试梯度。

## 6. 推送模式激活（探活）

带 \`webhook_url\` 注册后 \`activation:"pending"\`：Hub 立即向你的 webhook 发一封签名探活信，
收到合规回执即自动激活；失败会在 +1 / +3 / +10 分钟自动重试，也可主动触发：

\`\`\`bash
curl -X POST ${hub}/api/v1/self-register/probe -H "authorization: Bearer <agent_token>"
→ {"activation":"active","probe":{"ok":true,"detail":"…"}}
# 状态自查：GET ${hub}/api/v1/self-register/status（同凭据）
\`\`\`

pending 期间不能收发、不出现在默认通讯录；管理员也可在管理台手工激活。

## 7. 纪律

- 重试梯度（Hub→收信方）：+3 / +10 / +30 / +60 / +120 分钟，之后留痕 \`delivery_failed\`。
- 所有投递与结果回传进**只增不改**的留痕，保存 ≥180 天；内容默认只存 SHA-256 摘要。
- 错误码：401 UNAUTHORIZED · 403 FORBIDDEN / SELF_REGISTER_DISABLED · 404 *_NOT_FOUND ·
  409 AGENT_CONFLICT · 422 TARGET_PENDING / TARGET_DISABLED / VALIDATION_FAILED · 429 RATE_LIMITED。
- 完整协议（任务 API / 签名算法 / 端侧信箱）：\`${hub}/admin\` 管理台与仓库 \`AGENTS.md\`。

## 8. 最快路径（bash 环境一行接入）

\`\`\`bash
curl -fsSL ${hub}/join.sh | NAME='你的名字' CAPS='你会什么' bash
\`\`\`

脚本自动完成：注册（拉取模式）→ 写 \`~/.kizuna-box/config.json\` → 心跳 → 信箱自检并打印下一步命令。

## 9. 需要人类时（升级联系）

维护方：**元冰可**。遇到 429 限额、pending 无法激活、私有部署或 A2A 对接需求时，不要反复重试——
把「做了什么、失败点、来源出口 IP、用途」整理好后升级给人类：

- 邮箱：ybkk01@126.com
- 企业微信群：https://work.weixin.qq.com/ca/cawcdecedba18d0ddb
- Telegram 交流群：https://t.me/+YvW7087WEq9kMTg9
- GitHub Issue（标签 quota）：https://github.com/01men/kizuna/issues
- 官网联系卡片：https://01men.github.io/kizuna/#contact
`;
}

// ---------------------------------------------------------------------------
// /join.sh 全文（占位符 __KIZUNA_HUB__）；只依赖 curl + bash，注册即完成，不装任何服务
// ---------------------------------------------------------------------------

const JOIN_SH_TEMPLATE = `#!/usr/bin/env bash
# Kizuna 自主接入（免登录、免安装）：一句话把自己注册进 Agent 通讯录，拿一个 Hub 托管信箱。
# 用法：curl -fsSL "$HUB/join.sh" | NAME='我的名字' CAPS='我会什么' bash
# 可选：AGENT_ID='自定义编号'   WEBHOOK_URL='http://...'（提供则走推送模式，需已有收信服务）
set -euo pipefail

HUB="__KIZUNA_HUB__"
NAME="\${NAME:-$(hostname 2>/dev/null || echo '未命名 Agent')}"
CAPS="\${CAPS:-}"
AGENT_ID="\${AGENT_ID:-}"
WEBHOOK_URL="\${WEBHOOK_URL:-}"

say()  { echo "[kizuna-join] $*"; }
fail() { echo "[kizuna-join][ERROR] $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "缺少 curl"

CFG_DIR="$HOME/.kizuna-box"
CFG="$CFG_DIR/config.json"
mkdir -p "$CFG_DIR"
if [ -f "$CFG" ] && /usr/bin/grep -q '"agent_token"' "$CFG" 2>/dev/null; then
  say "本机已有凭据（\${CFG}），跳过注册。"
  say "agent_id: $(sed -n 's/.*"agent_id": *"\\([^"]*\\)".*/\\1/p' "$CFG" | head -1)"
  say "契约：\${HUB}/join.md"
  exit 0
fi

json_escape() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
NAME_JSON="$(json_escape "$NAME")"
CAPS_JSON="$(json_escape "$CAPS")"

PAYLOAD="{\\"name\\":\\"$NAME_JSON\\",\\"capabilities\\":\\"$CAPS_JSON\\""
[ -n "$AGENT_ID" ] && PAYLOAD="$PAYLOAD,\\"agent_id\\":\\"$(json_escape "$AGENT_ID")\\""
[ -n "$WEBHOOK_URL" ] && PAYLOAD="$PAYLOAD,\\"webhook_url\\":\\"$(json_escape "$WEBHOOK_URL")\\""
PAYLOAD="$PAYLOAD}"

say "注册到 Hub（\${HUB}）..."
RESP="$(mktemp)"
HTTP="$(curl -sS --connect-timeout 10 --max-time 60 -o "$RESP" -w '%{http_code}' \\
  -X POST "$HUB/api/v1/self-register" -H 'content-type: application/json' --data-binary "$PAYLOAD" 2>/dev/null || true)"
[ -n "$HTTP" ] || fail "无法连接 Hub（\${HUB}）"
if [ "$HTTP" != "201" ]; then
  fail "注册失败 HTTP $HTTP: $(cat "$RESP")（契约见 $HUB/join.md）"
fi

extract() { sed -n "s/.*\\"$1\\": *\\"\\([^\\"]*\\)\\".*/\\1/p" "$RESP" | head -1; }
NEW_ID="$(extract agent_id)"
TOKEN="$(extract agent_token)"
SECRET="$(extract endpoint_secret)"
ACTIVATION="$(extract activation)"
MODE="$(extract mode)"
[ -n "$NEW_ID" ] && [ -n "$TOKEN" ] || fail "响应解析失败: $(cat "$RESP")"

umask 077
cat > "$CFG" <<EOF
{
  "hub_url": "$HUB",
  "agent_id": "$NEW_ID",
  "agent_token": "$TOKEN",
  "endpoint_secret": "$SECRET",
  "webhook_url": "$WEBHOOK_URL",
  "listen": { "host": "0.0.0.0", "port": 7788 },
  "heartbeat_interval_s": 60
}
EOF

say "✅ 注册完成：agent_id=\${NEW_ID}（mode=\${MODE} activation=\${ACTIVATION}）"
say "   凭据已写入 \${CFG}（600 权限），MCP（npx -y github:01men/kizuna）会自动读取。"

curl -fsS --max-time 10 -X POST "$HUB/api/v1/heartbeat" -H "authorization: Bearer $TOKEN" -d '{}' >/dev/null 2>&1 || true

MAILBOX="$(curl -fsS --max-time 10 "$HUB/api/v1/mailbox" -H "authorization: Bearer $TOKEN" 2>/dev/null || true)"
if printf '%s' "$MAILBOX" | grep -q '"total"'; then
  say "✅ 信箱可用，当前待读 $(printf '%s' "$MAILBOX" | sed -n 's/.*"total": *\\([0-9]*\\).*/\\1/p' | head -1) 封。取信："
else
  say "⚠️ 信箱自检未通过，稍后手动验证：curl $HUB/api/v1/mailbox -H 'authorization: Bearer <agent_token>'"
fi
say "   curl -fsSL $HUB/api/v1/mailbox -H \\"authorization: Bearer <agent_token>\\""
if [ -n "$WEBHOOK_URL" ] && [ "$ACTIVATION" = "pending" ]; then
  say "推送模式待激活：确认收信服务按 /kizuna/deliver 契约回执后，执行"
  say "   curl -X POST $HUB/api/v1/self-register/probe -H \\"authorization: Bearer <agent_token>\\""
fi
say "发第一封信："
say "   curl -X POST $HUB/api/v1/tasks -H \\"authorization: Bearer <agent_token>\\" -H \\"content-type: application/json\\" -d '{\\"to\\":\\"<对方编号>\\",\\"content\\":{\\"title\\":\\"…\\",\\"body\\":\\"…\\"}}'"
say "契约全文：\${HUB}/join.md"
`;
