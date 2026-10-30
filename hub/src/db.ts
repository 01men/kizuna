import { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.js';

/**
 * 存储层：Node 内置 node:sqlite（DatabaseSync），零原生依赖。
 *
 * 说明：02-架构设计原选型为 better-sqlite3；实测其在 Node 24.21 下存在
 * GC 终结阶段的原生断言崩溃（Statement::~Statement → RemoveEnvironmentCleanupHook
 * assert env != nullptr），故改用运行时内置 SQLite（同为 SQLite、同为同步 API），
 * 通过下面的薄适配层保持 better-sqlite3 风格调用面（prepare/run/get/all/transaction），
 * 如需切回仅替换本文件。
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
}

export interface DB {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  /** better-sqlite3 风格事务：fn 抛错则回滚并重抛 */
  transaction<T>(fn: () => T): T;
}

class StmtAdapter implements Stmt {
  constructor(private readonly raw: DatabaseSync, private readonly sql: string) {}
  private stmt: { run: (...p: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint }; get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] } | null = null;

  private compiled() {
    if (!this.stmt) {
      const s = this.raw.prepare(this.sql);
      this.stmt = {
        run: (...p: unknown[]) => s.run(...(p as never[])),
        get: (...p: unknown[]) => s.get(...(p as never[])),
        all: (...p: unknown[]) => s.all(...(p as never[])),
      };
    }
    return this.stmt;
  }

  run(...params: unknown[]): RunResult {
    const r = this.compiled().run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...params: unknown[]): any {
    return this.compiled().get(...params);
  }
  all(...params: unknown[]): any[] {
    return this.compiled().all(...params);
  }
}

class DbAdapter implements DB {
  private stmts = new Map<string, Stmt>();
  private inTransaction = false;

  constructor(private readonly raw: DatabaseSync) {}

  prepare(sql: string): Stmt {
    let s = this.stmts.get(sql);
    if (!s) {
      s = new StmtAdapter(this.raw, sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn(); // 支持嵌套（SQLite 无保存点，退化为顺序执行）
    this.inTransaction = true;
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* 事务已结束 */ }
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  capabilities    TEXT NOT NULL DEFAULT '',
  capability_tags TEXT NOT NULL DEFAULT '[]',
  webhook_url     TEXT NOT NULL,
  endpoint_secret TEXT NOT NULL,
  agent_token     TEXT NOT NULL UNIQUE,
  enabled         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  title          TEXT,
  content        TEXT NOT NULL,
  format         TEXT NOT NULL DEFAULT 'text',
  priority       TEXT NOT NULL DEFAULT 'normal',
  deadline       TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  next_action_at TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_next ON tasks(next_action_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS task_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  n            INTEGER NOT NULL,
  attempted_at TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  http_status  INTEGER,
  latency_ms   INTEGER,
  detail       TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, n);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id         TEXT UNIQUE NOT NULL,
  task_id        TEXT NOT NULL,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  enqueued_at    TEXT NOT NULL,
  dequeued_at    TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL,
  attempts_json  TEXT NOT NULL,
  content_digest TEXT,
  note           TEXT,
  is_demo        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_logs(outcome, dequeued_at);

CREATE TABLE IF NOT EXISTS enroll_tokens (
  token       TEXT PRIMARY KEY,
  agent_draft TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  change TEXT NOT NULL
);

-- v1.1 结果回传（A2A 三分类：in_progress / interrupted / terminal）——只增不改不删
CREATE TABLE IF NOT EXISTS task_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT NOT NULL,
  reported_by    TEXT NOT NULL,
  state          TEXT NOT NULL,
  category       TEXT NOT NULL,
  message        TEXT,
  result_json    TEXT,
  content_digest TEXT,
  relayed_to     TEXT,
  reported_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_task ON task_results(task_id, id);
`;

/** 已有库的就地迁移（幂等）：v0.2 起 agents 增加 agent_card，tasks 增加 reply_to */
function migrate(db: DB): void {
  const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  if (!agentCols.includes('agent_card')) db.exec('ALTER TABLE agents ADD COLUMN agent_card TEXT');
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  if (!taskCols.includes('reply_to')) db.exec('ALTER TABLE tasks ADD COLUMN reply_to TEXT');

  // v0.3：演示记录打标（is_demo），供管理台默认过滤，保持审计视图纯净
  const auditCols = (db.prepare('PRAGMA table_info(audit_logs)').all() as { name: string }[]).map((c) => c.name);
  if (!auditCols.includes('is_demo')) {
    db.exec('ALTER TABLE audit_logs ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
    // 存量回填：旧版演示沙箱写入的留痕以 AL-DEMO- 开头
    db.exec("UPDATE audit_logs SET is_demo = 1 WHERE log_id LIKE 'AL-DEMO-%'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_demo ON audit_logs(is_demo, id)');
}

export function openDb(config: HubConfig): DB {
  const raw = new DatabaseSync(config.dbPath);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(SCHEMA);
  const db = new DbAdapter(raw);
  migrate(db);
  return db;
}
