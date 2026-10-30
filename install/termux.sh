#!/usr/bin/env bash
# Kizuna Box — Android(Termux) 一键安装脚本（由 Hub 下发，HUB 与 TOKEN 已内嵌）
# 流程：pkg 安装运行时 → 下载服务 → 注册 → termux-services（sv）托管 + Termux:Boot 开机自启 → 自检
# 升级：重跑本脚本即同路径覆盖 bin，保留 spool 与 config。
set -euo pipefail

HUB="__KIZUNA_HUB__"
TOKEN="__KIZUNA_TOKEN__"

ROOT="$HOME/.kizuna-box"
CONFIG="$ROOT/config.json"
SVC_NAME=kizuna-box
SVC_DIR="$PREFIX/var/service/$SVC_NAME"

say()  { echo "[kizuna-box] $*"; }
fail() { echo "[kizuna-box][ERROR] $*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
if [ -z "${TERMUX_VERSION:-}" ] || [ -z "${PREFIX:-}" ]; then
  fail "本脚本仅支持 Android Termux 环境（请在 Termux 内执行）"
fi
command -v curl >/dev/null 2>&1 || fail "缺少 curl：请先 pkg install curl"

# ---------- 1. 运行时与服务管理 ----------
say "安装 nodejs / termux-services ..."
pkg install -y nodejs termux-services >/dev/null 2>&1 || pkg install -y nodejs termux-services
command -v node >/dev/null 2>&1 || fail "Node.js 安装失败"
say "Node.js 就绪: $(node --version)"

# ---------- 2. 下载服务 ----------
mkdir -p "$ROOT/bin" "$ROOT/logs"
curl -fsSL "$HUB/install/box.js" -o "$ROOT/bin/kizuna-box"
chmod 0755 "$ROOT/bin/kizuna-box"
say "服务已下载: $ROOT/bin/kizuna-box"

# ---------- 3. 注册（升级模式跳过） ----------
if [ -f "$CONFIG" ] && node -e 'const c=require(process.argv[1]);process.exit(c.agent_id&&c.agent_token&&c.endpoint_secret?0:1)' "$CONFIG" 2>/dev/null; then
  say "检测到已有配置，升级模式：保留 config 与 spool"
else
  LAN_IP="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127/ {print $2; exit}' | sed 's;addr:;;')"
  [ -n "${LAN_IP:-}" ] || LAN_IP="127.0.0.1"
  WEBHOOK="http://${LAN_IP}:7788"
  say "注册到 Hub（webhook=$WEBHOOK）..."
  node - "$HUB" "$TOKEN" "$WEBHOOK" "$CONFIG" <<'ENROLL'
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

# ---------- 4. runit 服务（sv 托管，崩溃即拉起） + Termux:Boot 开机自启 ----------
mkdir -p "$SVC_DIR/log"
cat > "$SVC_DIR/run" <<RUN_SH
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock 2>/dev/null
exec "$ROOT/bin/kizuna-box" run --config "$CONFIG" 2>&1
RUN_SH
cat > "$SVC_DIR/log/run" <<LOG_SH
#!/data/data/com.termux/files/usr/bin/sh
mkdir -p "$ROOT/logs/sv"
exec svlogd "$ROOT/logs/sv"
LOG_SH
chmod +x "$SVC_DIR/run" "$SVC_DIR/log/run"

sv-enable "$SVC_NAME" 2>/dev/null || true
sv up "$SVC_NAME" 2>/dev/null || svc up "$SVC_NAME" 2>/dev/null || say "sv 启动命令不可用，请重启 Termux 会话或手动: sv up $SVC_NAME"
say "runit 服务已启用: $SVC_DIR（sv 托管）"
if [ -d "$HOME/.termux/boot" ] || [ -d "$PREFIX/etc/termux/boot" ]; then
  say "检测到 Termux:Boot —— termux-services 会在设备开机后自动拉起已启用服务 ✅"
else
  say "提示：安装 Termux:Boot 应用并重启一次设备，即可实现开机自启（termux-services 会自动拉起 $SVC_NAME）"
fi

# ---------- 5. 自检 ----------
sleep 2
echo
say "===== 自检报告 ====="
HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:7788/healthz 2>/dev/null || true)"
[ -n "$HEALTH" ] && say "① healthz ......... OK  $HEALTH" || say "① healthz ......... FAIL（查看: sv status $SVC_NAME / $ROOT/logs）"
SV_STATE="$(sv status "$SVC_NAME" 2>/dev/null | awk '{print $1}')"
[ "$SV_STATE" = "run" ] && say "② 服务状态 ........ OK  (sv: run)" || say "② 服务状态 ........ FAIL (sv: ${SV_STATE:-unknown})"
HUB_OK="$(curl -fsS --max-time 5 "$HUB/healthz" 2>/dev/null || true)"
[ -n "$HUB_OK" ] && say "③ Hub 连通 ........ OK" || say "③ Hub 连通 ........ FAIL（Hub 不可达: $HUB）"
echo
if [ -n "$HEALTH" ] && [ -n "$HUB_OK" ]; then
  say "✅ 安装完成。本机 Agent 信箱地址: http://127.0.0.1:7788（GET /tasks/pending 取信）"
else
  say "⚠️ 安装未完全通过自检，请按上方提示排查后重跑本脚本。"
  exit 1
fi
