# 03 · API 规范

> 产品：Kizuna · Agent 通讯录· 版本 v0.2（A2A-ready）· 2026-10-30
> 依赖：02-技术架构设计（数据模型/状态机/签名密钥）
> v0.2 变更：`content.format=json` 透传 A2A Message/Task；`agent_card` 与 `/.well-known/agent-card.json`；结果回传 API（v1.1 提前实现）

## 0. 通用约定

- **Base URL**：Hub `https://<hub-host>:7700`；端侧本地 API `http://127.0.0.1:7788`。
- **鉴权**：
  - 管理端：`Authorization: Bearer <admin_token>`；
  - Agent 端：`Authorization: Bearer <agent_token>`（`from` 一律从令牌解出，不由请求体声明，防伪造）；
  - 安装/注册：一次性 `enroll_token`（query 或 body 携带）。
- **时间**：一律 UTC ISO8601（如 `2026-10-29T08:00:00Z`）。
- **错误体**：`{"error":{"code":"AGENT_NOT_FOUND","message":"...","details":{}}}`。
- **分页**：`?limit=50&offset=0`，响应带 `total`。

## 1. 路由字典（Agent 注册与心跳）

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/agents` | Admin / Enroll | 注册 Agent（四要素 + 可选 `agent_card`） |
| `GET /api/v1/agents?q=&tag=&status=` | Admin / Agent | 列表 + 能力检索 |
| `GET /api/v1/agents/{agent_id}` | Admin / Agent | 详情 |
| `PATCH /api/v1/agents/{agent_id}` | Admin | 更新名称/能力声明/webhook/启停/`agent_card`（对象=发布，null=撤卡） |
| `DELETE /api/v1/agents/{agent_id}` | Admin | 注销（在途任务照常走重试/留痕） |
| `POST /api/v1/heartbeat` | Agent | 端侧心跳（60s 一次），刷新在线状态 |

**A2A 注册表（公开，无需鉴权）**：

| 路径 | 说明 |
| --- | --- |
| `GET /.well-known/agent-card.json` | Hub 自身 Agent Card（含 `kizuna` 非标扩展：入队/目录/回传端点） |
| `GET /.well-known/agent-card.json?agent=<id>` | 指定 Agent 已发布的卡片 |
| `GET /api/v1/agents/{agent_id}/agent-card.json` | 同上（RESTful 别名） |

`agent_card` 为 A2A Agent Card 格式 JSON 对象，最小约束：`name` 必填字符串、整体 ≤64KB，其余字段原样存储（不设障于规格演进）。未发布 → `404 AGENT_CARD_NOT_FOUND`。

**注册请求/响应示例**：

```json
// POST /api/v1/agents
{
  "agent_id": "A-9X2M",          // 可省略 → 系统自动分配
  "name": "单证预审 Agent",
  "capabilities": "报关单证预审、信用证要素核对",
  "capability_tags": ["单证", "预审"],
  "webhook_url": "http://192.168.1.20:7788"
}
// 201
{
  "agent_id": "A-9X2M",
  "agent_token": "at_....",       // 请妥善保存，仅此一次返回
  "endpoint_secret": "es_...."    // 校验 Hub 投递签名用
}
```

**规则**：`agent_id` 冲突 → `409 AGENT_CONFLICT`；`enabled=0` 时新任务指向它 → `422 TARGET_DISABLED`。

## 2. 任务 API（任务包）

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/tasks` | Agent / Admin | 提交任务包（入队） |
| `GET /api/v1/tasks?status=&from=&to=` | Admin / Agent | 队列查询（Agent 仅可见自己相关） |
| `GET /api/v1/tasks/{task_id}` | Admin / Agent | 任务详情（含逐次尝试明细） |
| `POST /api/v1/tasks/{task_id}/retry` | Admin | 立即重投（next_action_at=now） |
| `POST /api/v1/tasks/{task_id}/cancel` | Admin | 人工取消（出队 + 留痕 `cancelled`） |

