/* Kizuna 管理台 · 单文件轻量实现（无构建器）
   六页面：总览 / 通讯录 / 任务队列 / 投递留痕 / 安装部署 / 设置 */
'use strict';

const TOKEN_KEY = 'kizuna_admin_token';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// API 客户端
// ---------------------------------------------------------------------------

let adminToken = localStorage.getItem(TOKEN_KEY) ?? '';

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'UNAUTHORIZED', '管理员令牌无效或已失效');
  }
  if (!res.ok) {
    let code = 'INTERNAL', msg = `HTTP ${res.status}`;
    try { const j = await res.json(); code = j.error?.code ?? code; msg = j.error?.message ?? msg; } catch { /* 保留默认 */ }
    throw new ApiError(res.status, code, msg);
  }
  if (raw) return res;
  return res.json();
}

function onUnauthorized() {
  adminToken = '';
  localStorage.removeItem(TOKEN_KEY);
  showLogin('管理员令牌无效或已失效，请重新输入');
}

// ---------------------------------------------------------------------------
// 小部件
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

/** 秒 → 自然语言（3 小时 / 1.5 小时 / 30 分钟），与 hub prompt.ts 的 humanTtl 同口径 */
function humanTtl(sec) {
  sec = Number(sec);
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const ms = sec * 1000;
  if (ms % 3600000 === 0) return `${ms / 3600000} 小时`;
  if (ms > 3600000 && ms % 1800000 === 0) return `${ms / 3600000} 小时`;
  if (ms % 60000 === 0) return `${ms / 60000} 分钟`;
  return `${Math.round(sec)} 秒`;
}

