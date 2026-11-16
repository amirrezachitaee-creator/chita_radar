import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dateKey } from './store.mjs';
import { newsDate } from './newstime.mjs';

export const HEALTH_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  window_days: 45,
  min_signals: 5,
  min_rejects: 4,
  watch_min_rejects: 3,
  watch_negative_rate: 0.5,
  quarantine_negative_rate: 0.8,
  quarantine_cooldown_hours: 336,
  trial_days: 14,
  trial_cooldown_hours: 720,
  watch_limit: 1,
  protected_types: ['official_blog', 'api', 'policy', 'benchmark'],
  max_history: 200,
});

const DAY_MS = 86400000;
const REJECT_WEIGHT = 1;
const REWRITE_WEIGHT = 0.5;
const MANUAL_PUBLISH_WEIGHT = 2;
const AUTO_PUBLISH_WEIGHT = 1;
const REASON_EXTRA = {
  irrelevant: 1,
  promo: 1,
  duplicate: 0.5,
  quality: 0.25,
  other: 0.25,
};

const timeOf = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : NaN;
};

export function settingsOf(value = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...(value && typeof value === 'object' ? value : {}),
    protected_types: Array.isArray(value?.protected_types)
      ? value.protected_types
      : DEFAULT_SETTINGS.protected_types,
  };
}

export function emptyHealth() {
  return {
    version: HEALTH_VERSION,
    updatedAt: '',
    lastStatusDate: '',
    lastStatusAt: '',
    sources: {},
    history: [],
  };
}

export function normalizeHealth(value) {
  const base = emptyHealth();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: HEALTH_VERSION,
    sources: value.sources && typeof value.sources === 'object' ? value.sources : {},
    history: Array.isArray(value.history) ? value.history.slice(-DEFAULT_SETTINGS.max_history) : [],
  };
}

