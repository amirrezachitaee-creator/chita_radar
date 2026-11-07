import { MAIN_CATEGORIES } from './store.mjs';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const CATEGORY_PATTERNS = {
  tools:
    /(?:ابزار|ابزارک|اپلیکیشن|(?<![\p{L}])اپ(?![\p{L}])|سرویس|پلتفرم|افزونه|کلاینت|داشبورد|ربات|نسخه[\s\u200c]*(?:جدید|تازه)|رونمایی|عرضه|منتشر شد|\btools?\b|\bapps?\b|\bplatforms?\b|\bplugins?\b|\bextensions?\b|\bapi\b|\bsdk\b|\bcopilot\b|\blaunch(?:es|ed)?\b|\bfeatures?\b)/giu,
  models:
    /(?:مدل(?:\s|‌|$)|مدل[\s\u200c]*زبانی|بنچمارک|پژوهش|مقاله|شبکه[\s\u200c]*عصبی|آموزش[\s\u200c]*مدل|انتشار[\s\u200c]*مدل|وزن[\s\u200c]*ها|معماری|استنتاج|\bmodels?\b|\bllms?\b|\bbenchmarks?\b|\bresearch\b|\bpapers?\b|\bneural\b|\btransformer\b|\bweights\b|\binference\b|\brelease(?:s|d)?\b)/giu,
  security:
    /(?:امنیت|حریم[\s\u200c]*خصوصی|نشت|آسیب[\s\u200c]*پذیری|حمله|بدافزار|فیشینگ|کلاهبرداری|باج[\s\u200c]*گیری|هک|رمزنگاری|\bvulnerab\w*|\bbreach\w*|\bmalware\b|\bphishing\b|\bexploit\w*|\bprivacy\b|\bcyber\w*|\bransomware\b|\bsecurity\b)/giu,
  business:
    /(?:سرمایه[\s\u200c]*گذاری|بودجه|خرید|ادغام|ارزش|درآمد|قرارداد|میلیارد|میلیون|سهام|بورس|استخدام|تعطیلی|بازار|\bfunding\b|\bacqui\w*|\bvaluation\b|\brevenue\b|\bipo\b|\binvest\w*|\bbillion\b|\bmillion\b|\bstartups?\b|\bmarket\w*|\bpartnership\b)/giu,
};

export function dayKey(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  if (!year || !month || !day) throw new Error(`invalid date ${date}`);
  return DAY_KEYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
}

export function slotTarget(config, date, slot) {
  const row = config.diversity?.weekly_matrix?.[dayKey(date)];
  const index = config.schedule?.slots?.indexOf(slot) ?? -1;
  if (!row || index < 0) return '';
  return row[index] ?? '';
}

export function matrixTotals(config) {
  const totals = Object.fromEntries(MAIN_CATEGORIES.map((category) => [category, 0]));
  for (const row of Object.values(config.diversity?.weekly_matrix ?? {})) {
    for (const category of row) {
      if (totals[category] !== undefined) totals[category] += 1;
    }
  }
  return totals;
}

export function publishedOnDate(state, date) {
  return (state.published ?? []).filter((entry) => String(entry.slot ?? '').startsWith(`${date}T`));
}

export function categoryCountForDate(state, date) {
  const counts = Object.fromEntries(MAIN_CATEGORIES.map((category) => [category, 0]));
  for (const entry of publishedOnDate(state, date)) {
    if (counts[entry.category] !== undefined) counts[entry.category] += 1;
  }
  return counts;
}

export function sourceKeyOf(entry) {
  return String(entry?.sourceId ?? entry?.sourceName ?? '');
}

export function sourceUsage(state, { date, week }) {
  const daily = new Map();
  const weekly = new Map();
  for (const entry of state.published ?? []) {
    const source = sourceKeyOf(entry);
    if (!source) continue;
    if (String(entry.slot ?? '').startsWith(`${date}T`)) {
      daily.set(source, (daily.get(source) ?? 0) + 1);
    }
    if (entry.week === week) weekly.set(source, (weekly.get(source) ?? 0) + 1);
  }
  return { daily, weekly };
}

export function lastPublished(state) {
  return (state.published ?? []).at(-1) ?? null;
}

export function lastPublishedOnDate(state, date) {
  return publishedOnDate(state, date).at(-1) ?? null;
}

export function categoryRemaining(config, state, week, category) {
  const quota = Number(config.categories?.[category]?.weekly_quota ?? 0);
  const used = (state.published ?? []).filter(
    (entry) => entry.week === week && entry.category === category
  ).length;
  return Math.max(0, quota - used);
}

function matches(text, pattern) {
  pattern.lastIndex = 0;
  return (String(text ?? '').match(pattern) ?? []).length;
}

