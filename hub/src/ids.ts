import crypto from 'node:crypto';

/** 去掉易混淆字符（I/L/O/U）的字母数字表 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function rand(n: number): string {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

function yyyymmdd(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 任务号：T-YYYYMMDD-XXXXXX */
export function newTaskId(): string {
  return `T-${yyyymmdd()}-${rand(6)}`;
}

/** 留痕号：AL-YYYYMMDD-XXXXXX */
export function newAuditId(): string {
  return `AL-${yyyymmdd()}-${rand(6)}`;
}

/** Agent 编号：A-XXXX（自动分配） */
export function newAgentId(): string {
  return `A-${rand(4)}`;
}

export function newAgentToken(): string {
  return 'at_' + crypto.randomBytes(24).toString('hex');
}

export function newEndpointSecret(): string {
  return 'es_' + crypto.randomBytes(24).toString('hex');
}

export function newEnrollToken(): string {
  return 'et_' + crypto.randomBytes(24).toString('hex');
}

/** 编号/任务号等对外标识的合法性（防路径注入） */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
