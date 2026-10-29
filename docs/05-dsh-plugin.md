# 05 · DSH 插件与管理界面设计

> 产品：Kizuna · Agent 通讯录· 版本 v0.1 · 2026-10-29
> 上游：01-PRD（FR-7 / FR-8）· 03-API规范
> 执行规范：**必须**严格遵循团队《DSH 插件开发提示词 · 原生页面左右布局》规范，该文档的硬约束、版式、验收条款全部适用，本文不重复其通用规则，只给出本插件的业务填充与数据层设计。

## 1. 双形态总览

管理界面有两个入口，**共用同一套 Hub API 与信息架构**：

| 形态 | 载体 | 登录态 | 版本 |
| --- | --- | --- | --- |
| **Web 管理台** | Hub 同源 `https://<hub>:7700/admin`（静态页） | 管理员令牌 | v0.1 |
| **DSH 插件面板** | DSH 侧栏一级入口 + 整页主面板 | 凭据存于 DSH Host 半边 | v0.2 |

实现策略：信息架构、词典（zh/en）、API 调用层一次设计；插件形态优先落地（用户核心诉求是「内嵌 DSH 一级交互面板」），Web 管理台复用同一套页面组件逻辑。

## 2. 信息架构（六个一级页面）

```
┌────────────┬──────────────────────────────────────────────┐
│ 左列 240px  │ 右列内容区                                    │
├────────────┼──────────────────────────────────────────────┤
│ ▍总览       │ 在线/离线 Agent 数、队列深度、今日签收/失败、  │
│  通讯录     │ 重试中任务数（卡片）+ 最近留痕 10 条           │
│  任务队列   │                                              │
│  投递留痕   │                                              │
│  安装部署   │                                              │
│  设置       │                                              │
└────────────┴──────────────────────────────────────────────┘
```

| 页面 | 功能要点 | 状态设计（加载/空/错误按宿主规范） |
| --- | --- | --- |
| **总览** | 指标卡片（在线 Agent、队列深度、今日已签收、今日投递失败、重试中）；最近留痕速览 | 骨架条；错误一句话 + 重试 |
| **通讯录** | Agent 列表（编号/名称/能力标签/webhook/在线状态/启停）；新建与编辑（四要素表单）；能力关键词检索；详情页显示该 Agent 近期收发 | 空态 = 「注册第一个 Agent」主按钮 |
| **任务队列** | 在途任务列表（任务号/来自/给谁/状态/已试次数/下次投递时间）；详情含逐次尝试明细；操作：立即重投、取消（二次确认） | 空态 = 「队列已清空」说明文案 |
| **投递留痕** | 留痕列表（时间/任务号/给谁/传递状态/尝试次数）；状态筛选（已签收/投递失败/目标无效/已取消）；详情 = 完整尝试历史时间线；导出 JSONL/CSV | 只读，无删除入口（留痕不可删） |
| **安装部署** | ①填四要素 → ②生成一次性安装提示词（一键复制，含 HUB/ENROLL_TOKEN）→ ③平台矩阵说明（Linux/mac/Win/Termux 可用；鸿蒙显示限制与替代路径） | 令牌生成后倒计时 10 分钟 |
| **设置** | 重试梯度配置（默认 3/10/30/60/120min）、回执超时、投递并发、留痕保留期、内容最小化开关、Hub 地址与令牌管理（仅 Web 台） | 保存即生效，留痕每次变更 |

## 3. Web 管理台

- 挂载：Hub 进程内静态托管 `/admin`（与 API 同源，无 CORS 负担）；
- 登录：管理员令牌输入 → 存 localStorage（仅 HTTPS 环境提示安全）；
- 技术：与插件同一套页面组件形态（无构建器的轻量实现或与插件同构的 React 形态，实现阶段二选一并固定）。

## 4. DSH 插件设计

### 4.1 §0 业务信息填充表（可直接填入《DSH 插件开发提示词》§0 开工）

| 字段 | 值 |
| --- | --- |
| 插件包名 | `@local/agent-directory` |
| 包目录 | `./dsh-plugin` |
| 侧栏显示名 | 中文：`Kizuna`；英文：`Agent Directory` |
| 侧栏图标 | 通讯录/联系人卡片 + 信号波纹（自绘 SVG，viewBox 0 0 20 20） |
| 一句话描述 | 中文：`Agent 通讯录与任务可靠投递`；英文：`Agent directory with reliable task relay` |
| 左列内容 | `总览 / 通讯录 / 任务队列 / 投递留痕 / 安装部署 / 设置` |
| 右列内容 | 所选导航对应的 §2 页面主体（卡片列表 + 详情） |
| 数据来源 | 调用已有 remote 方法（Host 半边 `index.js` 注册 `agentDirectory` 服务，代理 Hub REST） |

