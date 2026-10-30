export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const err = {
  unauthorized: (msg = '令牌缺失或无效') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = '权限不足') => new AppError(403, 'FORBIDDEN', msg),
  agentNotFound: (id: string) => new AppError(404, 'AGENT_NOT_FOUND', `Agent 不存在: ${id}`),
  cardNotFound: (id: string) => new AppError(404, 'AGENT_CARD_NOT_FOUND', `Agent ${id} 未发布 agent_card`),
  taskNotFound: (id: string) => new AppError(404, 'TASK_NOT_FOUND', `任务不存在: ${id}`),
  agentConflict: (id: string) => new AppError(409, 'AGENT_CONFLICT', `编号已被占用: ${id}`),
  tokenUsed: () => new AppError(410, 'ENROLL_TOKEN_USED', '一次性注册令牌已被使用'),
  tokenExpired: () => new AppError(410, 'ENROLL_TOKEN_EXPIRED', '一次性注册令牌已过期'),
  targetDisabled: (id: string) => new AppError(422, 'TARGET_DISABLED', `目标 Agent 已停用: ${id}`),
  validation: (msg: string, details?: unknown) => new AppError(422, 'VALIDATION_FAILED', msg, details),
  rateLimited: (msg = '请求过于频繁，请稍后再试') => new AppError(429, 'RATE_LIMITED', msg),
  internal: (msg = '服务内部错误') => new AppError(500, 'INTERNAL', msg),
};
