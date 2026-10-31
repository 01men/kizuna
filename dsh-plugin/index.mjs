/**
 * kizuna DSH plugin —— 让 DSH 会话里的 Agent 直接读自己的 Kizuna 信箱并回信。
 *
 * 设计约束（刻意为之，不要轻易改）：
 * - **零外部依赖**：不 import `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis`。
 *   npm 上的 `@deepseek-ai/dsh-tools` 最新版是 0.0.1-rc.1，而 profile 内置的是 0.2.1-rc.5，
 *   声明依赖会在安装期拉错版本。工具定义按原生 ToolRuntime 的契约手写（name / description /
 *   parameters / output{schema,render} / execute），与 DSH 内置插件同形。
 * - **不持有任何凭证**：只连本机信箱 `http://127.0.0.1:7788`（loopback，无需令牌）。
 *   回传结果由 box 用自身 agent_token 转发 Hub，插件侧不碰 Hub 令牌。
 *
 * 覆盖面：信箱状态 / 待处理信件列表 / 读一封信 / 回信（含 state 三分类）。
 * 语义边界：插件只管「信箱」这一段（收信 → 回信），不代替 Hub 的通讯录检索与任务投递
 * （那两项需要 Hub 侧身份，属另一条链路）。
 */

const DEFAULT_BOX_URL = 'http://127.0.0.1:7788'
const REQUEST_TIMEOUT_MS = 15_000

export const name = 'kizuna-letterbox'
export const inject = ['tools']

/** 解析信箱地址：patch 配置 > 环境变量 > 默认本机回环地址。 */
function resolveBoxUrl(config) {
  const raw = config?.boxUrl ?? process.env.KIZUNA_BOX_URL ?? DEFAULT_BOX_URL
  return String(raw).replace(/\/+$/, '')
}

/** 调本机 box；非 2xx 一律抛出可读错误（DSH 会把 message 呈现给模型）。 */
async function callBox(base, path, init) {
  const method = init?.method ?? 'GET'
  let res
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
      ...(init?.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`本机 Kizuna 信箱不可达（${base}${path}）：${String(e).slice(0, 160)}。请确认 kizuna-box 进程在运行。`)
  }
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { raw: text.slice(0, 500) }
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.message ?? text.slice(0, 300)
    throw new Error(`Kizuna 信箱 ${method} ${path} 返回 HTTP ${res.status}：${msg}`)
  }
  return data
}

/** 把信箱原始信件压成模型可读的摘要（正文另走 kizuna_read_letter 单独取）。 */
function summarizeLetter(letter) {
  return {
    task_id: letter.task_id,
    title: letter.content?.title ?? '',
    from: letter.from ? `${letter.from.name ?? ''}（${letter.from.agent_id ?? ''}）`.trim() : '',
    priority: letter.content?.priority ?? null,
    received_at: letter.received_at ?? null,
  }
}

export function apply(ctx, config) {
  const base = resolveBoxUrl(config)

  ctx.tools.register({
    name: 'kizuna_letterbox_status',
    description: '查看本机 Kizuna 信箱状态：agent_id、Hub 地址、待处理信件数、box 版本。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          agent_id: { type: 'string', required: false },
          hub: { type: 'string', required: false },
          version: { type: 'string', required: false },
          pending: { type: 'number', required: false },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const health = await callBox(base, '/healthz')
      let pending = null
      try {
        const list = await callBox(base, '/tasks/pending')
        pending = typeof list?.total === 'number' ? list.total : (Array.isArray(list?.items) ? list.items.length : null)
      } catch {
        pending = null
      }
      return {
        ok: health?.ok === true,
        agent_id: health?.agent_id ?? null,
        hub: health?.hub ?? null,
        version: health?.version ?? null,
        pending,
      }
    },
  })

  ctx.tools.register({
    name: 'kizuna_list_letters',
    description: '列出本机 Kizuna 信箱中待处理（未回信）的信件：任务号、标题、发件方、收信时间。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          letters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                task_id: { type: 'string', required: true },
                title: { type: 'string', required: false },
                from: { type: 'string', required: false },
                priority: { type: 'string', required: false },
                received_at: { type: 'string', required: false },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const list = await callBox(base, '/tasks/pending')
      const items = Array.isArray(list?.items) ? list.items : []
      return { total: typeof list?.total === 'number' ? list.total : items.length, letters: items.map(summarizeLetter) }
    },
  })

  ctx.tools.register({
    name: 'kizuna_read_letter',
    description: '按任务号读取一封 Kizuna 信件的完整正文（发件方、标题、正文全文）。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          required: true,
          description: '信件任务号，例如 T-20261031-QDD8ZZ。',
        },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          from: { type: 'string', required: false },
          title: { type: 'string', required: false },
          body: { type: 'string', required: false },
          received_at: { type: 'string', required: false },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const taskId = String(args?.task_id ?? '').trim()
      if (!taskId) throw new Error('缺少 task_id')
      const letter = await callBox(base, `/tasks/${encodeURIComponent(taskId)}`)
      return {
        task_id: letter?.task_id ?? taskId,
        from: letter?.from ? `${letter.from.name ?? ''}（${letter.from.agent_id ?? ''}）`.trim() : '',
        title: letter?.content?.title ?? '',
        body: letter?.content?.body ?? '',
        received_at: letter?.received_at ?? null,
      }
    },
  })

  ctx.tools.register({
    name: 'kizuna_reply_letter',
    description:
      '回一封 Kizuna 信件：把处理结论写回发起方。state=completed 表示已完成（Hub 自动给发起方回执），failed 表示失败，input-required 表示缺输入需追问，working 表示进行中（不回执）。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', required: true, description: '要回应的信件任务号。' },
        message: { type: 'string', required: true, description: '回复正文（执行结论、证据链接、遗留项）。' },
        state: {
          type: 'string',
          required: false,
          enum: ['completed', 'failed', 'input-required', 'working'],
          description: '回执状态，默认 completed。',
        },
      },
      required: ['task_id', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          task_id: { type: 'string', required: true },
          state: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const taskId = String(args?.task_id ?? '').trim()
      const message = String(args?.message ?? '').trim()
      const state = String(args?.state ?? 'completed').trim() || 'completed'
      if (!taskId) throw new Error('缺少 task_id')
      if (!message) throw new Error('缺少 message（回信正文不能为空）')
      const allowed = ['completed', 'failed', 'input-required', 'working']
      if (!allowed.includes(state)) throw new Error(`state 只能是 ${allowed.join(' / ')}`)
      await callBox(base, `/tasks/${encodeURIComponent(taskId)}/result`, {
        method: 'POST',
        body: JSON.stringify({ state, message }),
      })
      return { ok: true, task_id: taskId, state }
    },
  })
}