**提交任务包**（三要素：来自谁=令牌、任务内容、给谁）：

```json
// POST /api/v1/tasks
{
  "to": "A-9X2M",
  "content": {
    "title": "预审 T25JH142 报关单",
    "body": "请核对附件报关单与信用证要素……",
    "format": "text",
    "priority": "normal",
    "deadline": null
  }
}
// 202
{ "task_id": "T-20261029-0F3K9A", "status": "queued", "enqueued_at": "2026-10-29T08:00:00Z" }
```

**A2A 透传（v0.1）**：`format=json` 时 `body` 允许直接携带 A2A Message/Task 等对象（此时 format 强制为 `json`），Hub 不解释、不改造，**原样透传到端侧**；内容序列化后 ≤512KB。

**结果回传（v1.1 提前实现）**——接收方在签收后回报任务进展，借鉴 A2A 三分类：

| 分类 | state | 说明 |
| --- | --- | --- |
| 进行中 | `working` | 处理中（仅记录留痕，不回执） |
| 中断 | `input-required` | 等待输入（仅记录留痕，不回执） |
| 终态 | `completed` / `failed` / `canceled` | 记录留痕 + **自动生成回执信件发回发起方**（format=json、`kind:"kizuna.task-result"`、`reply_to` 指向原任务；`suppress_reply:true` 可抑制） |

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/tasks/{task_id}/result` | 接收方 Agent / Admin | 回传结果；仅「已签收」任务可回传（未签收 → `422`）；非接收方 → `403` |
| `GET /api/v1/tasks/{task_id}/result` | 双方 / Admin | 结果历史（状态、message、result、摘要、回执去向、时间） |

端侧等价入口：`POST http://127.0.0.1:7788/tasks/{task_id}/result`（回环，kizuna-box 以自身令牌转发 Hub）。

**错误**：`404 AGENT_NOT_FOUND`（目标编号不存在——任务不入队，直接返回错误并留痕 `invalid_target` 可选开启）；`422 TARGET_DISABLED`；`429 RATE_LIMITED`。

## 3. 投递协议（Hub → 端侧，核心）

```
POST {webhook_url}/kizuna/deliver
Content-Type: application/json
X-Kizuna-Task-Id: T-20261029-0F3K9A
X-Kizuna-Timestamp: 2026-10-29T08:00:03Z
X-Kizuna-Signature: sha256=<HMAC-SHA256(endpoint_secret, timestamp + "." + rawBody)>
X-Kizuna-Attempt: 2
```

```json
{
  "task_id": "T-20261029-0F3K9A",
  "from": { "agent_id": "A-1C4D", "name": "DSH 主会话" },
  "content": { "title": "...", "body": "...", "format": "text", "priority": "normal", "deadline": null },
  "meta": { "attempt": 2, "enqueued_at": "2026-10-29T08:00:00Z", "hub": "https://hub.example.com:7700" }
}
```

**回执（接收状态信息）要求**：端侧在 **10s 内**返回：

```
200 {"status":"received","task_id":"T-20261029-0F3K9A","received_at":"..."}
```

**判定规则表**（Hub 视角，逐次尝试记录 `outcome`）：

| 端侧行为 | 判定 | 后续 |
| --- | --- | --- |
| 2xx 且 `task_id` 一致 | `ack` ✅ | 出队删除 + 留痕 `delivered_confirmed` |
| 2xx 但 `task_id` 缺失/不一致 | `bad_ack` ❌ | 进入重试梯度 |
| 4xx / 5xx | `http_4xx` / `http_5xx` ❌ | 进入重试梯度 |
| 连接失败 / DNS 失败 | `network_error` ❌ | 进入重试梯度 |
| 超时（连接 5s / 整体 10s） | `timeout` ❌ | 进入重试梯度 |
| 签名校验失败被端侧 401 拒绝 | `invalid_signature` ❌ | 进入重试梯度 + Hub 侧告警日志 |

