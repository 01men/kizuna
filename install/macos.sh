#!/usr/bin/env bash
# Kizuna Box — macOS 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：注册（先用令牌换正式凭据并落盘）→ 安装运行时（如缺失，Homebrew）→ 下载服务
#       → 写入 config → LaunchAgent（登录自启 + 崩溃拉起）→ 自检
# 注册排在最前：令牌是一次性资源，后面的装运行时/下载再慢也不会把它拖过期。
# 升级/续装：重跑本脚本即同路径覆盖 bin，保留 spool 与 config；已注册则跳过注册。
set -euo pipefail

HUB="__KIZUNA_HUB__"
TOKEN="__KIZUNA_TOKEN__"

ROOT="$HOME/.kizuna-box"
CONFIG="$ROOT/config.json"
ENROLL_JSON="$ROOT/enroll.json"
PLIST_LABEL=app.kizuna.kizuna-box
PLIST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

say()  { echo "[kizuna-box] $*"; }
fail() { echo "[kizuna-box][ERROR] $*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(uname -s)" = "Darwin" ] || fail "本脚本仅支持 macOS（Linux 请用 linux.sh）"
command -v curl >/dev/null 2>&1 || fail "缺少 curl"

mkdir -p "$ROOT/bin" "$ROOT/logs"

# ---------- 1. 注册（curl 直连，不依赖 Node；已注册则跳过） ----------
HAVE_CONFIG=0
if [ -f "$CONFIG" ] && /usr/bin/grep -q '"agent_token"' "$CONFIG" 2>/dev/null; then
  HAVE_CONFIG=1
fi
if [ "$HAVE_CONFIG" = "1" ]; then
  say "检测到已有配置：跳过注册，保留 config 与 spool"
elif [ -s "$ENROLL_JSON" ]; then
  say "检测到上次注册凭据：跳过注册，继续安装"
else
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "${LAN_IP:-}" ]; then
    IFACE="$(route -n get 1.1.1.1 2>/dev/null | awk '/interface:/ {print $2; exit}')"
    [ -n "${IFACE:-}" ] && LAN_IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
  fi
  [ -n "${LAN_IP:-}" ] || LAN_IP="127.0.0.1"
  WEBHOOK="http://${LAN_IP}:7788"
  PAYLOAD="$(printf '{"token":"%s","webhook_url":"%s"}' "$TOKEN" "$WEBHOOK")"
  say "注册到 Hub（webhook=${WEBHOOK}）..."
  HTTP=""
  BODY=""
  for attempt in 1 2 3; do
    # 只对「连不上」重试：一旦拿到 HTTP 响应就停，避免重复消费令牌
    HTTP="$(curl -sS --connect-timeout 10 --max-time 60 -o "$ENROLL_JSON.tmp" -w '%{http_code}' \
      -X POST "$HUB/api/v1/enroll" -H 'content-type: application/json' \
      --data-binary "$PAYLOAD" 2>/dev/null || true)"
    if [ -n "$HTTP" ] && [ "$HTTP" != "000" ]; then break; fi
    HTTP=""
    say "注册请求连接失败（第 $attempt/3 次），$((attempt * 3))s 后重试..."
    sleep $((attempt * 3))
  done
  BODY="$(cat "$ENROLL_JSON.tmp" 2>/dev/null || true)"
  if [ -z "$HTTP" ]; then
    rm -f "$ENROLL_JSON.tmp"
    fail "无法连接 Hub（${HUB}）。请检查网络/代理后重跑本脚本；令牌在有效期内仍可用。"
  fi
  if [ "$HTTP" != "200" ]; then
    rm -f "$ENROLL_JSON.tmp"
    case "$BODY" in
      *ENROLL_TOKEN_EXPIRED*)
        fail "注册令牌已过期（HTTP 410）。请在管理台重新生成安装提示词，用新提示词重跑；本机已有部分安装文件，重跑会复用。"
        ;;
      *ENROLL_TOKEN_USED*)
        fail "注册令牌已被使用（HTTP 410）。若本机已装好，直接重跑即可；否则请重新生成安装提示词。"
        ;;
      *)
        fail "注册失败 HTTP $HTTP: $BODY"
        ;;
    esac
  fi
  mv "$ENROLL_JSON.tmp" "$ENROLL_JSON"
  chmod 600 "$ENROLL_JSON"
  say "注册成功：凭据已暂存（完成后写入 config.json）"
