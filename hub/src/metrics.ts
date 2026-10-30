/** 进程内计数器（/metrics 输出用；重启归零可接受，持久口径以留痕表为准） */

export const counters = {
  deliveriesTotal: new Map<string, number>(), // outcome → n
  auditDeletionsTotal: new Map<string, number>(), // outcome → n
};

export const gauges = {
  queueDepth: 0,
  retrying: 0,
  agentsOnline: 0,
};

export const latency = { count: 0, sumMs: 0 };

export function incr(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

export function renderPrometheus(): string {
  const lines: string[] = [];
  lines.push('# TYPE kizuna_queue_depth gauge');
  lines.push(`kizuna_queue_depth ${gauges.queueDepth}`);
  lines.push('# TYPE kizuna_agents_online gauge');
  lines.push(`kizuna_agents_online ${gauges.agentsOnline}`);
  lines.push('# TYPE kizuna_deliveries_total counter');
  for (const [k, v] of counters.deliveriesTotal) lines.push(`kizuna_deliveries_total{outcome="${k}"} ${v}`);
  lines.push('# TYPE kizuna_audit_deletions_total counter');
  for (const [k, v] of counters.auditDeletionsTotal) lines.push(`kizuna_audit_deletions_total{outcome="${k}"} ${v}`);
  lines.push('# TYPE kizuna_delivery_latency_seconds summary');
  lines.push(`kizuna_delivery_latency_seconds_count ${latency.count}`);
  lines.push(`kizuna_delivery_latency_seconds_sum ${(latency.sumMs / 1000).toFixed(3)}`);
  return lines.join('\n') + '\n';
}
