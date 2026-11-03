import crypto from 'node:crypto';
import type { DB } from './db.js';
import type { HubConfig } from './config.js';
import { findAgent } from './registry.js';
import { getSettings } from './settings.js';

/**
 * 推送模式 Agent 的信箱探活：
 * 与真实投递完全同构的一封签名信（同信封、同签名、同回执判定），
 * 收到合规回执（2xx + task_id 一致）即把 Agent 从 pending 激活为 active。
 * 探活信本身不是任务：不进队列、不进留痕，只决定 activation 状态。
 */

export interface ProbeResult {
  ok: boolean;
  detail: string;
  http_status?: number | null;
}

export function activateAgent(db: DB, agentId: string): void {
  db.prepare(`UPDATE agents SET activation = 'active', updated_at = ? WHERE agent_id = ?`).run(
    new Date().toISOString(),
    agentId,
  );
}

export async function probeWebhook(db: DB, config: HubConfig, agentId: string): Promise<ProbeResult> {
  const agent = findAgent(db, agentId);
  if (!agent) return { ok: false, detail: 'Agent 不存在' };
  if (!agent.webhook_url) return { ok: false, detail: '拉取模式无需探活' };

  const payload = {
    task_id: `P-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    from: { agent_id: 'admin', name: 'Kizuna Hub' },
    content: {
      title: '激活探活',
      body: '这是一封激活探活信：按收信契约在 10 秒内返回 200 {"status":"received","task_id":"<task_id>"} 即完成激活。本信可作为普通信件处理，也可忽略。',
      format: 'text',
      priority: 'normal',
      deadline: null,
    },
    meta: { attempt: 1, enqueued_at: new Date().toISOString(), hub: config.publicUrl },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const signature =
    'sha256=' + crypto.createHmac('sha256', agent.endpoint_secret).update(timestamp + '.' + rawBody).digest('hex');

  const base = agent.webhook_url.replace(/\/+$/, '');
  const url = base.endsWith('/kizuna/deliver') ? base : base + '/kizuna/deliver';
  const timeoutMs = getSettings(db).ack_timeout_s * 1000;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kizuna-task-id': payload.task_id,
        'x-kizuna-timestamp': timestamp,
        'x-kizuna-signature': signature,
        'x-kizuna-attempt': '1',
      },
      body: rawBody,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    const latencyMs = Date.now() - started;
    if (res.status >= 200 && res.status < 300) {
      try {
        const ack = JSON.parse(text) as { task_id?: string };
        if (ack.task_id === payload.task_id) {
          activateAgent(db, agentId);
          return { ok: true, detail: `探活回执合规（${latencyMs}ms），已激活`, http_status: res.status };
        }
        return { ok: false, detail: `回执 task_id 不一致: ${String(ack.task_id)}`, http_status: res.status };
      } catch {
        return { ok: false, detail: '回执不是合法 JSON', http_status: res.status };
      }
    }
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 200)}`, http_status: res.status };
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, detail: `探活超时（${Math.round(timeoutMs / 1000)}s）` };
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 探活失败后的后台重试：+1 / +3 / +10 分钟各一次；期间 Agent 也可随时主动触发。 */
export function scheduleProbeRetries(
  log: { info: (o: object, m: string) => void },
  db: DB,
  config: HubConfig,
  agentId: string,
  step = 0,
): void {
  const delaysS = [60, 180, 600];
  if (step >= delaysS.length) return;
  const t = setTimeout(() => {
    void (async () => {
      const agent = findAgent(db, agentId);
      if (!agent || agent.activation === 'active') return; // 已激活或已注销，重试自然终止
      const r = await probeWebhook(db, config, agentId);
      log.info({ agent_id: agentId, probe_retry: step + 1, ok: r.ok, detail: r.detail }, 'activation probe retry');
      if (!r.ok) scheduleProbeRetries(log, db, config, agentId, step + 1);
    })();
  }, delaysS[step]! * 1000);
  t.unref();
}
