import { qaPost } from './engine.mjs';
import { dailyBudget } from './guards.mjs';
import { categoryCountForDate, sourceUsage } from './diversity.mjs';
import { MAIN_CATEGORIES, quotaSnapshot, tehranParts, dateKey, weekKey, inQuietHours } from './store.mjs';
import { findStoryDuplicate } from './telegram-source.mjs';
import { qaContextForItem, toolUsageForItem } from './review-draft.mjs';

export function publishSlotFor(now) {
  const date = dateKey(now);
  const parts = tehranParts(now);
  return `${date}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function slotWindowStatus(now, slots = [], { before = 20, after = 35 } = {}) {
  const parts = tehranParts(now);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  for (const slot of slots) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(slot));
    if (!match) continue;
    const start = Number(match[1]) * 60 + Number(match[2]);
    const since = (minuteOfDay - start + 1440) % 1440;
    if (since <= after || since >= 1440 - before) return { active: true, slot, since };
  }
  return { active: false, slot: '', since: -1 };
}

export function filterOwnReviewEntries(delivered, item) {
  const titles = new Set([item?.title, item?.post?.title].filter(Boolean));
  return (delivered ?? []).filter(
    (entry) => !(entry?.decision === 'review' && titles.has(entry?.title))
  );
}

export function qaForPublish(item, now, config = {}) {
  if (!item?.post) return null;
  const usage = toolUsageForItem(item);
  return qaPost(item.post, qaContextForItem(item, item.post, now, config, usage?.url ?? ''));
}

export function publishGuards({
  config,
  state,
  item,
  post = item?.post,
  qa,
  now,
  delivered = [],
  manual = item?.manual === true,
} = {}) {
  if (!item || item.status === 'sent' || item.status === 'rejected') {
    return { ok: false, reason: 'closed', detail: 'این مورد قبلاً بسته شده است.' };
  }
  if (!post) {
    return { ok: false, reason: 'no_post', detail: 'نسخهٔ آماده‌ای برای این مورد وجود ندارد.' };
  }
  if (!qa?.pass) {
    return {
      ok: false,
      reason: 'qa_failed',
      detail: `بررسی کیفیت پاس نشد: ${qa?.problems?.join('، ') || 'نامشخص'}`,
    };
  }
  const date = dateKey(now);
  const week = weekKey(date);
  const budget = dailyBudget({ config, state, date });
  if (!manual && inQuietHours(now, config?.schedule?.quiet_hours ?? [])) {
    return { ok: false, reason: 'quiet_hours', detail: 'الان ساعت آرام است؛ بعد از ۸:۳۰ دوباره بزن.' };
  }
  if (!manual && !budget.ok) {
    return {
      ok: false,
      reason: 'daily_cap',
      detail: `سقف پست روزانه پر است (${budget.used}/${budget.cap}).`,
      budget,
    };
  }
  const category = String(post.category ?? '');
  if (!MAIN_CATEGORIES.includes(category)) {
    return { ok: false, reason: 'bad_category', detail: 'دستهٔ پست معتبر نیست.' };
  }
  if (!manual) {
    const categoryCap = Number(config?.diversity?.max_per_category_per_day?.[category] ?? 0);
    const categoryUsed = categoryCountForDate(state, date)[category] ?? 0;
    if (categoryCap > 0 && categoryUsed >= categoryCap) {
      return {
        ok: false,
        reason: 'category_daily_cap',
        detail: `سقف روزانهٔ دستهٔ ${category} پر است (${categoryUsed}/${categoryCap}).`,
      };
    }
    const quota = quotaSnapshot(config, state, week)[category];
    if (quota && quota.remaining <= 0) {
      return {
        ok: false,
        reason: 'category_weekly_cap',
        detail: `سهمیهٔ هفتگی دستهٔ ${category} پر است (${quota.used}/${quota.quota}).`,
      };
    }
    const source = String(item.source ?? '');
    const { daily, weekly } = sourceUsage(state, { date, week });
    const sourceDayCap = Number(config?.diversity?.max_per_source_per_day ?? 0);
    const sourceWeekCap = Number(config?.diversity?.max_per_source_per_week ?? 0);
    if (source && sourceDayCap > 0 && (daily.get(source) ?? 0) >= sourceDayCap) {
      return { ok: false, reason: 'source_daily_cap', detail: 'سقف روزانهٔ این منبع پر است.' };
    }
    if (source && sourceWeekCap > 0 && (weekly.get(source) ?? 0) >= sourceWeekCap) {
      return { ok: false, reason: 'source_weekly_cap', detail: 'سقف هفتگی این منبع پر است.' };
    }
  }
  if (item.kind === 'offer' && !item.url) {
    return {
      ok: false,
      reason: 'offer_link_missing',
      detail: 'این آفر لینک منبع ندارد؛ بدون تأیید لینک به کانال اصلی نمی‌رود.',
    };
  }
  const duplicate = findStoryDuplicate(
    { title: item.title, messageText: item.messageText, policy: item.policy, benchmark: item.benchmark },
    filterOwnReviewEntries(delivered, item)
  );
  if (duplicate) {
    return {
      ok: false,
      reason: 'duplicate',
      detail: `این خبر قبلاً منتشر شده: ${duplicate.title}`,
    };
  }
  return { ok: true, reason: 'ok', detail: '', category, date, week, budget };
}