function fmtIn(durMs) {
  if (durMs <= 0) return '现在';
  const s = Math.round(durMs / 1000);
  if (s < 60) return `${s}s 后`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 后`;
  return `${Math.floor(m / 60)}h ${m % 60}m 后`;
}

const OUTCOME_TEXT = {
  delivered_confirmed: ['已签收', 'ok'],
  delivery_failed: ['投递失败', 'bad'],
  invalid_target: ['目标无效', 'warn'],
  cancelled: ['已取消', 'dim'],
};
function outcomeBadge(outcome) {
  const [text, cls] = OUTCOME_TEXT[outcome] ?? [outcome, 'dim'];
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}
const TASK_STATUS_TEXT = {
  queued: ['排队中', 'info'],
  delivering: ['投递中', 'info'],
  wait_retry: ['重试中', 'warn'],
};
function taskStatusBadge(st) {
  const [text, cls] = TASK_STATUS_TEXT[st] ?? [st, 'dim'];
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}
function agentStatusBadge(st) {
  const map = { online: ['在线', 'ok'], offline: ['离线', 'dim'], unknown: ['未上报', 'dim'] };
  const [text, cls] = map[st] ?? [st, 'dim'];
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}
const attemptOutcomeBadge = (() => {
  const map = { ack: ['签收', 'ok'], bad_ack: ['回执异常', 'bad'], http_4xx: ['4xx', 'bad'], http_5xx: ['5xx', 'bad'], timeout: ['超时', 'bad'], network_error: ['网络错误', 'bad'] };
  return (o) => { const [text, cls] = map[o] ?? [o, 'dim']; return `<span class="badge ${cls}">${esc(text)}</span>`; };
})();

const RESULT_STATE_TEXT = {
  working: ['进行中', 'info'],
  'input-required': ['等待输入', 'warn'],
  completed: ['已完成', 'ok'],
  failed: ['失败', 'bad'],
  canceled: ['已取消', 'dim'],
};

/** 详情弹层内渲染「结果回传」时间线（v1.1） */
async function fillResults(m, taskId) {
  const box = $('#m-results', m);
  if (!box) return;
  try {
    const r = await api(`/api/v1/tasks/${encodeURIComponent(taskId)}/result`);
    if (!r.items.length) { box.innerHTML = '<span class="muted">尚无回传</span>'; return; }
    box.innerHTML = `<ul class="timeline">${r.items.map((x) => {
      const [txt] = RESULT_STATE_TEXT[x.state] ?? [x.state];
      const liCls = x.category === 'terminal' ? (x.state === 'completed' ? 'ok' : 'bad') : 'wait';
      return `<li class="${liCls}">
        <strong>${esc(txt)}</strong> <span class="badge dim">${esc(x.category)}</span> · <span class="mono">${esc(fmtTime(x.reported_at))}</span>
        ${x.relayed_to ? `<span class="muted mono">回执→${esc(x.relayed_to)}</span>` : ''}
        ${x.message ? `<div class="muted" style="font-size:12.5px">${esc(x.message)}</div>` : ''}
      </li>`;
    }).join('')}</ul>`;
  } catch (e) {
    box.innerHTML = `<span class="error">结果加载失败：${esc(e.message)}</span>`;
  }
}

function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = $('.modal-back', root);
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  document.addEventListener('keydown', escListener);
  return $('.modal', root);
}
function escListener(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  $('#modal-root').innerHTML = '';
  document.removeEventListener('keydown', escListener);
}

function confirmModal(title, text, dangerText, onOk) {
  const m = modal(`
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(text)}</p>
    <div class="form-actions">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn danger" data-act="ok">${esc(dangerText)}</button>
    </div>`);
  $('[data-act="cancel"]', m).onclick = closeModal;
  $('[data-act="ok"]', m).onclick = async () => { closeModal(); await onOk(); };
}

function emptyState(big, small, actionHtml = '') {
  return `<div class="empty"><div class="big">${esc(big)}</div><div>${esc(small)}</div>${actionHtml}</div>`;
}
function loadingState() {
  return `<div class="loading">
    <div class="skeleton" style="width:40%"></div>
    <div class="skeleton" style="width:90%"></div>
    <div class="skeleton" style="width:75%"></div>
    <div class="skeleton" style="width:60%"></div>
  </div>`;
}
function errorState(err, retry) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.innerHTML = `<div class="big" style="color:var(--bad)">加载失败：${esc(err.message)}</div>
    <div class="muted">Hub 不可达或权限不足。请检查服务状态与管理员令牌。</div>`;
  const btn = document.createElement('button');
  btn.className = 'btn'; btn.textContent = '重试';
  btn.onclick = retry;
  wrap.appendChild(btn);
  return wrap;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('已复制到剪贴板');
  }
}

// ---------------------------------------------------------------------------
// 登录 / 框架
// ---------------------------------------------------------------------------

function showLogin(errMsg) {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  const e = $('#login-error');
  if (errMsg) { e.textContent = errMsg; e.hidden = false; } else { e.hidden = true; }
  $('#login-token').focus();
}

function showShell() {
  $('#login').hidden = true;
  $('#shell').hidden = false;
  $('#hub-origin').textContent = location.origin;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#login-token');
  adminToken = input.value.trim();
  try {
    await api('/api/v1/settings');
    localStorage.setItem(TOKEN_KEY, adminToken);
    input.value = '';
    showShell();
    route();
  } catch (err) {
    if (err.status !== 401) { // 网络等其他错误也放行进入（页面内会显示错误态）
      localStorage.setItem(TOKEN_KEY, adminToken);
      showShell();
      route();
    } else {
      showLogin('令牌无效：请填写 Hub 的管理员令牌（KIZUNA_ADMIN_TOKEN 或 data/admin-token.json）');
    }
  }
});

$('#logout').addEventListener('click', () => {
  localStorage.removeItem(TOKEN_KEY);
  adminToken = '';
  stopPolling();
  showLogin();
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const pages = { overview: renderOverview, agents: renderAgents, queue: renderQueue, audit: renderAudit, install: renderInstall, settings: renderSettings };
let pollTimer = null;
let pollFn = null;

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null; pollFn = null;
}
function startPolling(fn) {
  stopPolling();
  pollFn = fn;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pollFn?.();
  }, 5000);
}

async function route() {
  stopPolling();
  const name = (location.hash.replace(/^#\//, '') || 'overview').split('?')[0];
  const fn = pages[name] ?? renderOverview;
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  const main = $('#main');
  main.innerHTML = loadingState();
  try {
    await fn(main);
    main.focus({ preventScroll: true });
  } catch (err) {
    if (err.status === 401) return; // 已跳登录
    main.innerHTML = '';
    main.appendChild(errorState(err, () => route()));
  }
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// 页面一：总览
// ---------------------------------------------------------------------------

async function renderOverview(main) {
  const load = async () => {
    const o = await api('/api/v1/overview');
    main.innerHTML = `
    <div class="page-head"><h2>总览</h2><div class="spacer"></div>
      <button class="btn small" id="ov-refresh">刷新</button></div>
    <div class="cards">
      <div class="card ok"><div class="k">在线 Agent</div><div class="v">${o.agents.online}</div><div class="k muted">共 ${o.agents.total} 个（离线 ${o.agents.offline} · 未上报 ${o.agents.unknown}）</div></div>
      <div class="card"><div class="k">队列深度</div><div class="v">${o.queue.depth}</div><div class="k muted">投递中 ${o.queue.delivering}</div></div>
      <div class="card warn"><div class="k">重试中任务</div><div class="v">${o.queue.retrying}</div><div class="k muted">梯度见「设置」</div></div>
      <div class="card ok"><div class="k">今日已签收</div><div class="v">${o.today.delivered}</div><div class="k muted">UTC 日界</div></div>
      <div class="card bad"><div class="k">今日投递失败</div><div class="v">${o.today.failed}</div><div class="k muted">含目标无效</div></div>
      <div class="card"><div class="k">演示记录</div><div class="v">${o.audit?.demo_records ?? 0}</div><div class="k muted">默认不计入业务指标</div></div>
    </div>
    <div class="panel">
      <div class="panel-head">最近留痕 <span class="spacer"></span><a href="#/audit" class="muted" style="font-size:12.5px">查看全部 →</a></div>
      <table><thead><tr><th>时间</th><th>留痕号</th><th>任务号</th><th>来自</th><th>给谁</th><th>结果</th><th>尝试</th></tr></thead>
      <tbody>${o.recent_audit.length ? o.recent_audit.map((a) => `
        <tr class="clickable" data-log="${esc(a.log_id)}">
          <td class="mono">${esc(fmtTime(a.dequeued_at))}</td>
          <td class="mono">${esc(a.log_id)}</td>
          <td class="mono">${esc(a.task_id)}</td>
          <td class="mono">${esc(a.from)}</td>
          <td class="mono">${esc(a.to)}</td>
          <td>${outcomeBadge(a.outcome)}</td>
          <td>${a.attempt_count}</td>
        </tr>`).join('') : `<tr><td colspan="7"><div class="empty">暂无留痕——投递发生后将在此留档</div></td></tr>`}
      </tbody></table>
    </div>`;
    $('#ov-refresh').onclick = load;
    main.querySelectorAll('tr[data-log]').forEach((tr) => {
      tr.onclick = () => { location.hash = '#/audit'; setTimeout(() => showAuditDetail(tr.dataset.log), 60); };
    });
  };
  await load();
  startPolling(load);
}

// ---------------------------------------------------------------------------
// 页面二：通讯录
// ---------------------------------------------------------------------------

const agentFilter = { q: '', status: '' };

async function renderAgents(main) {
  main.innerHTML = `
  <div class="page-head"><h2>通讯录</h2><div class="spacer"></div>
    <button class="btn primary" id="ag-new">＋ 注册 Agent</button></div>
  <div class="panel">
    <div class="panel-head">
      <div class="toolbar">
        <input id="ag-q" placeholder="搜索 编号 / 名称 / 能力…" value="${esc(agentFilter.q)}" style="width:230px">
        <select id="ag-status">
          <option value="">全部状态</option>
          ${['online', 'offline', 'unknown'].map((s) => `<option value="${s}" ${agentFilter.status === s ? 'selected' : ''}>${{ online: '在线', offline: '离线', unknown: '未上报' }[s]}</option>`).join('')}
        </select>
      </div>
      <span class="spacer"></span><span class="muted" id="ag-total"></span>
    </div>
    <div id="ag-table">${loadingState()}</div>
  </div>`;

  const load = async () => {
    const box = $('#ag-table');
    const params = new URLSearchParams();
    if (agentFilter.q) params.set('q', agentFilter.q);
    if (agentFilter.status) params.set('status', agentFilter.status);
    params.set('limit', '200');
    let data;
    try {
      data = await api(`/api/v1/agents?${params}`);
    } catch (err) {
      if (err.status === 401) return;
      box.innerHTML = ''; box.appendChild(errorState(err, load)); return;
    }
    $('#ag-total').textContent = `共 ${data.total} 个`;
    if (!data.items.length) {
      box.innerHTML = emptyState(agentFilter.q || agentFilter.status ? '没有匹配的 Agent' : '通讯录还是空的',
        agentFilter.q || agentFilter.status ? '调整搜索条件试试' : '注册第一个 Agent，或用「安装部署」一句提示词完成接入',
        `<div style="margin-top:12px"><button class="btn primary" onclick="document.getElementById('ag-new').click()">＋ 注册 Agent</button></div>`);
      return;
    }
    box.innerHTML = `<table><thead><tr>
        <th>编号</th><th>名称</th><th>能力标签</th><th>webhook</th><th>状态</th><th>启停</th><th style="width:150px">操作</th>
      </tr></thead><tbody>
      ${data.items.map((a) => `
        <tr data-id="${esc(a.agent_id)}">
          <td class="mono"><strong>${esc(a.agent_id)}</strong>${a.agent_card ? ' <span class="badge info" title="已发布 A2A Agent Card">A2A卡</span>' : ''}</td>
          <td>${esc(a.name)}</td>
          <td>${a.capability_tags.length ? a.capability_tags.map((t) => `<span class="badge dim">${esc(t)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
          <td class="mono">${esc(a.webhook_url)}</td>
          <td>${agentStatusBadge(a.status)}${a.enabled ? '' : ' <span class="badge bad">停用</span>'}</td>
          <td><button class="btn small" data-act="toggle" data-id="${esc(a.agent_id)}" data-enabled="${a.enabled ? '1' : '0'}">${a.enabled ? '停用' : '启用'}</button></td>
          <td>
            <button class="btn small" data-act="edit" data-id="${esc(a.agent_id)}">编辑</button>
            <button class="btn small danger" data-act="del" data-id="${esc(a.agent_id)}" data-name="${esc(a.name)}">注销</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    box.querySelectorAll('[data-act="toggle"]').forEach((b) => {
      b.onclick = () => setAgentEnabled(b.dataset.id, b.dataset.enabled === '1');
    });
    box.querySelectorAll('[data-act="edit"]').forEach((b) => { b.onclick = () => agentForm(b.dataset.id); });
    box.querySelectorAll('[data-act="del"]').forEach((b) => {
      b.onclick = () => confirmModal('注销 Agent', `确定注销 ${b.dataset.id}（${b.dataset.name}）？在途任务将按「目标无效」留痕。`, '注销', async () => {
        await api(`/api/v1/agents/${encodeURIComponent(b.dataset.id)}`, { method: 'DELETE' });
        toast('已注销'); load();
      });
    });
  };

  $('#ag-q').oninput = debounce(() => { agentFilter.q = $('#ag-q').value.trim(); load(); }, 300);
  $('#ag-status').onchange = () => { agentFilter.status = $('#ag-status').value; load(); };
  $('#ag-new').onclick = () => agentForm(null, load);
  await load();
  startPolling(load);
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function agentForm(agentId, onDone) {
  let agent = { agent_id: '', name: '', capabilities: '', capability_tags: [], webhook_url: '', enabled: true };
  if (agentId) agent = await api(`/api/v1/agents/${encodeURIComponent(agentId)}`);
  const m = modal(`
    <h3>${agentId ? '编辑 Agent' : '注册 Agent'}</h3>
    <div class="form-grid">
      <div class="field"><label>编号（留空自动分配 A-XXXX）</label>
        <input id="f-id" value="${esc(agent.agent_id)}" ${agentId ? 'disabled' : ''} placeholder="A-9X2M / 自定义唯一串"></div>
      <div class="field"><label>名称 *</label><input id="f-name" value="${esc(agent.name)}" placeholder="单证预审 Agent"></div>
      <div class="field full"><label>能力声明（自由文本）</label>
        <textarea id="f-cap" rows="2" placeholder="报关单证预审、信用证要素核对">${esc(agent.capabilities)}</textarea></div>
      <div class="field"><label>能力标签（逗号分隔）</label>
        <input id="f-tags" value="${esc((agent.capability_tags ?? []).join(', '))}" placeholder="单证, 预审"></div>
      <div class="field"><label>webhook 地址 *（Hub 投递目标）</label>
        <input id="f-hook" value="${esc(agent.webhook_url)}" placeholder="http://192.168.1.20:7788"></div>
      <div class="field full"><label>A2A Agent Card（JSON，可选；发布后经 /.well-known/agent-card.json?agent=编号 公开可发现；编辑时清空并保存 = 撤卡）</label>
        <textarea id="f-card" rows="4" class="mono" placeholder='{"name":"单证预审","description":"报关单证预审服务","skills":[{"id":"precheck","name":"单证预审","tags":["单证"]}]}'>${agent.agent_card ? esc(JSON.stringify(agent.agent_card, null, 2)) : ''}</textarea></div>
    </div>
    <p class="error" id="f-err" hidden></p>
    <div class="form-actions">
      <button class="btn" id="f-cancel">取消</button>
      <button class="btn primary" id="f-save">${agentId ? '保存' : '注册'}</button>
    </div>`);
  $('#f-cancel', m).onclick = closeModal;
  $('#f-save', m).onclick = async () => {
    const body = {
      name: $('#f-name', m).value.trim(),
      capabilities: $('#f-cap', m).value.trim(),
      capability_tags: $('#f-tags', m).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      webhook_url: $('#f-hook', m).value.trim(),
    };
    const cardRaw = $('#f-card', m).value.trim();
    if (cardRaw) {
      try { body.agent_card = JSON.parse(cardRaw); }
      catch { const e = $('#f-err', m); e.textContent = 'A2A Agent Card 不是合法 JSON'; e.hidden = false; return; }
    } else if (agentId) {
      body.agent_card = null; // 编辑模式：清空 = 撤卡
    }
    try {
      if (agentId) {
        await api(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body });
        toast('已保存'); closeModal(); onDone?.();
      } else {
        const id = $('#f-id', m).value.trim();
        if (id) body.agent_id = id;
        const res = await api('/api/v1/agents', { method: 'POST', body });
        closeModal();
        const mm = modal(`
          <h3>✅ 注册成功：${esc(res.agent_id)}</h3>
          <p class="muted">以下凭据<strong>仅此一次展示</strong>，请立即保存：</p>
          <dl class="kv">
            <dt>Agent Token</dt><dd class="mono">${esc(res.agent_token)}</dd>
            <dt>Endpoint Secret</dt><dd class="mono">${esc(res.endpoint_secret)}</dd>
            <dt>webhook</dt><dd class="mono">${esc(res.webhook_url)}</dd>
          </dl>
          <p class="muted" style="font-size:12.5px">Agent Token 用于提交任务与心跳；Endpoint Secret 用于校验 Hub 投递签名（kizuna-box 已自动配置）。</p>
          <div class="form-actions"><button class="btn primary" id="ok-btn">我已保存</button></div>`);
        $('#ok-btn', mm).onclick = () => { closeModal(); onDone?.(); };
      }
    } catch (err) {
      const e = $('#f-err', m); e.textContent = err.message; e.hidden = false;
    }
  };
}

async function setAgentEnabled(id, enabled) {
  try {
    await api(`/api/v1/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: !enabled } });
    toast(enabled ? '已停用' : '已启用');
    route();
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// 页面三：任务队列
// ---------------------------------------------------------------------------

const queueFilter = { status: '', q: '' };

async function renderQueue(main) {
  main.innerHTML = `
  <div class="page-head"><h2>任务队列</h2><div class="spacer"></div>
    <button class="btn small" id="qk-refresh">刷新</button></div>
  <div class="panel">
    <div class="panel-head">
      <div class="toolbar">
        <select id="qk-status">
          <option value="">全部状态</option>
          ${['queued', 'delivering', 'wait_retry'].map((s) => `<option value="${s}" ${queueFilter.status === s ? 'selected' : ''}>${{ queued: '排队中', delivering: '投递中', wait_retry: '重试中' }[s]}</option>`).join('')}
        </select>
        <input id="qk-q" placeholder="任务号 / 来自 / 给谁" value="${esc(queueFilter.q)}" style="width:220px">
      </div>
      <span class="spacer"></span><span class="muted" id="qk-total"></span>
    </div>
    <div id="qk-table">${loadingState()}</div>
  </div>
  <div class="panel" id="qk-detail" hidden></div>`;

  const load = async () => {
    const box = $('#qk-table');
    const params = new URLSearchParams();
    if (queueFilter.status) params.set('status', queueFilter.status);
    params.set('limit', '200');
    let data;
    try { data = await api(`/api/v1/tasks?${params}`); }
    catch (err) { if (err.status === 401) return; box.innerHTML = ''; box.appendChild(errorState(err, load)); return; }

    const q = queueFilter.q.toLowerCase();
    const items = q ? data.items.filter((t) => [t.task_id, t.from, t.to].some((v) => String(v).toLowerCase().includes(q))) : data.items;
    $('#qk-total').textContent = `在途 ${data.total} 个`;
    if (!items.length) {
      box.innerHTML = emptyState(queueFilter.q || queueFilter.status ? '没有匹配的在途任务' : '队列已清空',
        queueFilter.q || queueFilter.status ? '调整筛选条件试试' : '所有任务包都已签收或结案（终态见「投递留痕」）');
      return;
    }
    box.innerHTML = `<table><thead><tr>
        <th>任务号</th><th>标题</th><th>来自</th><th>给谁</th><th>状态</th><th>已试</th><th>下次投递</th><th style="width:150px">操作</th>
      </tr></thead><tbody>
      ${items.map((t) => `
        <tr class="clickable" data-task="${esc(t.task_id)}">
          <td class="mono"><strong>${esc(t.task_id)}</strong></td>
          <td>${esc(t.title ?? '（无标题）')}</td>
          <td class="mono">${esc(t.from)}</td>
          <td class="mono">${esc(t.to)}</td>
          <td>${taskStatusBadge(t.status)}</td>
          <td>${t.attempt_count}</td>
          <td class="mono">${t.next_action_at ? `${esc(fmtTime(t.next_action_at))}` : '—'}</td>
          <td>
            <button class="btn small" data-act="retry" data-id="${esc(t.task_id)}">立即重投</button>
            <button class="btn small danger" data-act="cancel" data-id="${esc(t.task_id)}">取消</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`;

    box.querySelectorAll('tr[data-task]').forEach((tr) => { tr.onclick = (e) => { if (e.target.tagName !== 'BUTTON') showTaskDetail(tr.dataset.task); }; });
    box.querySelectorAll('[data-act="retry"]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        try { await api(`/api/v1/tasks/${encodeURIComponent(b.dataset.id)}/retry`, { method: 'POST', body: {} }); toast('已安排立即重投'); load(); }
        catch (err) { toast(err.message, true); }
      };
    });
    box.querySelectorAll('[data-act="cancel"]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        confirmModal('取消任务', `确定取消 ${b.dataset.id}？任务将出队并留痕「已取消」。`, '取消任务', async () => {
          try { await api(`/api/v1/tasks/${encodeURIComponent(b.dataset.id)}/cancel`, { method: 'POST', body: {} }); toast('已取消并留痕'); load(); }
          catch (err) { toast(err.message, true); }
        });
      };
    });
  };

  $('#qk-status').onchange = () => { queueFilter.status = $('#qk-status').value; load(); };
  $('#qk-q').oninput = debounce(() => { queueFilter.q = $('#qk-q').value.trim(); load(); }, 300);
  $('#qk-refresh').onclick = load;
  await load();
  startPolling(load);
}