export async function loadHealth(path) {
  try {
    return normalizeHealth(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyHealth();
    throw error;
  }
}

export async function saveHealth(path, health) {
  await mkdir(dirname(path), { recursive: true });
  health.updatedAt = new Date().toISOString();
  await writeFile(path, `${JSON.stringify(health, null, 2)}\n`);
}

export function sourceMetrics({ sourceId, actions = [], published = [], now, since = 0, windowDays = 45 }) {
  const nowMs = timeOf(now);
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const cutoff = Math.max(nowMs - Math.max(1, Number(windowDays) || 45) * DAY_MS, Number(since) || 0);
  let rejects = 0;
  let rewrites = 0;
  let manualPublishes = 0;
  let lastEventAt = 0;
  const rejectReasons = {};

  for (const action of actions) {
    if (!action || String(action.source ?? '') !== String(sourceId)) continue;
    const at = timeOf(action.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    lastEventAt = Math.max(lastEventAt, at);
    if (action.action === 'reject') {
      rejects += 1;
      const reason = String(action.reason || 'other');
      rejectReasons[reason] = (rejectReasons[reason] ?? 0) + 1;
    } else if (action.action === 'rewrite') {
      rewrites += 1;
    } else if (action.action === 'publish') {
      manualPublishes += 1;
    }
  }

  let autoPublishes = 0;
  for (const entry of published) {
    if (!entry || String(entry.sourceId ?? '') !== String(sourceId)) continue;
    const at = timeOf(entry.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    autoPublishes += 1;
    lastEventAt = Math.max(lastEventAt, at);
  }

  const positives = manualPublishes * MANUAL_PUBLISH_WEIGHT + autoPublishes * AUTO_PUBLISH_WEIGHT;
  const extra = Object.entries(rejectReasons).reduce(
    (sum, [reason, count]) => sum + (REASON_EXTRA[reason] ?? 0.25) * count,
    0
  );
  const negatives = rejects * REJECT_WEIGHT + rewrites * REWRITE_WEIGHT + extra;
  const decisions = rejects + rewrites + manualPublishes + autoPublishes;
  const publishedTotal = manualPublishes + autoPublishes;
  const score = (positives + 1) / (positives + negatives + 2);
  const negativeRate = decisions ? (rejects + rewrites * REWRITE_WEIGHT) / decisions : 0;

  return {
    rejects,
    rewrites,
    manualPublishes,
    autoPublishes,
    publishes: publishedTotal,
    decisions,
    positiveRate: decisions ? publishedTotal / decisions : 0,
    negativeRate,
    rejectReasons,
    score,
    lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : '',
  };
}

function needsQuarantine(metrics, settings) {
  return (
    metrics.rejects >= settings.min_rejects &&
    metrics.publishes === 0 &&
    metrics.decisions >= settings.min_signals &&
    metrics.negativeRate >= settings.quarantine_negative_rate
  );
}

function needsWatch(metrics, settings) {
  return (
    metrics.rejects >= settings.watch_min_rejects &&
    metrics.negativeRate >= settings.watch_negative_rate &&
    metrics.publishes <= metrics.rejects
  );
}

function event(health, sourceId, from, to, reason, at) {
  if (from === to) return;
  if (!from && to === 'active') return;
  const entry = { at, source: sourceId, from, to, reason };
  health.history.push(entry);
  const max = Math.max(20, Number(health.max_history ?? DEFAULT_SETTINGS.max_history));
  if (health.history.length > max) health.history = health.history.slice(-max);
}

export function computeSourceHealth({
  registrySources = [],
  dynamicSources = [],
  feedback = {},
  states = [],
  previous = emptyHealth(),
  now,
  settings: rawSettings = {},
} = {}) {
  const settings = settingsOf(rawSettings);
  const nowMs = timeOf(now);
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const at = new Date(nowMs).toISOString();
  const health = normalizeHealth(previous);
  health.version = HEALTH_VERSION;
  health.updatedAt = at;

  const actions = Array.isArray(feedback.actions) ? feedback.actions : [];
  const published = (states ?? []).flatMap((state) =>
    Array.isArray(state?.published) ? state.published : []
  );
  const dynamicRecords = new Map(
    (dynamicSources ?? []).filter((source) => source?.id).map((source) => [String(source.id), source])
  );
  const dynamicIds = new Set(dynamicRecords.keys());
  const types = new Map();
  for (const source of [...(registrySources ?? []), ...(dynamicSources ?? [])]) {
    if (source?.id) types.set(String(source.id), String(source.type ?? ''));
  }
  const known = new Set([...types.keys(), ...Object.keys(health.sources ?? {})]);

  for (const sourceId of known) {
    const dynamicRecord = dynamicRecords.get(sourceId);
    const old = {
      ...(health.sources[sourceId] ?? {}),
      name: health.sources[sourceId]?.name || dynamicRecord?.name || '',
      discoveredAt: health.sources[sourceId]?.discoveredAt || dynamicRecord?.discoveredAt || '',
    };
    const type = types.get(sourceId) ?? String(old.type ?? '');
    const dynamic = dynamicIds.has(sourceId) || old.dynamic === true;
    const protectedSource = settings.protected_types.includes(type);
    const trialStart = timeOf(old.trialStart);
    const trialUntil = timeOf(old.trialUntil);
    const cooldownUntil = timeOf(old.cooldownUntil);
    const inTrial = old.status === 'probation' && Number.isFinite(trialUntil) && nowMs < trialUntil;
    const since = inTrial && Number.isFinite(trialStart) ? trialStart : 0;
    const metrics = sourceMetrics({
      sourceId,
      actions,
      published,
      now,
      since,
      windowDays: settings.window_days,
    });

    let status = old.status || 'active';
    let reason = old.reason || '';
    let nextTrialStart = old.trialStart || '';
    let nextTrialUntil = old.trialUntil || '';
    let nextCooldownUntil = old.cooldownUntil || '';

    if (protectedSource) {
      status = 'active';
      reason = 'protected_source';
      nextTrialStart = '';
      nextTrialUntil = '';
      nextCooldownUntil = '';
    } else if (old.status === 'quarantined' && Number.isFinite(cooldownUntil) && nowMs < cooldownUntil) {
      status = 'quarantined';
      reason = old.reason || 'cooldown';
    } else if (old.status === 'quarantined') {
      status = 'probation';
      reason = 'cooldown_expired';
      nextCooldownUntil = '';
      nextTrialStart = at;
      nextTrialUntil = new Date(nowMs + settings.trial_days * DAY_MS).toISOString();
    } else if (inTrial) {
      if (metrics.publishes > 0) {
        status = 'active';
        reason = 'trial_passed';
        nextTrialStart = '';
        nextTrialUntil = '';
        nextCooldownUntil = '';
      } else if (needsQuarantine(metrics, settings)) {
        status = 'quarantined';
        reason = 'trial_rejected';
        nextTrialStart = '';
        nextTrialUntil = '';
        nextCooldownUntil = new Date(nowMs + settings.trial_cooldown_hours * 3600000).toISOString();
      } else {
        status = 'probation';
        reason = old.reason || 'trial_running';
      }
    } else if (Number.isFinite(trialUntil) && nowMs >= trialUntil) {
      if (metrics.publishes > 0) {
        status = 'active';
        reason = 'trial_passed';
        nextTrialStart = '';
        nextTrialUntil = '';
        nextCooldownUntil = '';
      } else if (dynamic) {
        status = 'quarantined';
        reason = metrics.rejects > 0 ? 'trial_rejected' : 'trial_expired';
        nextTrialStart = '';
        nextTrialUntil = '';
        nextCooldownUntil = new Date(nowMs + settings.trial_cooldown_hours * 3600000).toISOString();
      } else if (needsQuarantine(metrics, settings)) {
        status = 'quarantined';
        reason = 'sustained_rejects';
        nextTrialStart = '';
        nextTrialUntil = '';
        nextCooldownUntil = new Date(nowMs + settings.quarantine_cooldown_hours * 3600000).toISOString();
      } else {
        status = needsWatch(metrics, settings) ? 'watch' : 'active';
        reason = status === 'watch' ? 'reject_pattern' : 'trial_quiet';
        nextTrialStart = '';
        nextTrialUntil = '';
      }
    } else if (needsQuarantine(metrics, settings)) {
      status = 'quarantined';
      reason = 'sustained_rejects';
      nextTrialStart = '';
      nextTrialUntil = '';
      nextCooldownUntil = new Date(nowMs + settings.quarantine_cooldown_hours * 3600000).toISOString();
    } else if (dynamic && !old.status) {
      status = 'probation';
      reason = 'new_source';
      nextTrialStart = old.discoveredAt || at;
      nextTrialUntil =
        old.trialUntil || new Date(nowMs + settings.trial_days * DAY_MS).toISOString();
    } else if (needsWatch(metrics, settings)) {
      status = 'watch';
      reason = 'reject_pattern';
    } else {
      status = 'active';
      reason = metrics.decisions ? 'ok' : 'no_signal';
    }

    if (status !== 'probation' && status !== 'watch') {
      nextTrialStart = '';
      nextTrialUntil = '';
    }
    const sinceValue =
      status === 'probation' || status === 'watch'
        ? old.since && old.status === status
          ? old.since
          : at
        : old.since && old.status === status
          ? old.since
          : at;

    event(health, sourceId, old.status ?? '', status, reason, at);
    health.sources[sourceId] = {
      ...old,
      id: sourceId,
      type,
      dynamic,
      protected: protectedSource,
      status,
      reason,
      score: Number(metrics.score.toFixed(4)),
      negativeRate: Number(metrics.negativeRate.toFixed(4)),
      counts: {
        rejects: metrics.rejects,
        rewrites: metrics.rewrites,
        manualPublishes: metrics.manualPublishes,
        autoPublishes: metrics.autoPublishes,
        publishes: metrics.publishes,
        decisions: metrics.decisions,
      },
      rejectReasons: metrics.rejectReasons,
      lastEventAt: metrics.lastEventAt || old.lastEventAt || '',
      since: sinceValue,
      trialStart: nextTrialStart,
      trialUntil: nextTrialUntil,
      cooldownUntil: nextCooldownUntil,
      decidedAt: old.status === status ? old.decidedAt || at : at,
    };
  }

  return health;
}

export function applySourceHealth(sources = [], health, now, rawSettings = {}) {
  const settings = settingsOf(rawSettings);
  const nowMs = timeOf(now);
  const kept = [];
  const skipped = [];
  const limits = {};
  for (const source of sources) {
    const entry = health?.sources?.[source?.id];
    const cooldownUntil = timeOf(entry?.cooldownUntil);
    if (entry?.status === 'quarantined' && Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
      skipped.push({
        id: source.id,
        name: source.name || source.id,
        reason: entry.reason || 'quarantined',
        until: entry.cooldownUntil,
      });
      continue;
    }
    kept.push(source);
    if (entry?.status === 'watch' || entry?.status === 'probation') {
      const configured = Number(source.max_items_per_run ?? 0);
      const cap = Math.max(1, Number(settings.watch_limit) || 1);
      limits[source.id] = configured > 0 ? Math.min(configured, cap) : cap;
    }
  }
  return { sources: kept, limits, skipped };
}

export function healthCounts(health) {
  const counts = { active: 0, watch: 0, probation: 0, quarantined: 0, protected: 0, total: 0 };
  for (const entry of Object.values(health?.sources ?? {})) {
    if (!entry || !entry.status) continue;
    counts.total += 1;
    if (entry.status === 'active' && entry.protected) counts.protected += 1;
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  return counts;
}

export function recentHealthChanges(health, now, { hours = 30 } = {}) {
  const nowMs = timeOf(now);
  const cutoff = nowMs - Math.max(1, Number(hours) || 30) * 3600000;
  return (health?.history ?? [])
    .filter((entry) => {
      const at = timeOf(entry?.at);
      return Number.isFinite(at) && at >= cutoff && entry.from !== entry.to;
    })
    .slice(-20)
    .reverse();
}

const STATUS_FA = {
  active: 'فعال',
  watch: 'زیر نظر',
  probation: 'آزمایشی',
  quarantined: 'کنارگذاشته',
  protected: 'حفاظت‌شده',
};

export function renderHealthReport(health, {
  date = '',
  dynamicCount = 0,
  changes = [],
  state = null,
  config = null,
} = {}) {
  const counts = healthCounts(health);
  const lines = [];
  lines.push(`# وضعیت منابع ${date || dateKey(new Date())}`);
  lines.push('');
  lines.push(
    `- فعال: ${counts.active} | زیر نظر: ${counts.watch} | آزمایشی: ${counts.probation} | کنارگذاشته: ${counts.quarantined}`
  );
  lines.push(`- منابع پویا: ${dynamicCount}`);
  if (state) {
    const slots = Object.entries(state.slots ?? {}).filter(([key]) =>
      date ? String(key).startsWith(`${date}T`) : false
    );
    const sent = slots.reduce(
      (sum, [, entry]) => sum + (Array.isArray(entry?.posts) ? entry.posts.filter((post) => post.status === 'sent').length : 0),
      0
    );
    lines.push(`- اسلات‌های ثبت‌شده امروز: ${slots.length} | پست ارسال‌شده: ${sent}`);
    lines.push(`- صف تعویق: ${Object.keys(state.deferred ?? {}).length}`);
  }
  if (changes.length) {
    lines.push('');
    lines.push('## تغییرهای اخیر');
    for (const change of changes) {
      const id = change.source;
      const entry = health.sources?.[id] ?? {};
      const name = entry.name || id;
      lines.push(
        `- ${name}: ${(STATUS_FA[change.from] ?? change.from) || 'جدید'} ← ${STATUS_FA[change.to] ?? change.to} (${change.reason})`
      );
    }
  }
  const interesting = Object.values(health?.sources ?? {})
    .filter((entry) => entry.status !== 'active' || entry.counts?.rejects > 0)
    .sort((left, right) => (left.score ?? 1) - (right.score ?? 1));
  if (interesting.length) {
    lines.push('');
    lines.push('## منابع نیازمند توجه');
    lines.push('| منبع | وضعیت | امتیاز | رد | بازنویسی | انتشار | دلیل |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const entry of interesting.slice(0, 20)) {
      lines.push(
        `| ${entry.name || entry.id} | ${STATUS_FA[entry.status] ?? entry.status} | ${entry.score ?? '—'} | ${
          entry.counts?.rejects ?? 0
        } | ${entry.counts?.rewrites ?? 0} | ${entry.counts?.publishes ?? 0} | ${entry.reason ?? ''} |`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderStatusMessage(health, {
  now,
  state = null,
  reviewStore = null,
  dynamicCount = 0,
  changes = [],
} = {}) {
  const date = dateKey(now);
  const counts = healthCounts(health);
  const lines = [];
  lines.push(`📊 وضعیت رادار — ${newsDate(now)}`);
  if (state) {
    const slots = Object.entries(state.slots ?? {}).filter(([key]) => String(key).startsWith(`${date}T`));
    const posts = slots.flatMap(([, entry]) => (Array.isArray(entry?.posts) ? entry.posts : []));
    const sent = posts.filter((post) => post.status === 'sent').length;
    const review = posts.filter((post) => post.status === 'review').length;
    const empty = slots.filter(([, entry]) => entry?.status === 'empty').length;
    const cap = Number(state.published?.filter((entry) => dateKey(entry.at) === date).length ?? 0);
    lines.push(`پست امروز: ${sent} | کپی بازبینی: ${review} | اسلات خالی: ${empty} | کل امروز: ${cap}`);
  }
  if (reviewStore) {
    const pending = Object.values(reviewStore.items ?? {}).filter((item) => item?.status === 'pending').length;
    lines.push(`صف بازبینی: ${pending} کارت`);
    const actions = Array.isArray(reviewStore.actions) ? reviewStore.actions : [];
    const countAction = (name) =>
      actions.filter((entry) => entry?.action === name && entry?.at && dateKey(entry.at) === date).length;
    lines.push(`امروز: ${countAction('reject')} رد | ${countAction('rewrite')} بازنویسی`);
  }
  if (state) lines.push(`صف تعویق: ${Object.keys(state.deferred ?? {}).length}`);
  lines.push(
    `منابع: ${counts.active} فعال، ${counts.watch} زیر نظر، ${counts.probation} آزمایشی، ${counts.quarantined} کنارگذاشته (${dynamicCount} پویا)`
  );
  const trials = Object.values(health?.sources ?? {})
    .filter((entry) => entry.status === 'probation')
    .slice(0, 5);
  if (trials.length) {
    lines.push('');
    lines.push('در حال آزمایش:');
    for (const entry of trials) {
      const until = entry.trialUntil ? newsDate(entry.trialUntil) : '';
      const reasons = Object.entries(entry.rejectReasons ?? {})
        .map(([reason, count]) => `${reason} ${count}`)
        .join('، ');
      lines.push(
        `• ${entry.name || entry.id}${until ? ` تا ${until}` : ''}${reasons ? ` | رد: ${reasons}` : ''}`
      );
    }
  }
  const quarantined = Object.values(health?.sources ?? {})
    .filter((entry) => entry.status === 'quarantined')
    .slice(0, 5);
  if (quarantined.length) {
    lines.push('');
    lines.push('کنار گذاشته‌شده:');
    for (const entry of quarantined) {
      const until = entry.cooldownUntil ? newsDate(entry.cooldownUntil) : '';
      lines.push(
        `• ${entry.name || entry.id} | ${entry.reason || 'بدون دلیل'}${until ? ` | بازگشت ${until}` : ''}`
      );
    }
  }
  if (changes.length) {
    lines.push('');
    lines.push('تغییرهای ۳۰ ساعت اخیر:');
    for (const change of changes.slice(0, 6)) {
      const name = health.sources?.[change.source]?.name || change.source;
      lines.push(
        `• ${name}: ${(STATUS_FA[change.from] ?? change.from) || 'جدید'} ← ${STATUS_FA[change.to] ?? change.to} (${change.reason})`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const health = await loadHealth(resolve(ROOT, option('--health', 'data/source-health.json')));
  const date = option('--date', dateKey(new Date()));
  let state = null;
  try {
    state = JSON.parse(await readFile(resolve(ROOT, option('--state', 'data/state.json')), 'utf8'));
  } catch {
    state = null;
  }
  let dynamicCount = 0;
  try {
    const doc = JSON.parse(await readFile(resolve(ROOT, 'data/sources.dynamic.json'), 'utf8'));
    dynamicCount = Array.isArray(doc.sources) ? doc.sources.length : 0;
  } catch {
    dynamicCount = 0;
  }
  const changes = recentHealthChanges(health, new Date(), { hours: 48 });
  process.stdout.write(
    renderHealthReport(health, { date, dynamicCount, changes, state })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
