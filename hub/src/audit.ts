import crypto from 'node:crypto';
import type { DB } from './db.js';
import { newAuditId } from './ids.js';
import { getSettings } from './settings.js';

export type AuditOutcome = 'delivered_confirmed' | 'delivery_failed' | 'invalid_target' | 'cancelled';

export interface AttemptSnapshot {
  n: number;
  attempted_at: string;
  outcome: string;
  http_status?: number | null;
  latency_ms?: number | null;
  detail?: string | null;
}

export interface QueuedTaskRow {
  task_id: string;
  from_agent: string;
  to_agent: string;
  title: string | null;
  content: string;
  format: string;
  priority: string;
  deadline: string | null;
  status: string;
  attempt_count: number;
  next_action_at: string | null;
  created_at: string;
}

export interface FinalizeInput {
  task: QueuedTaskRow;
  outcome: AuditOutcome;
  attempts: AttemptSnapshot[];
  /** 附加说明（目标无效原因等） */
  reason?: string;
  /** 演示沙箱产生的记录（管理台默认过滤，保持审计视图纯净） */
  isDemo?: boolean;
}

/**
 * 留痕唯一写入口：只增不改不删。终态任务出队时由各调用方在事务内调用。
 * 内容最小化开启时只写内容 SHA-256 摘要，不写标题。
 */
export function writeAudit(db: DB, input: FinalizeInput): string {
  const { task, outcome, attempts } = input;
  const settings = getSettings(db);
  const digest = crypto.createHash('sha256').update(task.content).digest('hex');
  const noteParts: string[] = [];
  if (!settings.content_minimized && task.title) noteParts.push(`title: ${task.title}`);
  if (input.reason) noteParts.push(input.reason);
  const logId = newAuditId();
  db.prepare(
    `INSERT INTO audit_logs
       (log_id, task_id, from_agent, to_agent, enqueued_at, dequeued_at, outcome,
        attempt_count, attempts_json, content_digest, note, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    logId,
    task.task_id,
    task.from_agent,
    task.to_agent,
    task.created_at,
    new Date().toISOString(),
    outcome,
    attempts.length,
    JSON.stringify(attempts),
    digest,
    noteParts.length ? noteParts.join(' | ') : null,
    input.isDemo ? 1 : 0,
  );
  return logId;
}

/** 终态出队（同一事务：写留痕 → 删任务行 → 删尝试明细） */
export function dequeueAndAudit(db: DB, input: FinalizeInput): string {
  let logId = '';
  db.transaction(() => {
    logId = writeAudit(db, input);
    db.prepare('DELETE FROM tasks WHERE task_id = ?').run(input.task.task_id);
    db.prepare('DELETE FROM task_attempts WHERE task_id = ?').run(input.task.task_id);
  });
  return logId;
}
