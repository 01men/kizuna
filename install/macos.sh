#!/usr/bin/env bash
# Kizuna Box — macOS 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：安装运行时（如缺失，Homebrew）→ 下载服务 → 注册 → LaunchAgent（登录自启 + 崩溃拉起）→ 自检
# 升级：重跑本脚本即同路径覆盖 bin，保留 spool 与 config。
set -euo pipefail

HUB="__KIZUNA_HUB__"
TOKEN="__KIZUNA_TOKEN__"

ROOT="$HOME/.kizuna-box"
CONFIG="$ROOT/config.json"
PLIST_LABEL=app.kizuna.kizuna-box
PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

say()  { echo "[kizuna-box] $*"; }
fail() { echo "[kizuna-box][ERROR] $*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(uname -s)" = "Darwin" ] || fail "本脚本仅支持 macOS（Linux 请用 linux.sh）"
command -v curl >/dev/null 2>&1 || fail "缺少 curl"

# ---------- 1. 运行时：Node.js ≥ 18 ----------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""
for c in node /usr/local/bin/node /opt/homebrew/bin/node; do
  if command -v "$c" >/dev/null 2>&1 && [ "$(node_major "$c")" -ge 18 ]; then NODE_BIN="$(command -v "$c")"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  say "安装 Node.js（Homebrew）..."
  if ! command -v brew >/dev/null 2>&1; then
    fail "未找到 Node.js 且未安装 Homebrew。请先安装其一：
  Node.js 官方 pkg:  https://nodejs.org/  或  brew install node"
  fi
  brew install node >/dev/null
  NODE_BIN="$(command -v node)"
fi
say "Node.js 就绪: $($NODE_BIN --version) ($NODE_BIN)"

# ---------- 2. 下载服务 ----------
mkdir -p "$ROOT/bin" "$ROOT/logs"
curl -fsSL "$HUB/install/box.js" -o "$ROOT/bin/kizuna-box"
chmod 0755 "$ROOT/bin/kizuna-box"
say "服务已下载: $ROOT/bin/kizuna-box"

# ---------- 3. 注册（升级模式跳过） ----------
UPGRADE=0
if [ -f "$CONFIG" ] && "$NODE_BIN" -e 'const c=require(process.argv[1]);process.exit(c.agent_id&&c.agent_token&&c.endpoint_secret?0:1)' "$CONFIG" 2>/dev/null; then
  UPGRADE=1
  say "检测到已有配置，升级模式：保留 config 与 spool"
else
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "${LAN_IP:-}" ]; then
    IFACE="$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/ {print $2; exit}')"
    [ -n "${IFACE:-}" ] && LAN_IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
  fi
  [ -n "${LAN_IP:-}" ] || LAN_IP="127.0.0.1"
  WEBHOOK="http://${LAN_IP}:7788"
  say "注册到 Hub（webhook=$WEBHOOK）..."
  "$NODE_BIN" - "$HUB" "$TOKEN" "$WEBHOOK" "$CONFIG" <<'ENROLL'
const [hub, token, webhook, cfgPath] = process.argv.slice(2);
(async () => {
  const res = await fetch(`${hub}/api/v1/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, webhook_url: webhook }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    console.error(`[kizuna-box][ERROR] 注册失败 HTTP ${res.status}: ${JSON.stringify(body)}`);
    process.exit(1);
  }
  const fs = require('node:fs');
  const cfg = {
    hub_url: hub,
    agent_id: body.agent_id,
    agent_token: body.agent_token,
    endpoint_secret: body.endpoint_secret,
    webhook_url: body.webhook_url || webhook,
    listen: { host: '0.0.0.0', port: 7788 },
    heartbeat_interval_s: 60,
  };
  fs.mkdirSync(require('node:path').dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  console.log(`[kizuna-box] 注册成功: agent_id=${body.agent_id}`);
})().catch((e) => { console.error('[kizuna-box][ERROR] 注册异常:', e.message); process.exit(1); });
ENROLL
fi

# ---------- 4. LaunchAgent（RunAtLoad + KeepAlive = 登录自启、崩溃拉起） ----------
mkdir -p "$HOME/Library/LaunchAgents"
# 若已有旧实例先卸载
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1 || launchctl remove "$PLIST_LABEL" >/dev/null 2>&1 || true
cat > "$PLIST" <<PLIST_XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/bin/kizuna-box</string>
    <string>run</string>
    <string>--config</string>
    <string>${CONFIG}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${ROOT}/logs/out.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/logs/err.log</string>
</dict>
</plist>
PLIST_XML
chmod 0644 "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
say "LaunchAgent 已安装: $PLIST（RunAtLoad + KeepAlive）"

# ---------- 5. 自检 ----------
sleep 2
echo
say "===== 自检报告 ====="
HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:7788/healthz 2>/dev/null || true)"
[ -n "$HEALTH" ] && say "① healthz ......... OK  $HEALTH" || say "① healthz ......... FAIL（查看: $ROOT/logs/err.log）"
STATE="$(launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null | awk '/state =/ {print $3; exit}')"
[ -n "$STATE" ] && say "② 服务状态 ........ OK  ($PLIST_LABEL: $STATE)" || say "② 服务状态 ........ UNKNOWN"
HUB_OK="$(curl -fsS --max-time 5 "$HUB/healthz" 2>/dev/null || true)"
[ -n "$HUB_OK" ] && say "③ Hub 连通 ........ OK" || say "③ Hub 连通 ........ FAIL（Hub 不可达: $HUB）"
echo
if [ -n "$HEALTH" ] && [ -n "$HUB_OK" ]; then
  say "✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）"
else
  say "⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。"
  exit 1
fi