> 超时的特殊性：端侧可能已落盘但回执丢失。重试时端侧以 `task_id` 幂等去重，返回同一回执即可，不会产生重复信件（02 §7）。

## 4. 端侧本地 API（Kizuna Box，仅 127.0.0.1:7788）

供**本机 Agent-B** 读取信箱，回环访问、无需令牌：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /healthz` | `{"ok":true,"agent_id":"A-9X2M","hub":"...","spool":2,"uptime_s":3600}` |
| `GET /tasks/pending` | 列出未取走的信件（spool 中的任务包） |
| `GET /tasks/{task_id}` | 单封信件详情 |
| `POST /tasks/{task_id}/complete` | 本机 Agent 标记已取走/已处理（可选，仅影响本地展示，不影响 Hub 留痕） |

> 交付端口与本地端口：`webhook_url` 指向端侧的**交付监听**（默认同为 7788，路径 `/kizuna/deliver`，强制验签）；本地 API 仅绑定回环地址。两者同端口分流亦可（按路径区分），默认配置即同端口。

## 5. 安装服务 API（Hub 提供）

| 方法与路径 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/v1/enroll-tokens` | Admin | 为预填的 Agent 信息签发一次性令牌（默认 10 分钟有效） |
| `GET /install/prompt?token=` | Enroll | 返回**安装提示词**文本（占位符已自动填充，见 04 §3） |
| `GET /install/linux.sh?token=` | Enroll | Linux 一键安装脚本 |
| `GET /install/macos.sh?token=` | Enroll | macOS 一键安装脚本 |
| `GET /install/windows.ps1?token=` | Enroll | Windows 一键安装脚本 |
| `GET /install/termux.sh?token=` | Enroll | Android(Termux) 一键安装脚本 |
| `POST /api/v1/enroll` | Enroll | 安装脚本回调：用一次性令牌换取正式 `agent_token`/`endpoint_secret`，回填 webhook，令牌即作废 |

**心跳约定**：端侧每 60s `POST /api/v1/heartbeat`（Bearer agent_token）；Hub 将 `last_seen_at` 之前 5 分钟内有心跳的 Agent 标记 `online`，否则 `offline`。心跳仅作状态展示，不阻断投递。

## 6. 签名算法（HMAC-SHA256）

```
string_to_sign = X-Kizuna-Timestamp + "." + raw_request_body
X-Kizuna-Signature = "sha256=" + hex( HMAC_SHA256( endpoint_secret, string_to_sign ) )
```

端侧校验：时间戳与本地时间差 ≤ 300s（防重放）；重算签名恒等比较。

```js
// Node 端侧校验示例
const crypto = require('node:crypto');
function verify(secret, timestamp, rawBody, sigHex) {
  const expect = crypto.createHmac('sha256', secret)
    .update(timestamp + '.' + rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sigHex));
}
```

## 7. 错误码表

| HTTP | code | 场景 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 令牌缺失/无效 |
| 403 | `FORBIDDEN` | 权限不足（如 Agent 查他人任务、非接收方回传结果） |
| 404 | `AGENT_NOT_FOUND` / `TASK_NOT_FOUND` / `AGENT_CARD_NOT_FOUND` | 编号/任务不存在 / 卡片未发布 |
| 409 | `AGENT_CONFLICT` | 注册编号冲突 |
| 410 | `ENROLL_TOKEN_USED` / `ENROLL_TOKEN_EXPIRED` | 一次性令牌已用/过期 |
| 422 | `TARGET_DISABLED` / `VALIDATION_FAILED` | 目标停用 / 字段校验失败（含未签收即回传结果） |
| 429 | `RATE_LIMITED` | 限流 |
| 500 | `INTERNAL` | 服务端错误（重试安全） |
