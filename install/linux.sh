#!/usr/bin/env bash
# Kizuna Box — Linux 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：注册（先用令牌换正式凭据并落盘）→ 安装运行时（如缺失）→ 下载服务
#       → 写入 config → 配置开机自启（systemd）→ 启动 → 自检
# 注册排在最前：令牌是一次性资源，后面的装运行时/下载再慢也不会把它拖过期。
# 升级/续装：重跑本脚本即同路径覆盖 bin，保留 spool 与 config；已注册则跳过注册。
set -euo pipefail

HUB="__KIZUNA_HUB__"
TOKEN="__KIZUNA_TOKEN__"

PREFIX=/opt/kizuna-box
CONF_DIR=/etc/kizuna-box
CONFIG="$CONF_DIR/config.json"
ENROLL_JSON="$CONF_DIR/enroll.json"
SERVICE=kizuna-box
SERVICE_FILE=/etc/systemd/system/${SERVICE}.service
BOX_USER=kizuna

say()  { echo "[kizuna-box] $*"; }
fail() { echo "[kizuna-box][ERROR] $*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(uname -s)" = "Linux" ] || fail "本脚本仅支持 Linux（macOS 请用 macos.sh）"
[ "$(id -u)" = "0" ] || fail "需要 root 权限：请用 sudo bash 或以 root 执行"
command -v curl >/dev/null 2>&1 || fail "缺少 curl：请先安装（apt/dnf install curl）"

mkdir -p "$PREFIX/bin" "$CONF_DIR"

# ---------- 1. 注册（curl 直连，不依赖 Node；已注册则跳过） ----------
HAVE_CONFIG=0
if [ -f "$CONFIG" ] && grep -q '"agent_token"' "$CONFIG" 2>/dev/null; then
  HAVE_CONFIG=1
fi
if [ "$HAVE_CONFIG" = "1" ]; then
  say "检测到已有配置：跳过注册，保留 config 与 spool"
elif [ -s "$ENROLL_JSON" ]; then
  say "检测到上次注册凭据：跳过注册，继续安装"
else
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  [ -n "${LAN_IP:-}" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "${LAN_IP:-}" ] || LAN_IP="127.0.0.1"
  WEBHOOK="http://${LAN_IP}:7788"
  PAYLOAD="$(printf '{"token":"%s","webhook_url":"%s"}' "$TOKEN" "$WEBHOOK")"
  say "注册到 Hub（webhook=${WEBHOOK}）..."
  HTTP=""
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
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [ "$(node_major)" -lt 18 ]; then
  say "安装 Node.js 20 ..."
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    yum install -y nodejs >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs >/dev/null
  else
    fail "未识别的包管理器，请手动安装 Node.js 20 后重试（注册已完成，不会重复消耗令牌）"
  fi
fi
command -v node >/dev/null 2>&1 || fail "Node.js 安装失败（注册已完成，装好 Node 后重跑本脚本即可续装）"
NODE_BIN="$(command -v node)"
say "Node.js 就绪: $($NODE_BIN --version) ($NODE_BIN)"

# ---------- 3. 下载服务（失败重试；停滞 20s 自动断开重下） ----------
BOX="$PREFIX/bin/kizuna-box"
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

# ---------- 5. 专用用户与权限（systemd 服务身份） ----------
if id "$BOX_USER" >/dev/null 2>&1; then :; else
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$BOX_USER" 2>/dev/null || true
fi
chown -R "$BOX_USER:$BOX_USER" "$PREFIX" "$CONF_DIR" 2>/dev/null || true
chmod 600 "$CONFIG" 2>/dev/null || true

# ---------- 6. systemd 单元（崩溃 5s 拉起 + 开机自启） ----------
cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=Kizuna Endpoint (Kizuna端侧服务)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${PREFIX}/bin/kizuna-box run --config ${CONFIG}
Restart=always
RestartSec=5
User=${BOX_USER}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE"
  say "systemd 服务已启用: ${SERVICE}（Restart=always，开机自启）"
else
  fail "未检测到 systemd，无法配置开机自启（请手动运行: $NODE_BIN $PREFIX/bin/kizuna-box run --config ${CONFIG}）"
fi

# ---------- 7. 自检（healthz / 服务状态 / hub 连通性） ----------
sleep 2
echo
say "===== 自检报告 ====="
HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:7788/healthz 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then
  say "① healthz ......... OK  $HEALTH"
else
  say "① healthz ......... FAIL（服务未响应，请查看: journalctl -u $SERVICE -n 50）"
fi
STATE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
[ "$STATE" = "active" ] && say "② 服务状态 ........ OK  ($SERVICE: active)" || say "② 服务状态 ........ FAIL ($SERVICE: ${STATE:-unknown})"
HUB_OK="$(curl -fsS --max-time 5 "$HUB/healthz" 2>/dev/null || true)"
[ -n "$HUB_OK" ] && say "③ Hub 连通 ........ OK" || say "③ Hub 连通 ........ FAIL（Hub 不可达: ${HUB}）"
echo
if [ -n "$HEALTH" ] && [ "$STATE" = "active" ] && [ -n "$HUB_OK" ]; then
  say "✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）"
else
  say "⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。"
  exit 1
fi