import { inQuietHours } from './store.mjs';

export function dailyBudget({ config, state, date }) {
  const cap = Math.max(1, Number(config?.schedule?.max_posts_per_day ?? 6) || 6);
  const used = (state?.published ?? []).filter((entry) =>
    String(entry.slot ?? '').startsWith(`${date}T`)
  ).length;
  return { cap, used, remaining: Math.max(0, cap - used), ok: used < cap };
}

export function sendWindow({ config, state, date, now, reviewSend = false }) {
  const budget = dailyBudget({ config, state, date });
  if (reviewSend) return { ok: true, reason: 'review_send', budget };
  if (inQuietHours(now, config?.schedule?.quiet_hours ?? [])) {
    return { ok: false, reason: 'quiet_hours', budget };
  }
  if (!budget.ok) return { ok: false, reason: 'daily_cap', budget };
  return { ok: true, reason: 'ok', budget };
}
