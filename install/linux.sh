#!/usr/bin/env bash
# Kizuna Box — Linux 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：安装运行时（如缺失）→ 下载服务 → 用令牌完成注册（换正式凭据、回填 webhook）
#       → 配置开机自启（systemd）→ 启动 → 自检
# 升级：重跑本脚本即同路径覆盖 bin，保留 spool 与 config。
set -euo pipefail

HUB="__KIZUNA_HUB__"
TOKEN="__KIZUNA_TOKEN__"

PREFIX=/opt/kizuna-box
CONF_DIR=/etc/kizuna-box
CONFIG="$CONF_DIR/config.json"
SERVICE=kizuna-box
SERVICE_FILE=/etc/systemd/system/${SERVICE}.service
BOX_USER=kizuna

say()  { echo "[kizuna-box] $*"; }
fail() { echo "[kizuna-box][ERROR] $*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[ "$(uname -s)" = "Linux" ] || fail "本脚本仅支持 Linux（macOS 请用 macos.sh）"
[ "$(id -u)" = "0" ] || fail "需要 root 权限：请用 sudo bash 或以 root 执行"
command -v curl >/dev/null 2>&1 || fail "缺少 curl：请先安装（apt/dnf install curl）"

# ---------- 1. 运行时：Node.js ≥ 18 ----------
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
    fail "未识别的包管理器，请手动安装 Node.js 20 后重试"
  fi
fi
command -v node >/dev/null 2>&1 || fail "Node.js 安装失败"
NODE_BIN="$(command -v node)"
say "Node.js 就绪: $($NODE_BIN --version) ($NODE_BIN)"

# ---------- 2. 下载服务（同路径覆盖，保留 spool/config） ----------
mkdir -p "$PREFIX/bin" "$CONF_DIR"
curl -fsSL "$HUB/install/box.js" -o "$PREFIX/bin/kizuna-box"
chmod 0755 "$PREFIX/bin/kizuna-box"
say "服务已下载: $PREFIX/bin/kizuna-box"

# ---------- 3. 注册（升级模式跳过：保留现有凭据） ----------
UPGRADE=0
if [ -f "$CONFIG" ] && "$NODE_BIN" -e 'const c=require(process.argv[1]);process.exit(c.agent_id&&c.agent_token&&c.endpoint_secret?0:1)' "$CONFIG" 2>/dev/null; then
  UPGRADE=1
  say "检测到已有配置，升级模式：保留 config 与 spool"
else
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  [ -n "${LAN_IP:-}" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
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

# ---------- 4. 专用用户与权限（systemd 服务身份） ----------
if id "$BOX_USER" >/dev/null 2>&1; then :; else
  useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$BOX_USER" 2>/dev/null || true
fi
chown -R "$BOX_USER:$BOX_USER" "$PREFIX" "$CONF_DIR" 2>/dev/null || true
chmod 600 "$CONFIG" 2>/dev/null || true

# ---------- 5. systemd 单元（崩溃 5s 拉起 + 开机自启） ----------
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
  say "systemd 服务已启用: $SERVICE（Restart=always，开机自启）"
else
  fail "未检测到 systemd，无法配置开机自启（请手动运行: $NODE_BIN $PREFIX/bin/kizuna-box run --config $CONFIG）"
fi

# ---------- 6. 自检（healthz / 服务状态 / hub 连通性） ----------
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
[ -n "$HUB_OK" ] && say "③ Hub 连通 ........ OK" || say "③ Hub 连通 ........ FAIL（Hub 不可达: $HUB）"
echo
if [ -n "$HEALTH" ] && [ "$STATE" = "active" ] && [ -n "$HUB_OK" ]; then
  say "✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）"
else
  say "⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。"
  exit 1
fi
