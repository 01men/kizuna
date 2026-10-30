import crypto from 'node:crypto';
import type { DB } from './db.js';
import { err } from './errors.js';
import { findAgent } from './registry.js';
import { newTaskId } from './ids.js';

/** A2A 三分类：进行中 / 中断 / 终态 */
export const RESULT_STATES: Record<string, 'in_progress' | 'interrupted' | 'terminal'> = {
  working: 'in_progress',
  'input-required': 'interrupted',
  completed: 'terminal',
  failed: 'terminal',
  canceled: 'terminal',
};

export interface DeliveredAudit {
  task_id: string;
  from_agent: string;
  to_agent: string;
}

/** 该任务是否已签收（只有签收后才允许回传结果） */
export function deliveredAuditOf(db: DB, taskId: string): DeliveredAudit | undefined {
  return db
    .prepare(
      `SELECT task_id, from_agent, to_agent FROM audit_logs
       WHERE task_id = ? AND outcome = 'delivered_confirmed' ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as DeliveredAudit | undefined;
}

export interface ReportResultInput {
  taskId: string;
  state: string;
  message?: string | null;
  result?: unknown;
  /** 回传方（接收方 agent_id 或 admin） */
  reportedBy: string;
  suppressReply?: boolean;
  /** 调用方已查过签收记录时可传入，省一次查询 */
  audit?: DeliveredAudit;
}

export interface ReportResultOutput {
  state: string;
  category: 'in_progress' | 'interrupted' | 'terminal';
  recorded_at: string;
  relayed: { task_id: string; to: string } | null;
}

/**
 * 结果回传的唯一写入口（Hub API 与演示沙箱共用）。
 * 终态默认自动生成一条 json 回执信件发回发起方（reply_to 串联原任务）。
 */
export function reportResult(db: DB, input: ReportResultInput): ReportResultOutput {
  const category = RESULT_STATES[input.state];
  if (!category) {
    throw err.validation(`state 必须是 ${Object.keys(RESULT_STATES).join(' / ')}（进行中/中断/终态三分类）`);
  }
  const message = input.message == null ? null : String(input.message);
  if (message && message.length > 4000) throw err.validation('message 过长（≤4000）');

  let resultJson: string | null = null;
  if (input.result !== undefined && input.result !== null) {
    resultJson = JSON.stringify(input.result);
    if (Buffer.byteLength(resultJson) > 256 * 1024) throw err.validation('result 过大（序列化后 ≤256KB）');
  }

  const audit = input.audit ?? deliveredAuditOf(db, input.taskId);
  if (!audit) throw err.validation('任务尚未签收或不存在，不能回传结果');

  let relayed: { task_id: string; to: string } | null = null;
  const reportedAt = new Date().toISOString();
  if (category === 'terminal' && input.suppressReply !== true) {
    relayed = enqueueReplyLetter(db, {
      originalTaskId: input.taskId,
      state: input.state,
      message,
      result: input.result,
      audit,
      reportedAt,
    });
  }

  const digest = crypto.createHash('sha256').update(resultJson ?? '').digest('hex');
  db.prepare(
    `INSERT INTO task_results (task_id, reported_by, state, category, message, result_json, content_digest, relayed_to, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.taskId, input.reportedBy, input.state, category, message, resultJson, digest, relayed?.task_id ?? null, reportedAt);

  return { state: input.state, category, recorded_at: reportedAt, relayed };
}

interface ReplyInput {
  originalTaskId: string;
  state: string;
  message: string | null;
  result: unknown;
  audit: DeliveredAudit;
  reportedAt: string;
}

/** 终态回执：以接收方身份给发起方寄一封 json 信件（复用全部投递/重试/留痕机制） */
function enqueueReplyLetter(db: DB, input: ReplyInput): { task_id: string; to: string } | null {
  const sender = findAgent(db, input.audit.from_agent);
  if (!sender || sender.enabled !== 1) return null;

  let replyTaskId = newTaskId();
  while (db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(replyTaskId)) replyTaskId = newTaskId();

  const content = JSON.stringify({
    title: `回执 ${input.originalTaskId}`,
    body: {
      kind: 'kizuna.task-result',
      task_id: input.originalTaskId,
      state: input.state,
      message: input.message,
      result: input.result ?? null,
      reported_by: input.audit.to_agent,
      reported_at: input.reportedAt,
    },
    format: 'json',
    priority: 'normal',
    deadline: null,
  });

  db.prepare(
    `INSERT INTO tasks (task_id, from_agent, to_agent, title, content, format, priority, deadline,
                        status, attempt_count, next_action_at, created_at, reply_to)
     VALUES (?, ?, ?, ?, ?, 'json', 'normal', NULL, 'queued', 0, ?, ?, ?)`,
  ).run(
    replyTaskId,
    input.audit.to_agent,
    input.audit.from_agent,
    `回执 ${input.originalTaskId}`,
    content,
    input.reportedAt,
    input.reportedAt,
    input.originalTaskId,
  );

  return { task_id: replyTaskId, to: input.audit.from_agent };
}

export interface ResultRow {
  state: string;
  category: string;
  message: string | null;
  result_json: string | null;
  content_digest: string | null;
  reported_by: string;
  relayed_to: string | null;
  reported_at: string;
}

export function resultsOf(db: DB, taskId: string) {
  const rows = db
    .prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY id ASC')
    .all(taskId) as ResultRow[];
  return rows.map((r) => ({
    state: r.state,
    category: r.category,
    message: r.message,
    result: r.result_json === null ? null : (JSON.parse(r.result_json) as unknown),
    content_digest: r.content_digest,
    reported_by: r.reported_by,
    relayed_to: r.relayed_to,
    reported_at: r.reported_at,
  }));
}