挂载参数：`PANEL_ID = 'agent-directory'`、词典命名空间 `NS = 'agent-directory'`、侧栏 `order = 20`（与官方入口错开；若产品要求更靠前可下调，但不得插入官方入口之间）。

### 4.2 数据层（Host 半边代理，规避 CORS 与凭据暴露）

`index.js` 的 `apply(ctx)` 注册 `agentDirectory` 服务，持有 `hub_url + admin_token`（存 Host 侧配置，不进浏览器）；`client.js` 经 `ctx.remote.agentDirectory.*` 调用：

```js
// Host 半边方法清单（与 03-API 一一对应）
agentDirectory.overview()                        // 总览指标
agentDirectory.listAgents({ q?, tag?, status? }) // 通讯录列表/检索
agentDirectory.upsertAgent(agent)                // 注册/编辑
agentDirectory.setAgentEnabled(agentId, enabled) // 启停
agentDirectory.removeAgent(agentId)              // 注销
agentDirectory.listTasks({ status?, from?, to? })// 队列
agentDirectory.getTask(taskId)                   // 详情（含尝试明细）
agentDirectory.retryTask(taskId)                 // 立即重投
agentDirectory.cancelTask(taskId)                // 取消（出队+留痕）
agentDirectory.listAudit({ outcome?, from?, to? })// 留痕
agentDirectory.exportAudit(filter)               // 导出
agentDirectory.createEnrollToken(agentDraft)     // 生成安装提示词所需的令牌
agentDirectory.getInstallPrompt(token)           // 提示词文本
agentDirectory.getSettings() / setSettings(s)    // 重试梯度等配置
```

**硬性要求**：失败必须把原因显示在页面上（错误态 + 重试按钮），不吞异常；Hub 不可达属于一等错误态（设置页引导检查 hub_url/令牌）。

### 4.3 locale 词典骨架

```json
// locale/zh.json（en.json 同构翻译）
{
  "meta": { "title": "Kizuna", "description": "Agent 通讯录与任务可靠投递" },
  "panel": "Kizuna",
  "title": "Kizuna",
  "intro": "登记 Agent、可靠投递任务包、全程留痕",
  "nav": { "overview": "总览", "agents": "通讯录", "queue": "任务队列",
           "audit": "投递留痕", "install": "安装部署", "settings": "设置" },
  "status": { "delivered_confirmed": "已签收", "delivery_failed": "投递失败",
              "invalid_target": "目标无效", "cancelled": "已取消" },
  "empty": { "title": "暂无内容", "action": "注册第一个 Agent" }
}
```

### 4.4 约束与验收引用

- 硬约束（禁 iframe/第二份 React/字面量颜色/硬编码文案等）：规范 §1、§8 全部适用；
- 版式（页面外壳/页头/左右分栏/卡片行样式/token 白名单）：规范 §4 全部适用；
- 可访问性（focus ring、aria-label、reduced-motion、三态齐全）：规范 §5 全部适用；
- 验收：规范 §9 逐项执行（安装前 `node --check` 与 exports 检查；安装后侧栏入口、整页切换、三档宽度、深浅色、控制台无报错、三态、双语），交付说明按规范 §10。

## 5. 关键页面线框（任务队列详情为例）

```
┌─ 任务队列 ───────────────────────────────────────────────┐
│ [状态▾ 全部] [搜索任务号]                    [刷新]        │
│ ──────────────────────────────────────────────────────── │
│ ● T-20261029-0F3K9A  → A-9X2M 单证预审    重试中(3/6)     │
│   来自 A-1C4D · 下次投递 08:43      [立即重投] [取消]      │
│ ● T-20261029-0C2H1B  → A-5T7Y 报告生成    已签收          │
│ ──────────────────────────────────────────────────────── │
│ 详情：T-20261029-0F3K9A                                  │
│  尝试历史（时间线）                                        │
│  ① 08:00:03  timeout（10s 超时）                          │
│  ② 08:03:05  http_5xx（502）                              │
│  ③ 08:13:07  待执行 ← 下次                                │
│  传递状态：重试中 · 入队 08:00:00 · 梯度 3/10/30/60/120min │
└──────────────────────────────────────────────────────────┘
```

## 6. 验收清单（本插件专项）

- [ ] `install_bundle` 安装后，DSH 左侧栏出现「Kizuna」一级入口，点击整页切换、与「插件」页互不残留；
- [ ] 六个页面在 1440/1080/900px 三档宽度不溢出不重叠，深浅色均正常；
- [ ] Hub 停机时各页进入错误态并给出原因（不白屏、不吞异常）；
- [ ] 通讯录新建 → 队列可见任务 → 留痕可见终态，全链路在插件内闭环；
- [ ] 安装部署页一键复制的提示词粘贴到目标机 Agent 可一次成功（对 04 §6 验收）；
- [ ] 中英文切换无残留；控制台无 slot 报错。