async function showTaskDetail(taskId) {
  const t = await api(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  const ladderHint = '梯度 3/10/30/60/120 分钟（可在「设置」调整）';
  const m = modal(`
    <h3 class="mono">${esc(t.task_id)}</h3>
    <dl class="kv">
      <dt>状态</dt><dd>${t.finalized ? outcomeBadge(t.status) : taskStatusBadge(t.status)}${t.finalized ? ' <span class="muted">（已终态，见留痕）</span>' : ''}</dd>
      <dt>标题</dt><dd>${esc(t.title ?? '（无标题）')}</dd>
      <dt>来自 → 给谁</dt><dd class="mono">${esc(t.from)} → ${esc(t.to)}</dd>
      <dt>内容</dt><dd class="mono" style="white-space:pre-wrap">${esc(typeof t.content === 'object'
        ? (t.content?.body != null && typeof t.content.body === 'object' ? JSON.stringify(t.content.body, null, 2) : String(t.content?.body ?? ''))
        : String(t.content))}</dd>
      <dt>优先级</dt><dd>${esc(t.priority ?? 'normal')}</dd>
      <dt>入队时间</dt><dd class="mono">${esc(fmtTime(t.created_at ?? t.enqueued_at))}</dd>
      ${t.next_action_at ? `<dt>下次投递</dt><dd class="mono">${esc(fmtTime(t.next_action_at))}（${fmtIn(new Date(t.next_action_at) - Date.now())}）</dd>` : ''}
    </dl>
    <div class="panel-head" style="border-top:1px solid var(--line)">尝试历史 <span class="muted" style="font-weight:400">${t.finalized ? '' : ' · ' + esc(ladderHint)}</span></div>
    <ul class="timeline">
      ${(t.attempts ?? []).map((a) => `
        <li class="${a.outcome === 'ack' ? 'ok' : 'bad'}">
          <strong>第 ${a.n} 次</strong> · <span class="mono">${esc(fmtTime(a.attempted_at))}</span>
          ${attemptOutcomeBadge(a.outcome)}
          ${a.http_status ? `<span class="muted mono">HTTP ${esc(a.http_status)}</span>` : ''}
          ${a.latency_ms != null ? `<span class="muted mono">${a.latency_ms}ms</span>` : ''}
          ${a.detail ? `<div class="muted" style="font-size:12.5px">${esc(a.detail)}</div>` : ''}
        </li>`).join('') || '<li><span class="muted">尚无尝试记录</span></li>'}
      ${!t.finalized && t.next_action_at ? `<li class="wait"><strong>第 ${(t.attempts?.length ?? 0) + 1} 次</strong> · <span class="muted">待执行 ← 下次</span></li>` : ''}
    </ul>
    <div class="panel-head" style="border-top:1px solid var(--line)">结果回传 <span class="muted" style="font-weight:400">进行中 / 中断 / 终态</span></div>
    <div id="m-results" style="padding:4px 16px 12px"><span class="muted">加载中…</span></div>
    <div class="form-actions"><button class="btn" id="d-close">关闭</button></div>`);
  $('#d-close', m).onclick = closeModal;
  fillResults(m, t.task_id);
}

// ---------------------------------------------------------------------------
// 页面四：投递留痕
// ---------------------------------------------------------------------------

const auditFilter = { outcome: '', from: '', to: '', include_demo: 'false' };

async function renderAudit(main) {
  main.innerHTML = `
  <div class="page-head"><h2>投递留痕</h2><span class="badge dim">只增不改</span><div class="spacer"></div>
    <button class="btn small" id="au-jsonl">导出 JSONL</button>
    <button class="btn small" id="au-csv">导出 CSV</button></div>
  <div class="panel">
    <div class="panel-head">
      <div class="toolbar">
        <select id="au-outcome">
          <option value="">全部结果</option>
          ${Object.entries(OUTCOME_TEXT).map(([k, [v]]) => `<option value="${k}" ${auditFilter.outcome === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        <input type="date" id="au-from" value="${esc(auditFilter.from)}" title="起始日期（UTC）">
        <span class="muted">→</span>
        <input type="date" id="au-to" value="${esc(auditFilter.to)}" title="结束日期（UTC）">
        <select id="au-demo" title="演示沙箱记录（默认不显示，保持审计视图纯净）">
          <option value="false" ${auditFilter.include_demo === 'false' ? 'selected' : ''}>不含演示记录</option>
          <option value="1" ${auditFilter.include_demo === '1' ? 'selected' : ''}>只看演示记录</option>
          <option value="all" ${auditFilter.include_demo === 'all' ? 'selected' : ''}>全部（含演示）</option>
        </select>
      </div>
      <span class="spacer"></span><span class="muted" id="au-total"></span>
    </div>
    <div id="au-table">${loadingState()}</div>
  </div>
  <div class="panel" id="au-detail" hidden></div>`;

  const paramsOf = (extra = {}) => {
    const p = new URLSearchParams();
    if (auditFilter.outcome) p.set('outcome', auditFilter.outcome);
    if (auditFilter.from) p.set('from', auditFilter.from + 'T00:00:00Z');
    if (auditFilter.to) p.set('to', auditFilter.to + 'T23:59:59Z');
    p.set('include_demo', auditFilter.include_demo);
    Object.assign(p, extra);
    return p;
  };

  const load = async () => {
    const box = $('#au-table');
    let data;
    try { data = await api(`/api/v1/audit?${paramsOf({ limit: 100 })}`); }
    catch (err) { if (err.status === 401) return; box.innerHTML = ''; box.appendChild(errorState(err, load)); return; }
    $('#au-total').textContent = `共 ${data.total} 条` +
      (data.demo_total ? `（另有 ${data.demo_total} 条演示记录已隐藏）` : '');
    if (!data.items.length) {
      box.innerHTML = emptyState('暂无留痕', '每一封信的最终去向都会写入这里（只增不改不删）');
      return;
    }
    box.innerHTML = `<table><thead><tr>
        <th>出队时间</th><th>留痕号</th><th>任务号</th><th>来自</th><th>给谁</th><th>结果</th><th>尝试</th>
      </tr></thead><tbody>
      ${data.items.map((a) => `
        <tr class="clickable" data-log="${esc(a.log_id)}">
          <td class="mono">${esc(fmtTime(a.dequeued_at))}</td>
          <td class="mono">${esc(a.log_id)}</td>
          <td class="mono">${esc(a.task_id)}</td>
          <td class="mono">${esc(a.from)}</td>
          <td class="mono">${esc(a.to)}</td>
          <td>${outcomeBadge(a.outcome)}${a.is_demo ? ' <span class="badge info">演示</span>' : ''}</td>
          <td>${a.attempt_count}</td>
        </tr>`).join('')}
      </tbody></table>`;
    box.querySelectorAll('tr[data-log]').forEach((tr) => { tr.onclick = () => showAuditDetail(tr.dataset.log); });
  };

  $('#au-outcome').onchange = () => { auditFilter.outcome = $('#au-outcome').value; load(); };
  $('#au-from').onchange = () => { auditFilter.from = $('#au-from').value; load(); };
  $('#au-to').onchange = () => { auditFilter.to = $('#au-to').value; load(); };
  $('#au-demo').onchange = () => { auditFilter.include_demo = $('#au-demo').value; load(); };
  $('#au-jsonl').onclick = () => downloadAudit('jsonl', paramsOf);
  $('#au-csv').onclick = () => downloadAudit('csv', paramsOf);
  await load();
}

async function downloadAudit(format, paramsOf) {
  try {
    const res = await api(`/api/v1/audit/export?${paramsOf({ format })}`, { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kizuna-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出');
  } catch (err) { toast(err.message, true); }
}

async function showAuditDetail(logId) {
  const data = await api(`/api/v1/audit?limit=1&offset=0`);
  // 直接从列表接口取单条：留痕无单条接口时用列表过滤
  let audit = data.items.find((a) => a.log_id === logId);
  if (!audit) {
    const all = await api(`/api/v1/audit?limit=1000`);
    audit = all.items.find((a) => a.log_id === logId);
  }
  if (!audit) { toast('留痕不存在', true); return; }
  const m = modal(`
    <h3 class="mono">${esc(audit.log_id)}</h3>
    <dl class="kv">
      <dt>结果</dt><dd>${outcomeBadge(audit.outcome)}</dd>
      <dt>任务号</dt><dd class="mono">${esc(audit.task_id)}</dd>
      <dt>来自 → 给谁</dt><dd class="mono">${esc(audit.from)} → ${esc(audit.to)}</dd>
      <dt>入队 → 出队</dt><dd class="mono">${esc(fmtTime(audit.enqueued_at))} → ${esc(fmtTime(audit.dequeued_at))}</dd>
      <dt>内容摘要</dt><dd class="mono" style="font-size:11.5px">${esc(audit.content_digest ?? '—')}</dd>
      ${audit.note ? `<dt>备注</dt><dd>${esc(audit.note)}</dd>` : ''}
    </dl>
    <div class="panel-head" style="border-top:1px solid var(--line)">完整尝试历史（${audit.attempts.length} 次）</div>
    <ul class="timeline">
      ${audit.attempts.map((a) => `
        <li class="${a.outcome === 'ack' ? 'ok' : 'bad'}">
          <strong>第 ${a.n} 次</strong> · <span class="mono">${esc(fmtTime(a.attempted_at))}</span>
          ${attemptOutcomeBadge(a.outcome)}
          ${a.http_status ? `<span class="muted mono">HTTP ${esc(a.http_status)}</span>` : ''}
          ${a.latency_ms != null ? `<span class="muted mono">${a.latency_ms}ms</span>` : ''}
          ${a.detail ? `<div class="muted" style="font-size:12.5px">${esc(a.detail)}</div>` : ''}
        </li>`).join('') || '<li><span class="muted">无投递尝试</span></li>'}
    </ul>
    <div class="panel-head" style="border-top:1px solid var(--line)">结果回传 <span class="muted" style="font-weight:400">进行中 / 中断 / 终态</span></div>
    <div id="m-results" style="padding:4px 16px 12px"><span class="muted">加载中…</span></div>
    <div class="form-actions"><button class="btn" id="a-close">关闭</button></div>`);
  $('#a-close', m).onclick = closeModal;
  fillResults(m, audit.task_id);
}

// ---------------------------------------------------------------------------
// 页面五：安装部署
// ---------------------------------------------------------------------------

let installCountdown = null;

async function renderInstall(main) {
  main.innerHTML = `
  <div class="page-head"><h2>安装部署</h2><div class="spacer"></div></div>
  <div class="panel">
    <div class="panel-head">① 填写 Agent 信息（预填进注册令牌）</div>
    <div style="padding:16px">
      <div class="form-grid">
        <div class="field"><label>编号（可选，留空自动分配）</label><input id="in-id" placeholder="A-9X2M"></div>
        <div class="field"><label>名称 *</label><input id="in-name" placeholder="单证预审 Agent"></div>
        <div class="field full"><label>能力声明</label><input id="in-cap" placeholder="报关单证预审、信用证要素核对"></div>
        <div class="field"><label>能力标签（逗号分隔）</label><input id="in-tags" placeholder="单证, 预审"></div>
      </div>
      <div class="form-actions"><button class="btn primary" id="in-gen">② 生成一次性安装提示词</button></div>
    </div>
  </div>

  <div class="panel" id="in-result" hidden>
    <div class="panel-head">安装提示词 <span class="countdown" id="in-countdown"></span>
      <span class="spacer"></span>
      <button class="btn small" id="in-copy">一键复制</button>
      <a class="btn small" id="in-raw" href="#" target="_blank" rel="noopener">纯文本</a>
    </div>
    <div style="padding:16px"><pre class="prompt" id="in-prompt"></pre></div>
  </div>

  <div class="panel">
    <div class="panel-head">③ 平台矩阵</div>
    <table><thead><tr><th>平台</th><th>运行时获取</th><th>开机自启方式</th><th>状态</th></tr></thead><tbody>
      <tr><td><strong>Linux</strong></td><td>apt / dnf 装 Node 20（缺失时）</td><td>systemd（Restart=always + multi-user.target）</td><td><span class="badge ok">脚本可用</span></td></tr>
      <tr><td><strong>macOS</strong></td><td>Homebrew / 官方 pkg（缺失时）</td><td>launchd LaunchAgent（RunAtLoad + KeepAlive）</td><td><span class="badge ok">脚本可用</span></td></tr>
      <tr><td><strong>Windows</strong></td><td>winget 装 Node LTS（缺失时）</td><td>WinSW 服务（Automatic + 失败重启）；无管理员权限时用计划任务</td><td><span class="badge ok">脚本可用</span></td></tr>
      <tr><td><strong>Android</strong></td><td>Termux pkg 装 nodejs</td><td>termux-services（sv 托管）+ Termux:Boot</td><td><span class="badge ok">脚本可用</span></td></tr>
      <tr><td><strong>鸿蒙</strong></td><td colspan="2">HarmonyOS NEXT 不开放第三方后台常驻运行时，v1 不提供脚本。替代路径：① 代理机模式——在同网段机器/云主机装 Kizuna Box，webhook 指向该机；② 等待 v2.0 ArkTS 原生 SDK；③ 具备开放终端环境的行业定制系统可按 Termux 方案尝试（不承诺）。</td><td><span class="badge warn">v1 边界</span></td></tr>
    </tbody></table>
  </div>
  <p class="muted" style="margin-top:12px">使用方法：把生成的提示词原样贴给目标机器上的 Agent（DSH 会话、CLI Agent 均可），它会自动探测系统、下载并安装 Kizuna Box、注册并回填 webhook、配置自启，然后向你汇报自检结果。令牌一次性、<span id="in-ttl">3 小时</span>内有效（脚本先注册再装运行时，装环境再慢也不会把令牌拖过期）。</p>`;

  // 有效期文案以服务端实时配置为准（KIZUNA_ENROLL_TTL_SECONDS 可调），避免硬编码漂移
  try {
    const hz = await fetch('/healthz').then((r) => r.json());
    if (hz?.enroll_ttl_seconds && humanTtl(hz.enroll_ttl_seconds)) {
      $('#in-ttl').textContent = humanTtl(hz.enroll_ttl_seconds);
    }
  } catch { /* 探活失败保留默认文案 */ }

  $('#in-gen').onclick = async () => {
    const name = $('#in-name').value.trim();
    if (!name) { toast('请先填写名称', true); return; }
    const body = {
      name,
      capabilities: $('#in-cap').value.trim(),
      capability_tags: $('#in-tags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
    const id = $('#in-id').value.trim();
    if (id) body.agent_id = id;
    try {
      const res = await api('/api/v1/enroll-tokens', { method: 'POST', body });
      $('#in-result').hidden = false;
      $('#in-prompt').textContent = res.install_prompt;
      $('#in-raw').href = `/install/prompt?token=${encodeURIComponent(res.token)}`;
      $('#in-copy').onclick = () => copyText(res.install_prompt);
      clearInterval(installCountdown);
      const tick = () => {
        const left = Math.max(0, new Date(res.expires_at).getTime() - Date.now());
        const total = Math.floor(left / 1000);
        const hh = Math.floor(total / 3600);
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        $('#in-countdown').textContent = left > 0
          ? `令牌剩余 ${hh > 0 ? `${hh}:` : ''}${mm}:${ss}`
          : '令牌已过期，请重新生成';
      };
      tick();
      installCountdown = setInterval(tick, 1000);
      const ttlText = humanTtl(res.ttl_seconds);
      if (ttlText) $('#in-ttl').textContent = ttlText;
      toast(`安装提示词已生成（${ttlText || '3 小时'}内有效）`);
      $('#in-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { toast(err.message, true); }
  };
}

// ---------------------------------------------------------------------------
// 页面六：设置
// ---------------------------------------------------------------------------

async function renderSettings(main) {
  const { settings } = await api('/api/v1/settings');
  const minutes = settings.retry_ladder_s.map((s) => s / 60);
  main.innerHTML = `
  <div class="page-head"><h2>设置</h2><div class="spacer"></div></div>
  <div class="panel">
    <div class="panel-head">投递参数（保存即生效）</div>
    <div style="padding:16px">
      <div class="form-grid">
        <div class="field full"><label>重试梯度（分钟，逗号分隔；长度 N → 最多 N+1 次尝试）</label>
          <input id="st-ladder" value="${esc(minutes.join(', '))}" placeholder="3, 10, 30, 60, 120">
          <span class="muted" style="font-size:12px">默认 3/10/30/60/120 分钟，累计跨度约 3 小时 43 分</span></div>
        <div class="field"><label>回执整体超时（秒）</label><input id="st-ack" type="number" min="1" max="120" value="${settings.ack_timeout_s}"></div>
        <div class="field"><label>投递全局并发</label><input id="st-conc" type="number" min="1" max="256" value="${settings.delivery_concurrency}"></div>
        <div class="field"><label>重试随机抖动（±秒）</label><input id="st-jitter" type="number" min="0" max="300" value="${settings.jitter_s}"></div>
        <div class="field"><label>心跳离线窗口（秒）</label><input id="st-hb" type="number" min="30" max="3600" value="${settings.heartbeat_window_s}"></div>
        <div class="field"><label>留痕保留期（天）</label><input id="st-retain" type="number" min="1" max="3650" value="${settings.audit_retention_days}"></div>
        <div class="field"><label>内容最小化</label>
          <select id="st-min"><option value="true" ${settings.content_minimized ? 'selected' : ''}>开启（留痕只存内容摘要）</option>
          <option value="false" ${!settings.content_minimized ? 'selected' : ''}>关闭（留痕附任务标题）</option></select></div>
        <div class="field"><label>公开安装 · 每人每分钟</label><input id="st-install-rate" type="number" min="1" max="600" value="${settings.public_install_per_minute}"></div>
        <div class="field"><label>演示沙箱 · 每人每分钟</label><input id="st-demo-rate" type="number" min="1" max="600" value="${settings.demo_per_minute}"></div>
        <div class="field full"><label>限流白名单（IP 或 CIDR，逗号/换行分隔；命中的来源不受限额约束——用于社区机器人、官方巡检、自有固定出口）</label>
          <textarea id="st-allow" rows="3" class="mono" placeholder="1.2.3.4, 10.0.0.0/8, 2001:db8::/32">${esc((settings.rate_limit_allowlist ?? []).join(', '))}</textarea>
          <span class="muted" style="font-size:12px">⚠️ 白名单完全豁免限流，只填你信任的地址；留空表示不豁免任何来源</span></div>
        <div class="field full"><label>提额联系方式（超限时展示给访客）</label>
          <input id="st-contact" value="${esc(settings.quota_contact)}" placeholder="https://github.com/01men/kizuna/issues/new 或 mailto:you@example.com"></div>
      </div>
      <p class="error" id="st-err" hidden></p>
      <div class="form-actions"><button class="btn primary" id="st-save">保存</button></div>
    </div>
  </div>
  <div class="panel">
    <div class="panel-head">Hub 地址与令牌</div>
    <dl class="kv">
      <dt>Hub 地址</dt><dd class="mono">${esc(location.origin)}</dd>
      <dt>安装提示词内嵌地址</dt><dd class="mono">${esc(location.origin)}（生产环境请以 HTTPS 域名反代后访问）</dd>
      <dt>管理员令牌</dt><dd class="mono">${esc(mask(adminToken))} <span class="muted">（存于浏览器 localStorage）</span></dd>
    </dl>
  </div>`;

  $('#st-save').onclick = async () => {
    const errEl = $('#st-err');
    errEl.hidden = true;
    try {
      const ladder = $('#st-ladder').value.split(/[,，]/).map((x) => parseFloat(x.trim()) * 60).filter((x) => Number.isFinite(x) && x > 0);
      if (!ladder.length) throw new Error('重试梯度不能为空');
      const body = {
        retry_ladder_s: ladder,
        ack_timeout_s: Number($('#st-ack').value),
        delivery_concurrency: Number($('#st-conc').value),
        jitter_s: Number($('#st-jitter').value),
        heartbeat_window_s: Number($('#st-hb').value),
        audit_retention_days: Number($('#st-retain').value),
        content_minimized: $('#st-min').value === 'true',
      };
      body.public_install_per_minute = Number($('#st-install-rate').value);
      body.demo_per_minute = Number($('#st-demo-rate').value);
      body.rate_limit_allowlist = $('#st-allow').value.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
      body.quota_contact = $('#st-contact').value.trim();
      await api('/api/v1/settings', { method: 'PUT', body });
      toast('已保存，立即生效');
    } catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
  };
}

function mask(token) {
  if (!token) return '—';
  if (token.length <= 10) return token.slice(0, 4) + '…';
  return token.slice(0, 8) + '…' + token.slice(-4);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

(async function boot() {
  if (!adminToken) { showLogin(); return; }
  try {
    await api('/api/v1/settings');
    showShell();
    route();
  } catch (err) {
    if (err.status === 401) return; // onUnauthorized 已处理
    showShell();
    route();
  }
})();
