import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { rateLimit, normalizeIp, isAllowlisted } from './auth.js';

/**
 * 对外公开端点（公开安装 / 演示沙箱）的配额闸门：
 *  - 每 IP 每分钟限额（settings 可调，默认 10）；
 *  - 白名单（IP/CIDR）完全豁免，供社区机器人、官方巡检、自有固定出口使用；
 *  - 超限时返回 429，并在 details 里给出提额入口，访客知道下一步怎么做。
 */
export function enforcePublicQuota(
  fastify: FastifyInstance,
  limitPerMinute: number,
  allowlist: string[],
  peerIpRaw: string,
  bucket: string,
): void {
  const peer = normalizeIp(peerIpRaw);
  if (isAllowlisted(peer, allowlist)) return;
  try {
    rateLimit(`${bucket}:${peer}`, limitPerMinute);
  } catch (e) {
    if (e instanceof AppError && e.code === 'RATE_LIMITED') {
      const resetIn = (e as AppError & { resetInSeconds?: number }).resetInSeconds ?? 60;
      fastify.log.info({ bucket, peer, limit: limitPerMinute }, 'public quota exceeded');
      throw new AppError(429, 'RATE_LIMITED', `请求过于频繁：每人每分钟最多 ${limitPerMinute} 次`, {
        limit_per_minute: limitPerMinute,
        reset_in_seconds: resetIn,
        allowlist_hint: '服务端白名单可完全豁免（管理员在「设置」页维护 IP/CIDR）',
      });
    }
    throw e;
  }
}