fi

# ---------- 2. 运行时：Node.js ≥ 18 ----------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE_BIN=""
for c in node /usr/local/bin/node /opt/homebrew/bin/node; do
  if command -v "$c" >/dev/null 2>&1 && [ "$(node_major "$c")" -ge 18 ]; then NODE_BIN="$(command -v "$c")"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  say "安装 Node.js（Homebrew）..."
  if ! command -v brew >/dev/null 2>&1; then
    fail "未找到 Node.js 且未安装 Homebrew。请先安装其一：
  Node.js 官方 pkg:  https://nodejs.org/  或  brew install node
  装好后重跑本脚本即可（注册已完成，不会重复消耗令牌）"
  fi
  brew install node >/dev/null
  NODE_BIN="$(command -v node)"
fi
say "Node.js 就绪: $($NODE_BIN --version) ($NODE_BIN)"

# ---------- 3. 下载服务（失败重试；停滞 20s 自动断开重下） ----------
BOX="$ROOT/bin/kizuna-box"
download_box() {
  for attempt in 1 2 3 4 5; do
    if curl -fsSL --connect-timeout 10 --max-time 300 \
        --speed-limit 512 --speed-time 20 \
        "$HUB/install/box.js" -o "$BOX.tmp"; then
      mv "$BOX.tmp" "$BOX"
      return 0
    fi
    rm -f "$BOX.tmp"
    say "下载服务失败（第 $attempt/5 次），$((attempt * 3))s 后重试..."
    sleep $((attempt * 3))
  done
  return 1
}
download_box || fail "服务下载失败（Hub: ${HUB}）。网络恢复后重跑本脚本即可续装，凭据已保存不会重复消耗令牌。"
chmod 0755 "$BOX"
say "服务已下载: $BOX"

# ---------- 4. 写入端侧配置 ----------
if [ "$HAVE_CONFIG" = "1" ]; then
  say "升级模式：保留现有 config"
else
  [ -s "$ENROLL_JSON" ] || fail "缺少注册凭据（${ENROLL_JSON}），请重新生成安装提示词后重跑"
  "$NODE_BIN" - "$HUB" "$ENROLL_JSON" "$CONFIG" <<'WRITECFG'
const fs = require('node:fs');
const path = require('node:path');
const [hub, enrollPath, cfgPath] = process.argv.slice(2);
const body = JSON.parse(fs.readFileSync(enrollPath, 'utf8'));
const cfg = {
  hub_url: hub,
  agent_id: body.agent_id,
  agent_token: body.agent_token,
  endpoint_secret: body.endpoint_secret,
  webhook_url: body.webhook_url,
  listen: { host: '0.0.0.0', port: 7788 },
  heartbeat_interval_s: 60,
};
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
console.log(`[kizuna-box] 凭据已写入 ${cfgPath} (agent_id=${cfg.agent_id})`);
WRITECFG
  chmod 600 "$CONFIG" 2>/dev/null || true
  rm -f "$ENROLL_JSON"
fi

# ---------- 5. LaunchAgent（RunAtLoad + KeepAlive = 登录自启、崩溃拉起） ----------
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
say "LaunchAgent 已安装: ${PLIST}（RunAtLoad + KeepAlive）"

# ---------- 6. 自检 ----------
sleep 2
echo
say "===== 自检报告 ====="
HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:7788/healthz 2>/dev/null || true)"
[ -n "$HEALTH" ] && say "① healthz ......... OK  $HEALTH" || say "① healthz ......... FAIL（查看: $ROOT/logs/err.log）"
STATE="$(launchctl print "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null | awk '/state =/ {print $3; exit}')"
[ -n "$STATE" ] && say "② 服务状态 ........ OK  ($PLIST_LABEL: $STATE)" || say "② 服务状态 ........ UNKNOWN"
HUB_OK="$(curl -fsS --max-time 5 "$HUB/healthz" 2>/dev/null || true)"
[ -n "$HUB_OK" ] && say "③ Hub 连通 ........ OK" || say "③ Hub 连通 ........ FAIL（Hub 不可达: ${HUB}）"
echo
if [ -n "$HEALTH" ] && [ -n "$HUB_OK" ]; then
  say "✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）"
else
  say "⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。"
  exit 1
fi