export function categoryHint({
  title = '',
  summary = '',
  sourceCategories = [],
  toolHint = false,
  offerHint = false,
  officialCourse = false,
} = {}) {
  if (offerHint || toolHint || officialCourse) return 'tools';

  const scores = new Map(MAIN_CATEGORIES.map((category) => [category, 0]));
  for (const category of sourceCategories) {
    if (scores.has(category)) scores.set(category, scores.get(category) + 2);
  }
  for (const category of MAIN_CATEGORIES) {
    const pattern = CATEGORY_PATTERNS[category];
    const titleHits = Math.min(2, matches(title, pattern));
    const summaryHits = Math.min(3, matches(summary, pattern));
    scores.set(category, scores.get(category) + titleHits * 3 + summaryHits);
  }

  let best = '';
  let bestScore = 0;
  let tied = [];
  for (const category of MAIN_CATEGORIES) {
    const score = scores.get(category);
    if (score > bestScore) {
      best = category;
      bestScore = score;
      tied = [category];
    } else if (score === bestScore && score > 0) {
      tied.push(category);
    }
  }
  if (!best) return '';
  if (tied.length > 1) {
    const sourcePick = sourceCategories.find((category) => tied.includes(category));
    if (sourcePick) return sourcePick;
  }
  return best;
}

export function planSlotQueue({
  config,
  state,
  date,
  slot,
  week,
  candidates = [],
  maxCandidates = 6,
}) {
  const target = slotTarget(config, date, slot);
  const last = lastPublishedOnDate(state, date);
  const counts = categoryCountForDate(state, date);
  const usage = sourceUsage(state, { date, week });
  const options = config.diversity ?? {};
  const categoryCap = (category) => {
    const value = options.max_per_category_per_day;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Math.max(0, Number(value[category] ?? 3));
    }
    return Math.max(0, Number(value ?? 3));
  };
  const sourceDayCap = Number(options.max_per_source_per_day ?? 1);
  const sourceWeekCap = Number(options.max_per_source_per_week ?? 4);
  const noConsecutiveCategory = options.no_consecutive_category !== false;
  const deferredPriority = options.deferred_priority !== false;
  const rejected = {
    source_daily: 0,
    source_weekly: 0,
    source_consecutive: 0,
    category_daily: 0,
    category_consecutive: 0,
    quota_full: 0,
  };

  const pressureOf = (category) =>
    category && MAIN_CATEGORIES.includes(category)
      ? categoryRemaining(config, state, week, category)
      : 0;

  const eligible = [];
  for (const candidate of candidates) {
    const source = sourceKeyOf(candidate);
    const hint = candidate.categoryHint ?? '';
    if (last && source && source === sourceKeyOf(last)) {
      rejected.source_consecutive += 1;
      continue;
    }
    if (source && (usage.daily.get(source) ?? 0) >= sourceDayCap) {
      rejected.source_daily += 1;
      continue;
    }
    if (source && (usage.weekly.get(source) ?? 0) >= sourceWeekCap) {
      rejected.source_weekly += 1;
      continue;
    }
    if (hint && MAIN_CATEGORIES.includes(hint)) {
      if ((counts[hint] ?? 0) >= categoryCap(hint)) {
        rejected.category_daily += 1;
        continue;
      }
      if (noConsecutiveCategory && last?.category === hint) {
        rejected.category_consecutive += 1;
        continue;
      }
      if (pressureOf(hint) <= 0) {
        rejected.quota_full += 1;
        continue;
      }
    }
    eligible.push(candidate);
  }

  eligible.sort((left, right) => {
    const leftHint = left.categoryHint ?? '';
    const rightHint = right.categoryHint ?? '';
    if (deferredPriority) {
      const leftDeferred = Boolean(left.deferred);
      const rightDeferred = Boolean(right.deferred);
      if (leftDeferred !== rightDeferred) return leftDeferred ? -1 : 1;
    }
    const leftTarget = leftHint === target && pressureOf(leftHint) > 0;
    const rightTarget = rightHint === target && pressureOf(rightHint) > 0;
    if (leftTarget !== rightTarget) return leftTarget ? -1 : 1;
    const pressureDiff = pressureOf(rightHint) - pressureOf(leftHint);
    if (pressureDiff !== 0) return pressureDiff;
    const dayDiff = (counts[leftHint] ?? 0) - (counts[rightHint] ?? 0);
    if (dayDiff !== 0) return dayDiff;
    const ageDiff = Number(left.ageHours ?? 999) - Number(right.ageHours ?? 999);
    if (ageDiff !== 0) return ageDiff;
    return String(left.title ?? '').localeCompare(String(right.title ?? ''));
  });

  return {
    target,
    queue: buildQueue(eligible, target, maxCandidates, deferredPriority),
    rejected,
    counts,
    sourceUsage: {
      daily: Object.fromEntries(usage.daily),
      weekly: Object.fromEntries(usage.weekly),
    },
  };
}

function buildQueue(eligible, target, maxCandidates, deferredPriority = true) {
  const limit = Math.max(0, maxCandidates);
  const seenSources = new Set();
  const unique = eligible.filter((candidate) => {
    const source = sourceKeyOf(candidate);
    if (!source) return true;
    if (seenSources.has(source)) return false;
    seenSources.add(source);
    return true;
  });
  const deferred = deferredPriority ? unique.filter((candidate) => candidate.deferred) : [];
  const deferredSet = new Set(deferred);
  const rest = unique.filter((candidate) => !deferredSet.has(candidate));
  const targetPool = rest.filter((candidate) => candidate.categoryHint === target);
  const others = rest.filter((candidate) => candidate.categoryHint !== target);
  const lead = targetPool.slice(0, 2);
  const tail = targetPool.slice(2);
  return [...deferred.slice(0, 2), ...lead, ...others, ...tail].slice(0, limit);
}
