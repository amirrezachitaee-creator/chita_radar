import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalUrl, contentHash, earliestDate, freshness, windowFor } from './normalize.mjs';
import {
  loadEnv,
  makeRedactor,
  fetchText,
  extractArticle,
  imageVerdict,
  downloadImage,
  buildUserMessage,
  buildQaRepairMessage,
  buildTitleRepairMessage,
  callWithRetry,
  extractJson,
  qaPost,
  TITLE_QA_PROBLEMS,
  applyLeadPolicy,
  applyMechanicalFixes,
  isFalseStaleSkip,
  pickToolUsageLink,
  renderPreview,
  MAIN_CATEGORIES,
} from './engine.mjs';
import { collectCandidates } from './collect.mjs';
import { clearReminderDay } from './policy-watch.mjs';
import { categoryCountForDate, lastPublishedOnDate, planSlotQueue, slotTarget } from './diversity.mjs';
import { dailyBudget, sendWindow } from './guards.mjs';
import { buildEducationForward, findStoryDuplicate } from './telegram-source.mjs';
import { watchOnce, selectTargets } from './offer-watch.mjs';
import { assessOffer, detectOffer, offerUsage, openEndedKey, openEndedUsage, recordOpenEnded, markOpenEndedEnded, offerReviewUsage, recordOfferReview, resolveVendorLink, reviewCapacity, reviewText, reviewHtml, refreshQueuedReviewText, enqueueReviewPending, listReviewPending, removeReviewPending } from './offers.mjs';
import {
  loadState,
  saveState,
  resolveSlot,
  slotStart,
  slotKey,
  dateKey,
  weekKey,
  isSlotSettled,
  inQuietHours,
  markSeen,
  markSlot,
  findSeen,
  quotaSnapshot,
  recordPublished,
  recordEducationReview,
  pruneState,
  deferCandidate,
  deferredId,
  listDeferred,
  clearDeferred,
  deliveredEntries,
  MAX_DEFER_ATTEMPTS,
  DEFER_TTL_HOURS,
} from './store.mjs';
import { sendTelegram, sendText, sendPhotoUrl, captionLength, postText } from './telegram.mjs';
import { newsDateLine, effectiveDateLine } from './newstime.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const NOW = option('--now', new Date().toISOString());
const SLOT = option('--slot', '');
const DATE = option('--date', '');
const MODEL = option('--model', 'DeepSeek-V4-Flash');
const SEND = flag('--send');
const REVIEW_SEND = flag('--review-send');
const FORCE = flag('--force');
const NO_TELEGRAM = flag('--no-telegram');
const NO_OFFERS = flag('--no-offers');
const MAX_CANDIDATES_ARG = option('--max-candidates', '');
const PER_SOURCE = Number(option('--per-source', '12'));
const MIN_CONTENT = Number(option('--min-content', '300'));
// Keep the early window small so a delayed run cannot take the next slot early.
const EARLY_MINUTES = Number(option('--early-minutes', '5'));
const LATE_MINUTES = Number(option('--late-minutes', '90'));
const SOURCE_FILTER = option('--sources', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const AI_ONLY_SOURCES = new Set(['the-decoder', 'arstechnica-ai']);
const STATE_PATH = resolve(
  ROOT,
  option('--state', SEND ? (REVIEW_SEND ? 'data/state.review.json' : 'data/state.json') : 'data/state.dry.json')
);
const OUT_ROOT = resolve(ROOT, option('--out', 'results/outbox'));
const REVIEW_ROOT = resolve(ROOT, option('--review-out', 'results/review'));
const SOURCES_FILE = option('--sources-file', 'pipeline/sources.json');

let env;
try {
  env = await loadEnv(resolve(ROOT, '.env'));
} catch {
  console.error('ENV_MISSING');
  process.exit(1);
}
const redact = makeRedactor(env);

if (!env.AMD_API_KEY) {
  console.error('AMD_API_KEY_MISSING');
  process.exit(1);
}

const config = JSON.parse(await readFile(resolve(ROOT, 'pipeline/config.json'), 'utf8'));
const MAX_CANDIDATES = Math.max(
  1,
  Number(MAX_CANDIDATES_ARG || config.diversity?.max_candidates || 8)
);
const STRICT_FRESH_HOURS = Math.min(
  ...MAIN_CATEGORIES.map((category) =>
    Number(config.freshness_hours?.[category] ?? config.freshness_hours?.pre_gate ?? 72)
  )
);
const registry = JSON.parse(await readFile(resolve(ROOT, SOURCES_FILE), 'utf8'));
const policySettings = config.policy_watch || {};
const POLICY_ENABLED = policySettings.enabled !== false;
const defaultPolicyState = SEND
  ? REVIEW_SEND
    ? 'data/policy-state.review.json'
    : policySettings.state_path || 'data/policy-state.json'
  : 'data/policy-state.dry.json';
const POLICY_STATE_PATH = resolve(ROOT, option('--policy-state', defaultPolicyState));
let policyState = { targets: {} };
try {
  const savedPolicy = JSON.parse(await readFile(POLICY_STATE_PATH, 'utf8'));
  if (savedPolicy && typeof savedPolicy === 'object') policyState = savedPolicy;
} catch {
  policyState = { targets: {} };
}
const vendorDocument = JSON.parse(
  await readFile(resolve(ROOT, config.offers?.watch?.vendors_file || 'pipeline/vendors.json'), 'utf8')
);
const linkVendors = Array.isArray(vendorDocument.vendors) ? vendorDocument.vendors : [];
const system = await readFile(resolve(ROOT, 'bench/system-prompt.md'), 'utf8');
const base = option('--base', env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, '');
const REVIEW_CHAT_ID = env[config.offers?.review?.chat_env || 'TELEGRAM_REVIEW_CHAT_ID'] || '';
const CHAT_ID = REVIEW_SEND ? REVIEW_CHAT_ID : option('--chat-id', env.TELEGRAM_CHAT_ID);
const RUN_MODE = SEND ? (REVIEW_SEND ? 'send_review' : 'send') : 'dry';

if (SEND && (!env.TELEGRAM_BOT_TOKEN || !CHAT_ID)) {
  console.error('TELEGRAM_CREDENTIALS_MISSING');
  process.exit(1);
}

const PRIMARY = {
  role: 'primary',
  base,
  apiKey: env.AMD_API_KEY,
  model: MODEL,
  maxTokens: 2600,
  timeoutMs: 150000,
  reasoningEffort: '',
  maxContentChars: 0,
};
const FALLBACK = {
  role: 'fallback',
  base: (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  apiKey: env.GROQ_API_KEY || '',
  model: option('--fallback-model', env.GROQ_MODEL || 'openai/gpt-oss-120b'),
  maxTokens: Number(option('--fallback-max-tokens', '2000')),
  timeoutMs: Number(option('--fallback-timeout-ms', '90000')),
  reasoningEffort: option('--fallback-reasoning', 'low'),
  maxContentChars: Number(option('--fallback-content-chars', '6000')),
};
const FALLBACK_ENABLED = Boolean(FALLBACK.apiKey) && !flag('--no-fallback');
if (FALLBACK_ENABLED) {
  FALLBACK.system = await readFile(
    resolve(ROOT, option('--fallback-prompt', 'bench/system-prompt-emergency.md')),
    'utf8'
  );
}

const writerOptions = (writer, user) => ({
  base: writer.base,
  apiKey: writer.apiKey,
  model: writer.model,
  system: writer.system || system,
  user,
  maxTokens: writer.maxTokens,
  timeoutMs: writer.timeoutMs,
  reasoningEffort: writer.reasoningEffort,
  redact,
});
const usageOf = (result) => {
  const usage = result?.usage ?? {};
  return { cost: Number(usage.cost ?? 0) || 0, tokens: Number(usage.total_tokens ?? 0) || 0 };
};

function activeSlot() {
  if (SLOT) {
    if (!config.schedule.slots.includes(SLOT)) {
      console.error(`UNKNOWN_SLOT ${SLOT}`);
      process.exit(1);
    }
    const date = DATE || dateKey(NOW);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error(`BAD_DATE ${date}`);
      process.exit(1);
    }
    const start = slotStart(date, SLOT);
    const diffMinutes = (Date.parse(NOW) - start.getTime()) / 60000;
    // --force is a manual override: scheduled runs never pass it.
    if (!FORCE && diffMinutes < -EARLY_MINUTES) {
      console.log(`SLOT_NOT_DUE ${slotKey(date, SLOT)} starts ${start.toISOString()}`);
      process.exit(0);
    }
    if (!FORCE && diffMinutes > LATE_MINUTES) {
      console.log(`SLOT_EXPIRED ${slotKey(date, SLOT)} started ${start.toISOString()}`);
      process.exit(0);
    }
    return { ready: true, date, slot: SLOT, key: slotKey(date, SLOT), startsAt: start.toISOString() };
  }

  const resolved = resolveSlot(NOW, {
    slots: config.schedule.slots,
    earlyMinutes: EARLY_MINUTES,
    lateMinutes: LATE_MINUTES,
  });
  if (!resolved.ready) {
    console.log(`NO_ACTIVE_SLOT next=${resolved.next.key} starts ${resolved.next.startsAt}`);
    process.exit(0);
  }
  return resolved;
}

function outboxDir(slot, index = 1) {
  const [date, time] = String(slot).split('T');
  const base = resolve(OUT_ROOT, date, time.slice(0, 5).replace(':', '-'));
  return index > 1 ? `${base}-${index}` : base;
}

function categoryCapOf(category) {
  const value = config.diversity?.max_per_category_per_day;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Math.max(0, Number(value[category] ?? 3));
  }
  return Math.max(0, Number(value ?? 3));
}

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const MAIN_STATE_FILE = option('--main-state', 'data/state.json');
const REVIEW_STATE_FILE = option('--review-state', 'data/state.review.json');
const MEMORY_DAYS = 30;

async function loadMemoryLanes() {
  if (REVIEW_SEND) {
    return [{ lane: 'main', state: await loadState(resolve(ROOT, MAIN_STATE_FILE)) }];
  }
  if (SEND) {
    return [{ lane: 'review', state: await loadState(resolve(ROOT, REVIEW_STATE_FILE)) }];
  }
  return [
    { lane: 'main', state: await loadState(resolve(ROOT, MAIN_STATE_FILE)) },
    { lane: 'review', state: await loadState(resolve(ROOT, REVIEW_STATE_FILE)) },
  ];
}

const importanceOf = (body) => {
  const before = String(body ?? '').split(/^[ \t]*(?:منبع|لینک استفاده)\s*[:：]/m)[0];
  return before.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).at(-1) ?? '';
};

function siteKey(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function recheckOpenOffers({ state, now, config }) {
  const entries = Object.values(state.openOffers ?? {}).filter((entry) => entry && entry.url);
  if (!entries.length) return;
  const nowMs = Date.parse(String(now));
  const windowDays = Math.max(1, Number(config.offers?.no_expiry_window_days ?? 14) || 14);
  const recheckHours = Math.max(1, Number(config.offers?.no_expiry_recheck_hours ?? 6) || 6);
  const windowMs = windowDays * 86400000;
  let checked = 0;
  for (const entry of entries) {
    if (entry.status !== 'active') continue;
    const firstMs = Date.parse(String(entry.firstSeen || ''));
    if (Number.isFinite(firstMs) && nowMs - firstMs > windowMs) {
      entry.status = 'expired_window';
      entry.closedAt = new Date(nowMs).toISOString();
      console.log(`OPEN_OFFER window_closed ${entry.key}`);
      continue;
    }
    const lastMs = Date.parse(String(entry.lastCheck || ''));
    if (Number.isFinite(lastMs) && nowMs - lastMs < recheckHours * 3600000) continue;
    if (checked >= 6) break;
    checked += 1;
    try {
      const page = await fetchText(entry.url, { redact });
      const article = extractArticle(page.text, entry.title || '', page.url || entry.url);
      const found = detectOffer({ title: article.title || entry.title || '', content: article.content });
      entry.lastCheck = new Date(nowMs).toISOString();
      if (found.isOffer) {
        entry.misses = 0;
        console.log(`OPEN_OFFER active ${entry.key}`);
      } else {
        entry.misses = Number(entry.misses ?? 0) + 1;
        if (entry.misses >= 2) {
          markOpenEndedEnded(state, entry.key, entry.lastCheck);
          console.log(`OPEN_OFFER ended ${entry.key} misses=${entry.misses}`);
        } else {
          console.log(`OPEN_OFFER miss ${entry.key} (${entry.misses}/2)`);
        }
      }
    } catch (error) {
      entry.lastCheck = new Date(nowMs).toISOString();
      console.log(`OPEN_OFFER check_failed ${entry.key} ${redact(String(error?.message ?? error))}`);
    }
  }
  await saveState(STATE_PATH, state);
}

async function main() {
  const slot = activeSlot();
  const state = await loadState(STATE_PATH);
  if (!NO_OFFERS) await recheckOpenOffers({ state, now: NOW, config });
  const memoryLanes = await loadMemoryLanes();
  const quiet = !REVIEW_SEND && inQuietHours(NOW, config.schedule.quiet_hours);
  const reviewEnabled = config.offers?.review?.enabled !== false;
  const reviewPrune = {
    reviewPendingHours: config.offers?.review?.pending_ttl_hours,
    reviewPendingCap: config.offers?.review?.max_pending,
  };
  const reviewStates = [state, ...memoryLanes.map(({ state: laneState }) => laneState)];
  let reviewUsage = offerReviewUsage(reviewStates, NOW);
  const attempts = [];
  let reviews = 0;
  let previousWhy = [...(state.published ?? [])].reverse().find((entry) => entry.why)?.why ?? '';
  const week = weekKey(slot.date);
  let quota = quotaSnapshot(config, state, week);
  let budget = dailyBudget({ config, state, date: slot.date });
  const postsPerSlot = Math.max(1, Number(config.schedule?.max_posts_per_slot ?? 1) || 1);
  const minGapMs = Math.max(0, Number(config.schedule?.min_gap_minutes ?? 0) || 0) * 60000;
  const allDeferred = Object.values(state.deferred ?? {});
  const deferredEntries = listDeferred(state, NOW, { ttlHours: DEFER_TTL_HOURS })
    .filter((entry) => !findSeen(state, entry.keys ?? []));
  let deferredCandidates = deferredEntries.map((entry) => ({
    ...entry.candidate,
    deferred: { id: entry.id, attempts: entry.attempts },
  }));
  const deferredIds = new Set(allDeferred.map((entry) => entry.id));
  const deferredKeys = new Set(allDeferred.flatMap((entry) => entry.keys ?? []));
  const matchesDeferred = (candidate) =>
    deferredIds.has(deferredId(candidate)) || (candidate.keys ?? []).some((key) => deferredKeys.has(key));

  console.log(`SLOT ${slot.key} | WEEK ${week} | MODE ${RUN_MODE.toUpperCase()}`);
  console.log(`QUOTA ${MAIN_CATEGORIES.map((category) => `${category} ${quota[category].used}/${quota[category].quota}`).join(' | ')}`);
  console.log(`DAILY ${budget.used}/${budget.cap}`);
  console.log(`DIVERSITY_TARGET ${slotTarget(config, slot.date, slot.slot) || 'any'} | slot ${slot.slot}`);
  if (deferredEntries.length) {
    console.log(`DEFERRED_POOL ${deferredEntries.length}`);
    for (const entry of deferredEntries.slice(0, 5)) {
      console.log(`  DEFERRED ${entry.reason || 'unknown'} | try ${entry.attempts}/${MAX_DEFER_ATTEMPTS} | ${entry.title}`);
    }
  }
  const exhaustedDeferred = allDeferred.filter((entry) => Number(entry.attempts ?? 0) >= MAX_DEFER_ATTEMPTS).length;
  if (exhaustedDeferred) console.log(`DEFERRED_EXHAUSTED ${exhaustedDeferred}`);

  function reviewPayload({
    candidate,
    article,
    assessment,
    reason,
    kind,
    mainEligible = false,
    post = null,
    text = '',
    note = '',
  }) {
    const effectiveReason = reason || assessment?.reason || 'review';
    const resolvedKind =
      kind || (assessment?.expiry ? 'offer' : candidate?.toolHint ? 'tool' : 'post');
    const url = article?.url || candidate?.canonical || candidate?.link || '';
    const title = article?.title || candidate?.title || '';
    const payload = {
      id: `${dateKey(NOW)}|${candidate?.sourceId || candidate?.leadSource || 'unknown'}|${url || title}`,
      source: candidate?.sourceId || candidate?.leadSource || '',
      sourceName: candidate?.sourceName || '',
      title,
      url,
      reason: effectiveReason,
      kind: resolvedKind,
      mainEligible: Boolean(mainEligible),
      needsLinkApproval: Boolean(candidate?.needsLinkApproval || effectiveReason === 'link_missing'),
      slot: slot.key,
      at: NOW,
      publishedAt: article?.published || candidate?.published || '',
      keys: candidate?.keys ?? [],
      leadPostUrl: candidate?.leadPostUrl ?? '',
      messageText: candidate?.messageText ?? '',
      expiry: assessment?.expiry ?? null,
      text: '',
      html: '',
    };
    payload.text = reviewText({
      article,
      candidate,
      assessment: { ...(assessment ?? {}), reason: effectiveReason },
      offer: resolvedKind === 'offer' ? { isOffer: true } : null,
      kind: resolvedKind,
      mainEligible,
      note,
      post,
      text,
    });
    if (post) {
      payload.html = reviewHtml({
        article,
        candidate,
        assessment: { ...(assessment ?? {}), reason: effectiveReason },
        kind: resolvedKind,
        mainEligible,
        note,
        post,
      });
    }
    return payload;
  }

  async function writeReviewFiles(payload) {
    const slug = contentHash(payload.url || payload.title).slice(0, 8);
    const dir = resolve(REVIEW_ROOT, slot.date, `${slot.slot.replace(':', '-')}-${slug}`);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, 'review.json'), JSON.stringify({
      slot: slot.key,
      mode: RUN_MODE,
      kind: payload.kind,
      reason: payload.reason,
      main_eligible: payload.mainEligible,
      needs_link_approval: Boolean(payload.needsLinkApproval),
      source: { id: payload.source, name: payload.sourceName, url: payload.url },
      title: payload.title,
      published_at: payload.publishedAt,
      expiry: payload.expiry,
      note: 'این مورد به کانال اصلی منتشر نشده و فقط برای بازبینی ثبت شده است.',
      createdAt: NOW,
    }, null, 2));
    await writeFile(resolve(dir, 'review.txt'), `${payload.text}\n`);
    if (payload.html) await writeFile(resolve(dir, 'review.html'), `${payload.html}\n`);
    return dir;
  }

  async function sendReviewText(text, html = '') {
    if (!SEND) return { messageId: null, sendError: '' };
    if (!reviewEnabled) return { messageId: null, sendError: 'REVIEW_DISABLED' };
    if (!REVIEW_CHAT_ID) return { messageId: null, sendError: 'REVIEW_CREDENTIALS_MISSING' };
    try {
      const sent = await sendText(html || text, {
        token: env.TELEGRAM_BOT_TOKEN,
        chatId: REVIEW_CHAT_ID,
        parseMode: html ? 'HTML' : '',
      });
      return { messageId: sent.messageId ?? null, sendError: '' };
    } catch (error) {
      return { messageId: null, sendError: redact(String(error?.message ?? error)) };
    }
  }

  function markReviewSeen(candidate, decision, reason) {
    if (!candidate?.keys?.length) return;
    markSeen(state, candidate.keys, {
      decision,
      reason,
      category: '',
      slot: slot.key,
      title: candidate.title,
      url: candidate.canonical,
    });
  }

  async function deliverReview(input) {
    const payload = reviewPayload(input);
    const capacity = reviewCapacity({ config, usage: reviewUsage, sourceKey: payload.source });
    if (!capacity.ok) {
      enqueueReviewPending(state, payload);
      markReviewSeen(input.candidate, 'review_pending', `${payload.reason}:${capacity.reason}`);
      attempts.push({ title: payload.title, result: 'review_queued', reason: payload.reason, cap: capacity.reason });
      console.log(
        `  REVIEW_QUEUED reason=${payload.reason} cap=${capacity.reason} pending=${Object.keys(state.reviewPending ?? {}).length}`
      );
      await saveState(STATE_PATH, state);
      return { queued: true, payload };
    }

    const dir = await writeReviewFiles(payload);
    const { messageId, sendError } = await sendReviewText(payload.text, payload.html);
    if (SEND && !messageId) {
      enqueueReviewPending(state, {
        ...payload,
        attempts: Number(state.reviewPending?.[payload.id]?.attempts ?? 0) + 1,
      });
      markReviewSeen(input.candidate, 'review_pending', `${payload.reason}:review_send_failed`);
      attempts.push({ title: payload.title, result: 'review_queued', reason: payload.reason, detail: sendError });
      console.log(`  REVIEW_SEND_FAILED ${sendError} | pending kept`);
      await saveState(STATE_PATH, state);
      return { queued: true, payload, dir };
    }

    recordOfferReview(state, {
      source: payload.source,
      title: payload.title,
      url: payload.url,
      reason: payload.reason,
      slot: slot.key,
      at: NOW,
      mainEligible: payload.mainEligible,
      kind: payload.kind,
    });
    reviewUsage = offerReviewUsage(reviewStates, NOW);
    markReviewSeen(input.candidate, 'review', payload.reason);
    reviews += 1;
    attempts.push({ title: payload.title, result: 'review', reason: payload.reason, dir });
    console.log(`  REVIEW_REQUIRED reason=${payload.reason}${messageId ? ` sent=${messageId}` : ''}`);
    console.log(`  REVIEW_DIR ${dir}`);
    await saveState(STATE_PATH, state);
    return { queued: false, payload, dir, messageId };
  }

  async function flushPendingReviews() {
    const pending = listReviewPending(state, NOW, {
      ttlHours: config.offers?.review?.pending_ttl_hours,
    });
    if (!pending.length) return;
    console.log(`REVIEW_PENDING pool=${pending.length}`);
    for (const entry of pending) {
      const capacity = reviewCapacity({ config, usage: reviewUsage, sourceKey: entry.source });
      if (!capacity.ok) {
        console.log(`  REVIEW_PENDING_WAIT ${entry.sourceName || entry.source} | ${capacity.reason}`);
        continue;
      }
      const payload = { ...entry, text: refreshQueuedReviewText(entry.text, entry.reason) };
      const dir = await writeReviewFiles(payload);
      const { messageId, sendError } = await sendReviewText(payload.text, entry.html || '');
      if (SEND && !messageId) {
        entry.attempts = Number(entry.attempts ?? 0) + 1;
        state.reviewPending[entry.id] = entry;
        console.log(`  REVIEW_SEND_FAILED ${sendError} | pending kept`);
        continue;
      }
      recordOfferReview(state, {
        source: entry.source,
        title: entry.title,
        url: entry.url,
        reason: entry.reason,
        slot: slot.key,
        at: NOW,
        mainEligible: entry.mainEligible,
        kind: entry.kind,
      });
      reviewUsage = offerReviewUsage(reviewStates, NOW);
      if (entry.keys?.length) {
        markSeen(state, entry.keys, {
          decision: 'review',
          reason: entry.reason,
          category: '',
          slot: slot.key,
          title: entry.title,
          url: entry.url,
        });
      }
      removeReviewPending(state, entry.id);
      reviews += 1;
      attempts.push({ title: entry.title, result: 'review_flushed', reason: entry.reason, dir });
      console.log(`  REVIEW_FLUSHED reason=${entry.reason}${messageId ? ` sent=${messageId}` : ''}`);
      await saveState(STATE_PATH, state);
    }
  }

  async function runOfferWatch() {
    const watch = config.offers?.watch ?? {};
    if (watch.enabled === false || !reviewEnabled) return;
    if (watch.first_slot_only === true && slot.slot !== config.schedule?.slots?.[0]) return;
    if (state.offerWatch?.lastDate === slot.date) return;

    let vendors;
    try {
      vendors = JSON.parse(
        await readFile(resolve(ROOT, watch.vendors_file || 'pipeline/vendors.json'), 'utf8')
      );
    } catch (error) {
      console.log(`OFFER_WATCH_VENDORS_FAILED ${redact(String(error?.message ?? error))}`);
      return;
    }
    const targets = selectTargets(vendors, {
      priorities: watch.priorities ?? ['very_high', 'high'],
    });
    if (!targets.length) {
      console.log('OFFER_WATCH_NO_TARGETS');
      return;
    }

    const watchStatePath = resolve(
      ROOT,
      SEND ? watch.state_path || 'data/offer-watch.json' : 'data/offer-watch.dry.json'
    );
    let report;
    try {
      report = await watchOnce({
        targets,
        now: NOW,
        outDir: resolve(ROOT, 'results/offer-watch'),
        timeout: Number(watch.timeout_ms ?? 15000),
        statePath: watchStatePath,
        snapshots: false,
        includeBaselineOffers: true,
        log: (line) => console.log(`  ${line}`),
      });
    } catch (error) {
      console.log(`OFFER_WATCH_FAILED ${redact(String(error?.message ?? error))}`);
      return;
    }
    console.log(
      `OFFER_WATCH targets=${report.targets} fetched=${report.fetched} failed=${report.failed} changed=${report.changed} baseline=${report.baseline} offers=${report.offers} reviews=${report.reviews}`
    );

    const found = [];
    for (const result of report.results ?? []) {
      const offer = result?.offer;
      if (!offer || !['publish', 'review'].includes(offer.status)) continue;
      found.push({ result, offer });
    }
    found.sort((left, right) => {
      if (left.offer.status !== right.offer.status) return left.offer.status === 'publish' ? -1 : 1;
      const leftHours = Number(left.offer.expiry?.remainingHours ?? 9999);
      const rightHours = Number(right.offer.expiry?.remainingHours ?? 9999);
      return leftHours - rightHours;
    });
    const selected = found;

    for (const { result, offer } of selected) {
      const key = `offerwatch:${contentHash(`${result.id}\n${offer.content}`)}`;
      await deliverReview({
        candidate: {
          sourceId: `offer-watch:${result.id}`,
          sourceName: result.name,
          leadSource: 'offer-watch',
          title: offer.title,
          link: result.url,
          canonical: result.url,
          published: NOW,
          messageText: offer.content,
          images: [],
          keys: [key],
          offerHint: true,
          leadKind: 'offer',
        },
        article: null,
        assessment: { reason: 'offer_watch', expiry: offer.expiry },
        reason: 'offer_watch',
        kind: 'offer',
        mainEligible: offer.status === 'publish',
        text: offer.content,
        note:
          offer.status === 'publish'
            ? 'آفر تازه از صفحه رسمی سازنده پیدا شد و در سهمیه آفر واجد شرایط است؛ نسخه نهایی فقط پس از تأیید شما به کانال اصلی می‌رود.'
            : 'آفر رصدشده شرایط انتشار خودکار را ندارد و فقط برای بررسی ثبت شده است.',
      });
    }

    state.offerWatch = {
      lastDate: slot.date,
      at: NOW,
      found: found.length,
      delivered: selected.length,
    };
    await saveState(STATE_PATH, state);
  }

  if (reviewEnabled) await flushPendingReviews();
  if (reviewEnabled && !NO_OFFERS) await runOfferWatch();

  if (isSlotSettled(state, slot.key) && !FORCE) {
    console.log(`SLOT_ALREADY_DONE ${slot.key} status=${state.slots[slot.key].status}`);
    console.log('NOTHING_WAS_SENT');
    return;
  }
  if (MAIN_CATEGORIES.every((category) => quota[category].remaining === 0)) {
    markSlot(state, slot.key, { status: 'empty', reason: 'quota_full' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=quota_full');
    console.log('NOTHING_WAS_SENT');
    return;
  }
  if (!budget.ok) {
    markSlot(state, slot.key, { status: 'empty', reason: 'daily_cap' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=daily_cap');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  let sources = registry.sources.filter((source) => {
    if (source.type === 'telegram_channel') {
      return (
        !NO_TELEGRAM &&
        config.telegram_discovery?.enabled !== false &&
        Boolean(source.username)
      );
    }
    return (
      Boolean(source.feed_url) ||
      (source.use === 'page' && Boolean(source.index_url)) ||
      (source.use === 'api' && Boolean(source.api_url)) ||
      (source.use === 'policy' && POLICY_ENABLED && Array.isArray(source.watch_urls)) ||
      (source.use === 'benchmark' && Boolean(source.commits_url) && Boolean(source.data_url))
    );
  });
  if (SOURCE_FILTER.length) {
    sources = sources.filter((source) => SOURCE_FILTER.includes(source.id));
    if (sources.length === 0) {
      console.error(`NO_SOURCES_MATCH ${SOURCE_FILTER.join(',')}`);
      process.exit(1);
    }
  }

  const { candidates, stats } = await collectCandidates({
    sources,
    state,
    memoryStates: memoryLanes.map(({ state: memoryState }) => memoryState),
    now: NOW,
    perSource: PER_SOURCE,
    maxAgeHours: config.freshness_hours.pre_gate,
    redact,
    telegram: config.telegram_discovery,
    hfPapers: config.hf_papers,
    policyState,
    policy: {
      reminder_days: Number(policySettings.reminder_days ?? 7),
      slot_date: slot.date,
    },
  });
  if (sources.some((source) => source.use === 'policy')) {
    await mkdir(resolve(ROOT, 'data'), { recursive: true });
    await writeFile(POLICY_STATE_PATH, `${JSON.stringify(policyState, null, 2)}\n`);
    console.log(`POLICY_STATE saved`);
  }
  console.log(`COLLECT sources=${stats.sources} items=${stats.feedItems} index=${stats.indexItems} benchmark=${stats.benchmarkItems} policy=${stats.policyItems} policy_changes=${stats.policyChanges} policy_reminder=${stats.policyReminder} api=${stats.apiItems} stale=${stats.stale} nodate=${stats.noDate} nonai=${stats.nonAi} dup=${stats.duplicate} dup_other=${stats.crossLane} kept=${stats.kept} errors=${stats.errors.length}`);
  for (const error of stats.errors) {
    const label =
      error.kind === 'telegram'
        ? 'TELEGRAM_ERROR'
        : error.kind === 'benchmark'
          ? 'INDEX_ERROR'
          : error.kind === 'api'
            ? 'API_ERROR'
            : error.kind === 'policy'
              ? 'POLICY_ERROR'
              : 'FEED_ERROR';
    console.log(`  ${label} ${error.source}: ${error.error}`);
  }
  const tg = stats.telegram;
  for (const candidate of candidates) {
    if (!candidate.offerHint || candidate.reviewReason !== 'no_link') continue;
    const resolved = resolveVendorLink(
      `${candidate.title}\n${candidate.messageText ?? ''}`,
      linkVendors
    );
    if (!resolved) {
      candidate.reviewReason = 'link_missing';
      candidate.needsLinkApproval = true;
      console.log(`LINK_MISSING ${candidate.leadSource || candidate.sourceId} | ${candidate.title}`);
      continue;
    }
    candidate.link = resolved.url;
    try {
      candidate.canonical = canonicalUrl(resolved.url);
    } catch {
      candidate.reviewReason = 'link_missing';
      candidate.needsLinkApproval = true;
      console.log(`LINK_MISSING bad_url ${resolved.url}`);
      continue;
    }
    candidate.resolvedLink = true;
    candidate.vendor = resolved.vendor;
    candidate.vendorUrl = resolved.url;
    candidate.needsReview = false;
    candidate.reviewReason = '';
    console.log(`LINK_RESOLVED vendor=${resolved.vendor} url=${resolved.url}`);
  }
  if (tg.channels > 0) {
    console.log(
      `TELEGRAM channels=${tg.channels} posts=${tg.posts} pending=${tg.pending} leads=${tg.leads} nolink=${tg.noLink} nonai=${tg.nonAiEducation} denied=${tg.denied} promo=${tg.promoted} stale=${tg.stale} before=${tg.beforeStart} dup=${tg.duplicate} dup_other=${tg.crossLane}${tg.truncated ? ` capped=${tg.truncated}` : ''}`
    );
  }
  await saveState(STATE_PATH, state);

  const deliveredLanes = [
    ...(SEND ? [{ lane: REVIEW_SEND ? 'review' : 'main', state }] : []),
    ...memoryLanes,
  ];
  const delivered = deliveredEntries(deliveredLanes, NOW, { days: MEMORY_DAYS });
  const laneSummary = deliveredLanes
    .map(({ lane }) => `${lane}:${delivered.filter((entry) => entry.lane === lane).length}`)
    .join(',');
  console.log(`MEMORY lanes=${laneSummary || 'none'} delivered=${delivered.length} window=${MEMORY_DAYS}d`);

  const educationHinted = candidates.filter((candidate) => candidate.educationHint);
  const educationSet = new Set(educationHinted);
  let mainCandidates = candidates.filter((candidate) => !educationSet.has(candidate));
  let educationLeads = educationHinted;
  const educationDuplicates = [];
  let memoryChanged = false;
  if (educationHinted.length) {
    const sendableLeads = [];
    for (const candidate of educationHinted) {
      const match = findStoryDuplicate(candidate, delivered);
      if (match) educationDuplicates.push({ candidate, match });
      else sendableLeads.push(candidate);
    }
    educationLeads = sendableLeads;
    if (educationDuplicates.length) {
      console.log(`TELEGRAM_EDU_DUPLICATES ${educationDuplicates.length} skipped=worked_story`);
      for (const { candidate, match } of educationDuplicates) {
        console.log(`  EDU_DUPLICATE ${candidate.leadSource} | ${candidate.title} | already ${match.lane}: ${match.title}`);
        if (SEND && candidate.keys?.length) {
          markSeen(state, candidate.keys, {
            decision: 'education_duplicate',
            reason: `already_${match.lane}`,
            category: '',
            slot: slot.key,
            title: candidate.title,
            url: candidate.canonical,
          });
          memoryChanged = true;
        }
      }
    }
  }

  const mainStoryDuplicates = [];
  const sendableMain = [];
  for (const candidate of mainCandidates) {
    const match = findStoryDuplicate(candidate, delivered);
    if (match) mainStoryDuplicates.push({ candidate, match });
    else sendableMain.push(candidate);
  }
  mainCandidates = sendableMain;
  if (mainStoryDuplicates.length) {
    console.log(`STORY_DUPLICATES ${mainStoryDuplicates.length} skipped=worked_story`);
    for (const { candidate, match } of mainStoryDuplicates) {
      console.log(`  STORY_DUPLICATE ${candidate.sourceName} | ${candidate.title} | already ${match.lane}: ${match.title}`);
      if (SEND && candidate.keys?.length) {
        markSeen(state, candidate.keys, {
          decision: 'story_duplicate',
          reason: `already_${match.lane}`,
          category: '',
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
        memoryChanged = true;
      }
    }
  }

  const deferredStoryDuplicates = [];
  const sendableDeferred = [];
  for (const candidate of deferredCandidates) {
    const match = findStoryDuplicate(candidate, delivered);
    if (match) deferredStoryDuplicates.push({ candidate, match });
    else sendableDeferred.push(candidate);
  }
  deferredCandidates = sendableDeferred;
  if (deferredStoryDuplicates.length) {
    console.log(`DEFERRED_STORY_DUPLICATES ${deferredStoryDuplicates.length} skipped=worked_story`);
    for (const { candidate, match } of deferredStoryDuplicates) {
      console.log(`  DEFERRED_DUPLICATE ${candidate.sourceName} | ${candidate.title} | already ${match.lane}: ${match.title}`);
      if (SEND) {
        if (candidate.deferred?.id) clearDeferred(state, { id: candidate.deferred.id });
        if (candidate.keys?.length) {
          markSeen(state, candidate.keys, {
            decision: 'story_duplicate',
            reason: `already_${match.lane}`,
            category: '',
            slot: slot.key,
            title: candidate.title,
            url: candidate.canonical,
          });
        }
        memoryChanged = true;
      }
    }
  }
  if (SEND && memoryChanged) await saveState(STATE_PATH, state);

  const reviewReasonOf = (candidate) => candidate.reviewReason || 'referral_link';
  const reviewNoteOf = (reason) => {
    if (reason === 'research_paper') {
      return 'این مقاله پژوهشی برای بازبینی جدا شده و به کانال اصلی نرفته است.';
    }
    if (reason === 'link_missing') {
      return 'لینک معتبر پیدا نشد؛ این مورد فقط برای تأیید لینک و ارسال به کانال اصلی ثبت شده است.';
    }
    return 'لینک این سرنخ ارجاعی یا تبلیغی است و پیش از انتشار باید بررسی شود.';
  };

  const reviewLeads = mainCandidates.filter((candidate) => candidate.needsReview);
  mainCandidates = mainCandidates.filter((candidate) => !candidate.needsReview);
  const REVIEW_DRAFT_MIN_CHARS = 320;
  const reviewSpend = { cost: 0, tokens: 0 };

  async function prepareReviewDraft(candidate) {
    const content = String(candidate.messageText ?? '').trim();
    if (content.length < REVIEW_DRAFT_MIN_CHARS) return { post: null, qa: null, reason: 'short' };
    if (candidate.offerHint || candidate.officialCourse || candidate.educationHint) {
      return { post: null, qa: null, reason: 'not_news' };
    }
    const rawImage = String(candidate.images?.[0] ?? '');
    const verdict = imageVerdict(rawImage, '');
    const imageUrl = verdict.ok ? rawImage : '';
    const article = {
      title: candidate.title || '',
      description: '',
      published: candidate.published || '',
      modified: '',
      imageUrl,
      imageAlt: '',
      content,
      url: candidate.link || candidate.leadPostUrl || '',
    };
    const newsDate = newsDateLine(candidate.published);
    const story = {
      item: { title: candidate.title, published: candidate.published },
      article,
      url: article.url,
      now: NOW,
      imageUrl,
      maxAgeHours: config.freshness_hours.pre_gate,
      toolUrl: candidate.relatedLinks?.[0] ?? '',
    };
    console.log(`REVIEW_DRAFT ${candidate.sourceName} | ${candidate.title} | ${content.length} chars`);
    let call;
    try {
      call = await callWithRetry(writerOptions(PRIMARY, buildUserMessage(story)), 3, console.log);
    } catch (error) {
      console.log(`  REVIEW_DRAFT_FAILED ${redact(String(error?.message ?? error))}`);
      return { post: null, qa: null, reason: 'model_failed' };
    }
    const cost = usageOf(call).cost;
    const tokens = usageOf(call).tokens;
    reviewSpend.cost += cost;
    reviewSpend.tokens += tokens;
    const parsed = extractJson(call.content);
    if (!parsed) return { post: null, qa: null, reason: 'model_failed', cost, tokens };
    if (parsed.decision === 'skip') {
      return { post: null, qa: null, reason: 'model_skip', detail: parsed.reason, cost, tokens };
    }
    const fixed = applyMechanicalFixes(applyLeadPolicy(parsed, candidate), {
      sourceName: candidate.sourceName,
      sourceUrl: article.url,
      imageUrl,
      newsDate,
      sourceType: candidate.sourceType,
    });
    const host = (() => {
      try {
        return new URL(article.url).hostname;
      } catch {
        return '';
      }
    })();
    const qa = qaPost(fixed, {
      url: article.url,
      host,
      sourceType: candidate.sourceType,
      category: fixed.category,
      imageUrl,
      title: article.title,
      description: '',
      content,
      links: candidate.relatedLinks ?? [],
      usageUrl: '',
      publishedAt: candidate.published,
      now: NOW,
      newsDate,
    });
    console.log(
      `  REVIEW_DRAFT_QA ${qa.pass ? 'PASS' : 'FAIL'} ${qa.problems.join(',') || 'none'} | $${cost.toFixed(6)}`
    );
    return { post: fixed, qa, reason: qa.pass ? 'ok' : 'qa_failed', cost, tokens };
  }

  if (reviewLeads.length) {
    console.log(`REVIEW_LEADS ${reviewLeads.length} separate_from_main=yes cap=none`);
    const reviewSeen = [];
    for (const candidate of reviewLeads) {
      const duplicate = findStoryDuplicate(candidate, reviewSeen);
      if (duplicate) {
        console.log(`  REVIEW_DUPLICATE ${candidate.sourceName} | ${candidate.title} | ${duplicate.title}`);
        markReviewSeen(candidate, 'review_duplicate', 'duplicate_in_review');
        await saveState(STATE_PATH, state);
        continue;
      }
      reviewSeen.push({ title: candidate.title, url: candidate.canonical, lane: 'review' });
      const reason = reviewReasonOf(candidate);
      const kind = candidate.offerHint ? 'offer' : candidate.toolHint ? 'tool' : 'post';
      const draft = await prepareReviewDraft(candidate);
      const note = draft.post
        ? draft.qa?.pass
          ? reviewNoteOf(reason)
          : `QA کامل پاس نشد: ${draft.qa?.problems?.join(', ') || draft.reason}. قبل از انتشار اصلاح کن.`
        : draft.reason === 'model_skip'
          ? `مدل این مورد را رد کرد: ${String(draft.detail ?? '').slice(0, 300)}`
          : reviewNoteOf(reason);
      await deliverReview({
        candidate,
        article: null,
        assessment: { reason },
        reason,
        kind,
        mainEligible: Boolean(draft.post && draft.qa?.pass),
        post: draft.post,
        text: candidate.messageText,
        note,
      });
    }
  }

  if (educationLeads.length) {
    const verbatim = config.education_review?.verbatim !== false;
    const maxTextChars = Math.max(0, Number(config.education_review?.max_text_chars ?? 0) || 0);
    const includeImage = config.education_review?.include_image !== false;
    console.log(
      `TELEGRAM_EDU_LEADS ${educationLeads.length} selected=${educationLeads.length} cap=none source_cap=none private_only=yes verbatim=${verbatim ? 'yes' : 'no'}`
    );
    for (const candidate of educationLeads) {
      const label = candidate.leadSource || candidate.sourceName || candidate.sourceId || 'unknown';
      console.log(`  EDU_LEAD ${label} | ${candidate.leadKind} | ${candidate.title}`);
    }

    const prepared = educationLeads.map((candidate) => ({
      candidate,
      messages: buildEducationForward(candidate, { maxTextChars }),
      photo: includeImage ? String(candidate.images?.[0] ?? '') : '',
    }));

    const eduDir = resolve(REVIEW_ROOT, slot.date, `${slot.slot.replace(':', '-')}-education`);
    await mkdir(eduDir, { recursive: true });
    const transcript = [];
    for (const { candidate, messages } of prepared) {
      const slug = contentHash(candidate.canonical || candidate.title).slice(0, 8);
      await writeFile(resolve(eduDir, `${slug}.txt`), `${messages.join('\n\n')}\n`);
      const label = candidate.leadSource || candidate.sourceName || candidate.sourceId || 'unknown';
      transcript.push(`### ${label} | ${candidate.title}\n\n${messages.join('\n\n')}`);
    }
    const digestPath = resolve(eduDir, 'education.txt');
    await writeFile(digestPath, `${transcript.join('\n\n---\n\n')}\n`);

    const sentIds = [];
    let sentCount = 0;
    let digestError = '';
    let sentAnything = false;
    if (SEND && config.telegram_discovery?.education_review !== false && REVIEW_CHAT_ID) {
      for (const { candidate, messages, photo } of prepared) {
        let leadSent = 0;
        for (const [index, message] of messages.entries()) {
          if (sentAnything) await sleep(1200);
          try {
            const usePhoto = photo && index === 0 && message.length <= 1024;
            let sent;
            try {
              sent = usePhoto
                ? await sendPhotoUrl(message, photo, {
                    token: env.TELEGRAM_BOT_TOKEN,
                    chatId: REVIEW_CHAT_ID,
                  })
                : await sendText(message, {
                    token: env.TELEGRAM_BOT_TOKEN,
                    chatId: REVIEW_CHAT_ID,
                  });
            } catch (error) {
              if (!usePhoto) throw error;
              console.log(`  EDU_PHOTO_FALLBACK ${redact(String(error?.message ?? error))}`);
              sent = await sendText(message, {
                token: env.TELEGRAM_BOT_TOKEN,
                chatId: REVIEW_CHAT_ID,
              });
            }
            if (sent.messageId) sentIds.push(sent.messageId);
            sentCount += 1;
            sentAnything = true;
            leadSent += 1;
          } catch (error) {
            digestError = redact(String(error?.message ?? error));
            break;
          }
        }
        if (leadSent === messages.length) {
          if (candidate.keys?.length) {
            markSeen(state, candidate.keys, {
              decision: 'education_review',
              reason: 'education_private',
              category: '',
              slot: slot.key,
              title: candidate.title,
              url: candidate.canonical,
            });
          }
          recordEducationReview(state, {
            source: candidate.sourceId || candidate.leadSource || '',
            title: candidate.title,
            url: candidate.canonical,
            slot: slot.key,
            at: NOW,
          });
        }
        if (/TELEGRAM_(401|403)/.test(digestError)) break;
      }
      if (sentCount) await saveState(STATE_PATH, state);
    } else if (SEND && config.telegram_discovery?.education_review === false) {
      console.log('  EDU_REVIEW_DISABLED');
    } else if (SEND) {
      console.log('  EDU_REVIEW_CREDENTIALS_MISSING');
    }
    console.log(
      `  EDU_REVIEW leads=${prepared.length} sent=${sentCount}${sentIds.length ? ` ids=${sentIds.join(',')}` : ''}${sentCount ? '' : ` mode=${RUN_MODE}`} file=${digestPath}`
    );
    if (digestError) console.log(`  EDU_REVIEW_SEND_FAILED ${redact(digestError)}`);
  }
  const courseLeads = mainCandidates.filter((candidate) => candidate.officialCourse);
  if (courseLeads.length) {
    console.log(`TELEGRAM_OFFICIAL_COURSES ${courseLeads.length} news_eligible=yes`);
    for (const candidate of courseLeads.slice(0, 5)) {
      console.log(`  COURSE_LEAD ${candidate.leadSource} | official | ${candidate.title}`);
    }
  }

  if (mainCandidates.length === 0 && deferredCandidates.length === 0) {
    const memorySkipped =
      educationDuplicates.length + mainStoryDuplicates.length + deferredStoryDuplicates.length;
    const reason = memorySkipped
      ? 'story_duplicate'
      : reviewLeads.length
        ? 'review_only'
        : educationHinted.length
          ? 'education_only'
          : 'no_candidates';
    markSlot(state, slot.key, { status: 'empty', reason });
    await saveState(STATE_PATH, state);
    console.log(`RESULT EMPTY reason=${reason}`);
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const relevantCandidates = mainCandidates.filter((candidate) =>
    candidate.offerHint ||
    candidate.toolHint ||
    candidate.needsReview ||
    candidate.officialCourse ||
    candidate.sourceType === 'official_blog' ||
    AI_ONLY_SOURCES.has(candidate.sourceId) ||
    candidate.aiCentral
  );
  const relevantSet = new Set(relevantCandidates);
  const droppedCandidates = mainCandidates.filter((candidate) => !relevantSet.has(candidate));
  console.log(`RELEVANCE candidates=${mainCandidates.length} kept=${relevantCandidates.length} dropped=${droppedCandidates.length}`);
  for (const candidate of droppedCandidates.slice(0, 8)) {
    console.log(`  SKIP_NOT_AI ${candidate.sourceName} | ${candidate.title}`);
  }
  if (droppedCandidates.length > 8) {
    console.log(`  SKIP_NOT_AI ... +${droppedCandidates.length - 8} more`);
  }
  if (relevantCandidates.length === 0 && deferredCandidates.length === 0) {
    markSlot(state, slot.key, { status: 'empty', reason: 'no_ai_candidates' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=no_ai_candidates');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const freshQueue = relevantCandidates.filter((candidate) => !matchesDeferred(candidate));
  const planned = planSlotQueue({
    config,
    state,
    date: slot.date,
    slot: slot.slot,
    week,
    candidates: [...deferredCandidates, ...freshQueue],
    maxCandidates: MAX_CANDIDATES,
  });
  const queue = planned.queue;
  const rejectedLabel =
    Object.entries(planned.rejected)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(',') || 'none';
  console.log(
    `DIVERSITY target=${planned.target || 'any'} queue=${queue.length} fresh=${freshQueue.length} deferred=${deferredCandidates.length} rejected=${rejectedLabel}`
  );
  if (queue.length) {
    console.log(`  DIVERSITY_QUEUE ${queue.map((candidate) => `${candidate.categoryHint || '?'}:${candidate.sourceName}`).join(' | ')}`);
  }
  for (const entry of planned.policyStatus ?? []) {
    if (entry.queued) {
      console.log(`POLICY_REMINDER_QUEUED pos=${entry.position}/${queue.length} target=${planned.target || 'any'} | ${entry.title}`);
    } else {
      console.log(`POLICY_REMINDER_BLOCKED reason=${entry.reason} | ${entry.title}`);
    }
  }
  const skipped = planned.skipped ?? [];
  if (skipped.length) {
    console.log(`QUEUE_SKIPPED ${skipped.length}`);
    for (const entry of skipped.slice(0, 10)) {
      console.log(`  QUEUE_SKIP ${entry.reason} | ${entry.sourceName || entry.sourceId || 'unknown'} | ${entry.title}`);
    }
    if (skipped.length > 10) {
      console.log(`  QUEUE_SKIP ... +${skipped.length - 10} more`);
    }
  }
  const softSkipReasons = new Set([
    'category_consecutive',
    'category_daily',
    'source_consecutive',
    'source_daily',
    'source_weekly',
    'quota_full',
  ]);
  const heldSkips = [];
  for (const entry of skipped) {
    const candidate = entry.candidate;
    if (!candidate || candidate.policyReminder) continue;
    if (!softSkipReasons.has(entry.reason)) continue;
    if (matchesDeferred(candidate)) continue;
    if (findSeen(state, candidate.keys ?? [])) continue;
    const held = deferCandidate(state, candidate, { reason: entry.reason, hold: true });
    if (held) heldSkips.push({ ...entry, attempts: held.attempts });
  }
  if (heldSkips.length) {
    await saveState(STATE_PATH, state);
    console.log(`QUEUE_HELD ${heldSkips.length}`);
    for (const entry of heldSkips.slice(0, 10)) {
      console.log(`  QUEUE_HOLD ${entry.reason} | ${entry.sourceName || entry.sourceId || 'unknown'} | ${entry.title}`);
    }
    if (heldSkips.length > 10) {
      console.log(`  QUEUE_HOLD ... +${heldSkips.length - 10} more`);
    }
  }
  if (queue.length === 0) {
    markSlot(state, slot.key, { status: 'empty', reason: 'diversity_unavailable' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=diversity_unavailable');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  let published = null;
  const slotPosts = [];
  let lastSendAt = 0;
  let totalCost = reviewSpend.cost;
  let totalTokens = reviewSpend.tokens;
  let fallbackSpent = false;

  async function deferOrClose(candidate, reason, detail = '') {
    const entry = deferCandidate(state, candidate, { reason, detail });
    const count = Number(entry?.attempts ?? 0);
    attempts.push({ title: candidate.title, result: 'deferred', reason, attempts: count, detail });
    if (entry) {
      console.log(`  DEFERRED ${reason} | try ${count}/${MAX_DEFER_ATTEMPTS}`);
      if (count >= MAX_DEFER_ATTEMPTS) console.log(`  DEFER_LIMIT ${reason} | no more retries`);
    } else {
      console.log(`  DEFER_FAILED ${reason} | no stable id`);
    }
    await saveState(STATE_PATH, state);
    return entry;
  }

  for (const [index, candidate] of queue.entries()) {
    if (slotPosts.length >= postsPerSlot) break;
    if (!budget.ok) {
      console.log(`DAILY_CAP_REACHED ${budget.used}/${budget.cap}`);
      break;
    }
    const label = `${candidate.sourceName} | ${candidate.title} | ${candidate.ageHours}h`;
    const deferredLabel = candidate.deferred ? ` | deferred ${candidate.deferred.attempts}/${MAX_DEFER_ATTEMPTS}` : '';
    if (candidate.policyReminder && policyState?.targets?.[candidate.sourceId]) {
      const target = policyState.targets[candidate.sourceId];
      if (target.last_reminder_date !== slot.date) {
        target.last_reminder_date = slot.date;
        await writeFile(POLICY_STATE_PATH, `${JSON.stringify(policyState, null, 2)}\n`);
        console.log(`POLICY_REMINDER_DAY ${slot.date}`);
      }
    }
    console.log(`ATTEMPT ${index + 1}/${queue.length}${deferredLabel} ${label}`);
    const applyPolicy = (value) => {
      const next = applyLeadPolicy(value, candidate);
      if (next !== value) {
        const reason = candidate.officialCourse ? 'official_course' : 'model_release';
        console.log(`  CATEGORY_FIX ${value.category || 'none'}->${next.category} ${reason}`);
      }
      return next;
    };

    const preOffer = detectOffer({
      title: candidate.title,
      content: `${candidate.summary ?? ''} ${candidate.messageText ?? ''}`,
    });
    const leftover = String(candidate.messageText ?? '').trim();
    const protectedLead = Boolean(
      candidate.offerHint || candidate.toolHint || candidate.officialCourse || preOffer.isOffer
    );

    if (candidate.needsReview) {
      const reason = reviewReasonOf(candidate);
      const kind = candidate.offerHint || preOffer.isOffer ? 'offer' : candidate.toolHint ? 'tool' : 'post';
      console.log(`  REVIEW_LEAD kind=${kind} reason=${reason}`);
      await deliverReview({
        candidate,
        article: null,
        assessment: { reason },
        reason,
        kind,
        text: candidate.messageText,
        note: reviewNoteOf(reason),
      });
      continue;
    }

    let article;
    try {
      const page = await fetchText(candidate.link, { redact });
      article = extractArticle(page.text, candidate.title, page.url || candidate.link);
      article.url = page.url || candidate.link;
    } catch (error) {
      const fetchError = redact(String(error?.message ?? error));
      console.log(`  FETCH_FAILED ${fetchError}`);
      if (candidate.resolvedLink) {
        console.log('  LINK_UNVERIFIED fetch_failed');
        await deliverReview({
          candidate,
          article: null,
          assessment: { reason: 'link_missing' },
          reason: 'link_missing',
          kind: 'offer',
          text: candidate.messageText,
          note: `صفحه رسمی فروشنده باز نشد: ${fetchError}`,
        });
        continue;
      }
      const fallbackText = [candidate.messageText, candidate.summary]
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (fallbackText.length >= MIN_CONTENT) {
        article = {
          title: candidate.title || '',
          description: candidate.summary || '',
          published: candidate.published || '',
          modified: '',
          imageUrl: candidate.images?.[0] || '',
          imageAlt: '',
          content: fallbackText,
          url: candidate.link,
        };
        console.log(`  FETCH_TEXT_FALLBACK ${fallbackText.length} chars`);
      } else if (protectedLead) {
        const kind = candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        await deliverReview({
          candidate,
          article: null,
          assessment: { reason: 'fetch_failed' },
          reason: 'fetch_failed',
          kind,
          text: candidate.messageText,
          note: `خطای دریافت صفحه اصلی: ${fetchError}`,
        });
        continue;
      } else {
        await deferOrClose(candidate, 'fetch_failed', fetchError);
        continue;
      }
    }

    if (candidate.policy && candidate.messageText) {
      const note = String(candidate.messageText).trim();
      if (note && !article.content.includes(note)) {
        article.content = `${note}\n\n${article.content}`;
        console.log(`  POLICY_CONTEXT +${note.length} chars`);
      }
    }

    const publishedAt = candidate.policy
      ? candidate.published || article.published || NOW
      : earliestDate(article.published, article.modified, candidate.published) ||
        article.published ||
        candidate.published;
    article.published = publishedAt;
    const effectiveLine = candidate.effectiveDate ? effectiveDateLine(candidate.effectiveDate) : '';
    const newsDate = [newsDateLine(publishedAt), effectiveLine].filter(Boolean).join('\n');
    let toolUsage = null;
    const finalizePost = (value) => {
      const policy = applyPolicy(value);
      const fixed = applyMechanicalFixes(policy, {
        sourceName: candidate.sourceName,
        sourceUrl: article.url,
        usageUrl: toolUsage?.url ?? '',
        usageName: toolUsage?.name ?? '',
        imageUrl,
        newsDate,
        sourceType: candidate.sourceType,
        openEnded: Boolean(offerContext?.openEnded),
        noExpiryNote: offerContext?.note ?? '',
        policyIran:
          Boolean(candidate.policyCountries?.verified) && candidate.policyCountries?.hasIran === false,
      });
      if (fixed.title !== policy.title) console.log('  TITLE_TRIM');
      if (fixed.body !== policy.body) console.log('  BODY_TRIM');
      if (String(fixed.quote ?? '') !== String(policy.quote ?? '')) console.log('  QUOTE_TRIM');
      if (fixed.post_type !== policy.post_type) console.log('  TYPE_STANDARDIZED_FOR_IMAGE');
      if (fixed.image_url !== policy.image_url) console.log('  IMAGE_SET_BY_POLICY');
      return fixed;
    };

    const gate = candidate.policy
      ? { ok: true, reason: 'ok', ageHours: 0, maxAgeHours: config.freshness_hours.pre_gate }
      : freshness(publishedAt, NOW, { maxAgeHours: config.freshness_hours.pre_gate });
    if (!gate.ok) {
      if (gate.reason === 'stale') {
        attempts.push({ title: candidate.title, result: `gate_${gate.reason}` });
        console.log(`  GATE_${gate.reason.toUpperCase()} ${gate.ageHours}h/${gate.maxAgeHours}h`);
      } else if (protectedLead) {
        const kind = candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        await deliverReview({
          candidate,
          article,
          assessment: { reason: `gate_${gate.reason}` },
          reason: `gate_${gate.reason}`,
          kind,
          text: leftover,
        });
      } else {
        await deferOrClose(candidate, `gate_${gate.reason}`, `${gate.ageHours}h/${gate.maxAgeHours}h`);
      }
      continue;
    }
    if (article.content.length < MIN_CONTENT && leftover.length >= 80) {
      article.content = `${article.content}\n\n${leftover}`;
      console.log(`  CONTENT_SUPPLEMENT +${leftover.length} chars telegram`);
    }
    if (article.content.length < MIN_CONTENT) {
      if (candidate.offerHint || candidate.toolHint || preOffer.isOffer) {
        const kind = candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        const reason = candidate.resolvedLink ? 'link_missing' : 'thin_content';
        await deliverReview({
          candidate,
          article,
          assessment: { reason },
          reason,
          kind,
          text: leftover,
          note: candidate.resolvedLink ? 'صفحه رسمی محتوای کافی برای تأیید آفر نداشت.' : '',
        });
      } else {
        await deferOrClose(candidate, 'thin_content', `${article.content.length} chars`);
      }
      console.log(`  THIN_CONTENT ${article.content.length} chars`);
      continue;
    }

    const offerContent = leftover && !article.content.includes(leftover)
      ? `${leftover}\n\n${article.content}`
      : article.content;
    const offer = detectOffer({ title: article.title || candidate.title, content: offerContent });
    if (candidate.resolvedLink && !offer.isOffer) {
      console.log('  LINK_UNVERIFIED official_page_has_no_offer');
      await deliverReview({
        candidate,
        article,
        assessment: { reason: 'link_missing' },
        reason: 'link_missing',
        kind: 'offer',
        text: leftover,
        note: 'صفحه رسمی فروشنده این آفر را تأیید نکرد؛ لینک نیازمند تأیید است.',
      });
      continue;
    }
    let offerAssessment = null;
    let offerContext = null;
    let officialResolved = false;
    if (offer.isOffer) {
      officialResolved = Boolean(
        candidate.resolvedLink &&
          candidate.vendorUrl &&
          siteKey(article.url) === siteKey(candidate.vendorUrl)
      );
      const vendorKey = openEndedKey({ vendor: candidate.vendor, host: siteKey(article.url) });
      const openEndedRecord = openEndedUsage(state, {
        key: vendorKey,
        now: NOW,
        days: Number(config.offers.no_expiry_per_vendor_days ?? 14),
      });
      offerAssessment = assessOffer({
        offer: { isOffer: true, title: article.title || candidate.title, content: offerContent },
        sourceType: candidate.sourceType,
        sourceUrl: article.url,
        sourceKey: candidate.sourceId,
        publishedAt,
        now: NOW,
        config,
        quota,
        usage: offerUsage(state, NOW),
        reviewUsage,
        officialResolved,
        vendorKey,
        openEnded: openEndedRecord,
      });
      if (offerAssessment.status === 'review' || offerAssessment.status === 'defer') {
        await deliverReview({
          candidate,
          article,
          assessment: offerAssessment,
          reason: offerAssessment.reason,
          kind: 'offer',
          note:
            offerAssessment.status === 'defer'
              ? `ظرفیت صف بازبینی پر بود (${offerAssessment.cap || offerAssessment.reason})؛ مورد در صف نگه داشته شد.`
              : '',
        });
        console.log(
          `  OFFER_${offerAssessment.status.toUpperCase()} ${offerAssessment.reason}${offerAssessment.cap ? ` cap=${offerAssessment.cap}` : ''}`
        );
        continue;
      }
      if (offerAssessment.status !== 'publish') {
        markSeen(state, candidate.keys, {
          decision: 'offer_skip',
          reason: offerAssessment.reason,
          category: '',
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
        attempts.push({ title: candidate.title, result: 'offer_skip', reason: offerAssessment.reason });
        console.log(`  OFFER_${offerAssessment.status.toUpperCase()} ${offerAssessment.reason}`);
        continue;
      }
      offerContext = {
        detected: true,
        openEnded: offerAssessment.openEnded === true,
        key: vendorKey,
        vendor: candidate.vendor || siteKey(article.url),
        note: config.offers.no_expiry_note,
        date: offerAssessment.expiry?.date || '',
        remainingHours: offerAssessment.expiry?.remainingHours ?? null,
        expiry: offerAssessment.expiry,
        minRemainingHours: config.offers.min_remaining_hours,
      };
      console.log(
        offerContext.openEnded
          ? `  OFFER eligible | open-ended (no expiry) | vendor ${offerContext.vendor}`
          : `  OFFER eligible | expires ${offerContext.date} | ${offerContext.remainingHours}h left`
      );
    }

    toolUsage = pickToolUsageLink({
      article,
      sourceUrl: article.url,
      sourceType: candidate.sourceType,
      offer: Boolean(offerContext),
      officialCourse: Boolean(candidate.officialCourse),
    });
    console.log(
      toolUsage
        ? `  TOOL_LINK candidate ${toolUsage.url} | score ${toolUsage.score}`
        : '  TOOL_LINK candidate none | source fallback'
    );

    const rawImage = article.imageUrl || candidate.images[0] || '';
    const verdict = imageVerdict(rawImage, article.imageAlt);
    const imageUrl = verdict.ok ? rawImage : '';
    const host = (() => {
      try {
        return new URL(article.url).hostname;
      } catch {
        return '';
      }
    })();

    const story = {
      item: { title: candidate.title, published: candidate.published },
      article,
      url: article.url,
      now: NOW,
      imageUrl,
      maxAgeHours: offerContext ? config.offers.max_age_hours : config.freshness_hours.pre_gate,
      offer: offerContext,
      officialCourse: Boolean(candidate.officialCourse),
      benchmark: candidate.sourceType === 'benchmark',
      policy: Boolean(candidate.policy),
      effectiveDate: candidate.effectiveDate || '',
      policyIran:
        Boolean(candidate.policyCountries?.verified) && candidate.policyCountries?.hasIran === false,
      toolUrl: toolUsage?.url ?? '',
    };
    const user = buildUserMessage(story);
    console.log(`  MODEL ${PRIMARY.model} | image ${imageUrl ? 'allowed' : verdict.reason}`);

    let writer = PRIMARY;
    let activeUser = user;
    let call = await callWithRetry(writerOptions(writer, activeUser), 4, console.log);
    let retry = null;
    let parsed = extractJson(call.content);
    if (!parsed) {
      console.log('  invalid JSON, one corrective retry');
      const corrective = `${activeUser}\n\nخروجی قبلی JSON معتبر نبود. فقط یک آبجکت JSON معتبر بده.`;
      retry = await callWithRetry(writerOptions(writer, corrective), 2, console.log);
      parsed = extractJson(retry.content);
    }
    let fallback = null;

    if (isFalseStaleSkip(parsed, gate, STRICT_FRESH_HOURS)) {
      console.log(`  MODEL_FALSE_STALE ${gate.ageHours}h/${STRICT_FRESH_HOURS}h | one corrective retry`);
      const corrective = `${activeUser}\n\nخروجی قبلی خبر را «stale» رد کرد، ولی سن خبر ${gate.ageHours} ساعت و کمتر از سقف ${STRICT_FRESH_HOURS} ساعت است. این خبر تازه است؛ فقط اگر دلیل دیگری برای رد داری همان را بگو، وگرنه publish کن. فقط یک آبجکت JSON معتبر بده.`;
      retry = await callWithRetry(writerOptions(writer, corrective), 2, console.log);
      const corrected = extractJson(retry.content);
      if (corrected) parsed = corrected;
    }

    if (!parsed && FALLBACK_ENABLED && !fallbackSpent) {
      fallbackSpent = true;
      const primaryUsage = usageOf(call);
      const retryUsage = usageOf(retry);
      totalCost += primaryUsage.cost + retryUsage.cost;
      totalTokens += primaryUsage.tokens + retryUsage.tokens;
      console.log(`  FALLBACK ${FALLBACK.model} reason=primary_invalid_json chars=${FALLBACK.maxContentChars}`);
      writer = FALLBACK;
      activeUser = buildUserMessage({ ...story, maxContentChars: FALLBACK.maxContentChars });
      call = await callWithRetry(writerOptions(writer, activeUser), 2, console.log, [45000]);
      retry = null;
      parsed = extractJson(call.content);
      if (!parsed) {
        const corrective = `${activeUser}\n\nخروجی قبلی JSON معتبر نبود. فقط یک آبجکت JSON معتبر بده.`;
        retry = await callWithRetry(writerOptions(writer, corrective), 2, console.log, [45000]);
        parsed = extractJson(retry.content);
      }
      fallback = { used: true, model: FALLBACK.model, parsed: Boolean(parsed) };
      if (!parsed) console.log('  FALLBACK_INVALID_JSON');
    }

    const raw = retry || call;
    const usage = raw.usage ?? {};
    let cost = usageOf(call).cost + usageOf(retry).cost;
    let tokens = usageOf(call).tokens + usageOf(retry).tokens;
    totalCost += cost;
    totalTokens += tokens;

    if (!parsed) {
      if (protectedLead || offerContext) {
        const kind = offerContext || candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        await deliverReview({
          candidate,
          article,
          assessment: { ...(offerAssessment ?? {}), reason: 'model_failed' },
          reason: 'model_failed',
          kind,
          note: `مدل خروجی JSON معتبر نداد (${writer.role}).`,
        });
      } else {
        await deferOrClose(candidate, 'invalid_json', `writer=${writer.role} cost=${cost.toFixed(6)}`);
      }
      console.log(`  INVALID_JSON writer=${writer.role} cost $${cost.toFixed(6)}`);
      continue;
    }

    console.log(`  WRITER ${writer.role} model=${writer.model}`);
    parsed = finalizePost(parsed);

    const qaContext = {
      url: article.url,
      host,
      sourceType: candidate.sourceType,
      category: parsed.category,
      imageUrl,
      title: article.title,
      description: article.description,
      content: article.content,
      links: (article.links ?? []).map((link) => link.url),
      usageUrl: toolUsage?.url ?? '',
      publishedAt,
      now: NOW,
      newsDate,
      effectiveDate: candidate.effectiveDate || '',
      policy: Boolean(candidate.policy),
      policyIran:
        Boolean(candidate.policyCountries?.verified) && candidate.policyCountries?.hasIran === false,
      offer: offerContext,
      officialResolved,
      previousWhy,
    };
    let qa = qaPost(parsed, qaContext);
    let repair = null;
    let titleRepair = null;

    const offerQaFailed = Boolean(offerContext) && qa.problems.some((problem) => problem.startsWith('offer_'));
    const relevanceFailed = qa.problems.includes('ai_relevance');
    const styleWarning =
      qa.warnings.includes('formal_verbs') ||
      qa.warnings.includes('why_repeat') ||
      qa.warnings.includes('why');
    if (parsed.decision === 'publish' && (!qa.pass || styleWarning) && !offerQaFailed && !relevanceFailed && !offerContext) {
      console.log(`  ${qa.pass ? 'STYLE_WARNING' : 'QA_FAILED'} ${qa.problems.join(',') || qa.warnings.join(',')} | one repair retry`);
      repair = await callWithRetry(
        writerOptions(writer, buildQaRepairMessage({ user: activeUser, parsed, qa, imageUrl, previousWhy, newsDate, usageUrl: toolUsage?.url ?? '', usageName: toolUsage?.name ?? '' })),
        2,
        console.log
      );
      const repairUsage = repair.usage ?? {};
      const repairCost = Number(repairUsage.cost) || 0;
      const repairTokens = Number(repairUsage.total_tokens) || 0;
      cost += repairCost;
      tokens += repairTokens;
      totalCost += repairCost;
      totalTokens += repairTokens;
      const repaired = extractJson(repair.content);
      if (repaired) {
        const repairedPost = finalizePost(repaired);
        const candidateQa = qaPost(repairedPost, { ...qaContext, category: repairedPost.category });
        const better =
          (candidateQa.pass && !qa.pass) ||
          (candidateQa.pass === qa.pass && candidateQa.warnings.length < qa.warnings.length) ||
          (candidateQa.pass === qa.pass &&
            candidateQa.warnings.length === qa.warnings.length &&
            candidateQa.score >= qa.score);
        if (better) {
          parsed = repairedPost;
          qa = candidateQa;
        }
        console.log(`  REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | score ${qa.score}/${qa.possible} | problems ${qa.problems.join(',') || 'none'} | warnings ${qa.warnings.join(',') || 'none'}${better ? '' : ' | kept original'}`);
      } else {
        console.log('  REPAIR_INVALID_JSON');
      }
    }

    const titleProblems = qa.problems.filter((problem) => TITLE_QA_PROBLEMS.has(problem));
    const contentRejected = qa.problems.includes('ai_relevance') || qa.problems.includes('category_fresh');
    if (parsed.decision === 'publish' && !qa.pass && titleProblems.length > 0 && !contentRejected && !offerQaFailed) {
      console.log(`  TITLE_REPAIR ${titleProblems.join(',')} | focused retry`);
      titleRepair = await callWithRetry(
        writerOptions(writer, buildTitleRepairMessage({ user: activeUser, parsed, qa })),
        2,
        console.log
      );
      const titleRepairUsage = titleRepair.usage ?? {};
      const titleRepairCost = Number(titleRepairUsage.cost) || 0;
      const titleRepairTokens = Number(titleRepairUsage.total_tokens) || 0;
      cost += titleRepairCost;
      tokens += titleRepairTokens;
      totalCost += titleRepairCost;
      totalTokens += titleRepairTokens;
      const titleJson = extractJson(titleRepair.content);
      const nextTitle = String(titleJson?.title ?? '').trim();
      if (nextTitle) {
        const mergedPost = finalizePost({ ...parsed, title: nextTitle });
        const mergedQa = qaPost(mergedPost, { ...qaContext, category: mergedPost.category });
        const remaining = mergedQa.problems.filter((problem) => TITLE_QA_PROBLEMS.has(problem)).length;
        const better = mergedQa.pass || remaining < titleProblems.length;
        if (better) {
          parsed = mergedPost;
          qa = mergedQa;
        }
        console.log(
          `  TITLE_REPAIR_QA ${qa.pass ? 'PASS' : 'FAIL'} | title_problems ${remaining} | ${better ? 'applied' : 'kept original'}`
        );
      } else {
        console.log('  TITLE_REPAIR_INVALID_JSON');
      }
    }

    if (parsed.decision === 'skip') {
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_skip', reason: parsed.reason, cost, tokens });
        console.log(`  POLICY_SKIP ${parsed.reason_code || '-'} | ${String(parsed.reason || '').slice(0, 120)}`);
        continue;
      }
      if (protectedLead || offerContext) {
        const kind = offerContext || candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        await deliverReview({
          candidate,
          article,
          assessment: { ...(offerAssessment ?? {}), reason: 'model_skip' },
          reason: 'model_skip',
          kind,
          note: `مدل این مورد را رد کرد: ${String(parsed.reason || parsed.reason_code || '').slice(0, 300)}`,
        });
      } else {
        attempts.push({ title: candidate.title, result: 'model_skip', reason: parsed.reason, cost, tokens });
        markSeen(state, candidate.keys, {
          decision: 'skip',
          reason: parsed.reason_code || '',
          category: '',
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
      }
      console.log(`  MODEL_SKIP ${parsed.reason_code || '-'} | ${String(parsed.reason || '').slice(0, 120)}`);
      continue;
    }

    if (!qa.pass) {
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_qa_failed', problems: qa.problems, cost, tokens });
        console.log(`  POLICY_QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
        if (candidate.policyReminder && clearReminderDay(policyState, candidate.sourceId, slot.date)) {
          await writeFile(POLICY_STATE_PATH, `${JSON.stringify(policyState, null, 2)}\n`);
          console.log(`POLICY_REMINDER_RETRY ${slot.date} | day marker cleared for the next slot`);
        }
        continue;
      }
      if (offerContext && qa.problems.some((problem) => problem.startsWith('offer_'))) {
        await deliverReview({
          candidate,
          article,
          assessment: { ...offerAssessment, origin: 'qa_failed' },
          reason: 'offer_qa_failed',
          kind: 'offer',
        });
        console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
        continue;
      }
      if (candidate.toolHint || candidate.officialCourse) {
        await deliverReview({
          candidate,
          article,
          assessment: { reason: 'tool_incomplete' },
          reason: 'tool_incomplete',
          kind: 'tool',
          note: `بررسی کیفیت پاس نشد: ${qa.problems.join(',')}`,
        });
        console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
        continue;
      }
      const contentReject = qa.problems.includes('ai_relevance') || qa.problems.includes('category_fresh');
      const titleProblemsLeft = qa.problems.filter((problem) => TITLE_QA_PROBLEMS.has(problem));
      if (contentReject) {
        attempts.push({ title: candidate.title, result: 'qa_failed', problems: qa.problems, cost, tokens });
        markSeen(state, candidate.keys, {
          decision: 'qa_failed',
          reason: qa.problems.join(','),
          category: parsed.category || '',
          slot: slot.key,
          title: candidate.title,
          url: candidate.canonical,
        });
      } else if (titleProblemsLeft.length > 0) {
        await deliverReview({
          candidate,
          article,
          assessment: { ...(offerAssessment ?? {}), reason: 'qa_failed' },
          reason: 'qa_failed',
          kind: offerContext ? 'offer' : 'post',
          note: `تیتر پس از بازنویسی هم از QA گذشت نکرد (${titleProblemsLeft.join(', ')}).`,
          post: parsed,
        });
        console.log(`  QA_TITLE_REVIEW ${qa.problems.join(',')} | draft preserved in review`);
      } else {
        await deferOrClose(candidate, 'qa_failed', qa.problems.join(','));
      }
      console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
      continue;
    }

    const category = parsed.category;
    if (category === 'tools') {
      console.log(`  TOOL_LINK ${toolUsage ? `applied ${toolUsage.url}` : 'none | source line kept'}`);
    }
    if (!MAIN_CATEGORIES.includes(category)) {
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_bad_category', category: String(category ?? ''), cost, tokens });
        console.log(`  POLICY_CATEGORY ${category}`);
        continue;
      }
      if (candidate.toolHint || candidate.officialCourse || offerContext) {
        await deliverReview({
          candidate,
          article,
          assessment: { reason: 'bad_category' },
          reason: 'bad_category',
          kind: offerContext ? 'offer' : 'tool',
          note: `دسته نامعتبر از مدل: ${String(category ?? '')}`,
        });
      } else {
        await deferOrClose(candidate, 'bad_category', String(category ?? ''));
      }
      console.log(`  BAD_CATEGORY ${category}`);
      continue;
    }
    if (quota[category].remaining <= 0) {
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_quota_full', category, cost, tokens });
        console.log(`  POLICY_QUOTA_FULL ${category}`);
        continue;
      }
      if (candidate.toolHint || candidate.officialCourse || offerContext) {
        await deliverReview({
          candidate,
          article,
          assessment: { reason: 'quota_full' },
          reason: 'quota_full',
          kind: offerContext ? 'offer' : 'tool',
          note: `سهمیه دسته ${category} پر است.`,
        });
      } else {
        await deferOrClose(candidate, 'quota_full', category);
      }
      console.log(`  QUOTA_FULL ${category}`);
      continue;
    }

    const offerPriority = Boolean(offerContext || candidate.offerHint);
    const categoryCap = categoryCapOf(category);
    const todayCategoryCount = categoryCountForDate(state, slot.date)[category] ?? 0;
    if (todayCategoryCount >= categoryCap) {
      console.log(`  DIVERSITY_CATEGORY_DAILY ${category} ${todayCategoryCount}/${categoryCap}`);
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_category_daily_cap', category, cost, tokens });
        continue;
      }
      await deferOrClose(candidate, 'category_daily_cap', category);
      continue;
    }
    const previous = lastPublishedOnDate(state, slot.date);
    if (
      config.diversity?.no_consecutive_category !== false &&
      !offerPriority &&
      candidate.modelRelease !== true &&
      previous?.category === category
    ) {
      console.log(`  DIVERSITY_CATEGORY_CONSECUTIVE ${category}`);
      if (candidate.policy) {
        attempts.push({ title: candidate.title, result: 'policy_category_consecutive', category, cost, tokens });
        continue;
      }
      await deferOrClose(candidate, 'category_consecutive', category);
      continue;
    }

    const dir = outboxDir(slot.key, slotPosts.length + 1);
    await mkdir(dir, { recursive: true });
    let downloaded = null;
    let downloadError = '';
    if (parsed.image_url) {
      try {
        downloaded = await downloadImage(parsed.image_url, dir);
      } catch (error) {
        downloadError = redact(error?.message);
      }
    }

    const post = {
      title: String(parsed.title).trim(),
      news_date: newsDate,
      body: String(parsed.body).trim(),
      quote: String(parsed.quote ?? '').trim(),
    };
    const postFile = resolve(dir, 'post.txt');
    const caption = captionLength(post);
    const report = {
      slot: slot.key,
      week,
      mode: RUN_MODE,
      source: { id: candidate.sourceId, name: candidate.sourceName, url: article.url },
      item: { title: article.title, published_at: publishedAt, age_hours: gate.ageHours },
      category,
      tool_link: toolUsage ? { url: toolUsage.url, name: toolUsage.name, score: toolUsage.score } : null,
      diversity: {
        target: planned.target,
        hint: candidate.categoryHint ?? '',
        source_usage: planned.sourceUsage,
      },
      offer: offerContext ? {
        detected: true,
        open_ended: offerContext.openEnded === true,
        vendor: offerContext.vendor || '',
        expiry: offerContext.expiry,
        remaining_hours: offerContext.remainingHours,
        usage: offerUsage(state, NOW),
      } : null,
      image: {
        candidate: rawImage,
        verdict,
        used_url: downloaded ? parsed.image_url : '',
        file: downloaded?.file ?? '',
        error: downloadError,
      },
      model: {
        name: writer.model,
        role: writer.role,
        fallback,
        status: raw.status,
        ms: raw.ms,
        attempts: call.attempts + (retry?.attempts ?? 0) + (repair?.attempts ?? 0),
        finish: raw.finish,
        json_retry: Boolean(retry),
        qa_repair: Boolean(repair),
        title_repair: Boolean(titleRepair),
        usage,
        cost,
        tokens,
      },
      qa,
      post: {
        title: post.title,
        news_date: post.news_date,
        body: post.body,
        quote: post.quote,
        caption_chars: caption,
        quote_chars: post.quote.length,
        dedupe_key: parsed.dedupe_key,
      },
      attempts,
    };

    await writeFile(resolve(dir, 'post.json'), JSON.stringify({
      slot: slot.key,
      mode: RUN_MODE,
      category,
      title: post.title,
      news_date: post.news_date,
      body: post.body,
      quote: post.quote,
      image_url: downloaded ? parsed.image_url : '',
      image_file: downloaded?.file ?? '',
      source_url: article.url,
      source_name: candidate.sourceName,
      tool_link: parsed.category === 'tools' && toolUsage ? toolUsage.url : '',
      dedupe_key: parsed.dedupe_key,
      post_type: parsed.post_type,
      importance: parsed.importance,
      verification: parsed.verification,
      offer: offerContext
        ? {
            open_ended: offerContext.openEnded === true,
            expiry: offerContext.date || '',
            remaining_hours: offerContext.remainingHours,
          }
        : null,
      qa: { pass: qa.pass, score: qa.score, possible: qa.possible, warnings: qa.warnings },
      createdAt: NOW,
    }, null, 2));
    await writeFile(postFile, `${postText(post)}\n`);
    await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(
      resolve(dir, 'response.txt'),
      [
        call.content,
        retry ? `--- JSON RETRY ---\n\n${retry.content}` : '',
        repair ? `--- QA REPAIR ---\n\n${repair.content}` : '',
        titleRepair ? `--- TITLE REPAIR ---\n\n${titleRepair.content}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
    let window = SEND
      ? sendWindow({ config, state, date: slot.date, now: new Date().toISOString(), reviewSend: REVIEW_SEND })
      : null;

    await writeFile(
      resolve(dir, 'preview.html'),
      renderPreview({
        post,
        qa,
        imageUsed: Boolean(downloaded),
        imagePath: downloaded ? `image.${downloaded.ext}` : '',
        imageVerdict: downloaded ? '' : downloadError || verdict.reason,
        sourceUrl: article.url,
        banner: quiet
          ? 'کپی بازبینی — چیزی به کانال اصلی ارسال نشد'
          : window && !window.ok
            ? 'ارسال به کانال اصلی با گارد زمان اجرا متوقف شد — کپی واجد شرایط به بازبینی رفت'
            : SEND
              ? 'خروجی ارسال واقعی — وضعیت در گزارش ثبت شده است'
              : 'اجرای خشک محلی — هیچ چیزی به تلگرام ارسال نشده است',
      })
    );

    const routeReviewCopy = async ({ reason, note }) => {
      const kind = offerContext ? 'offer' : candidate.toolHint ? 'tool' : 'post';
      await deliverReview({
        candidate,
        article,
        assessment: offerAssessment ?? { reason },
        reason,
        kind,
        mainEligible: true,
        post,
        note,
      });
      slotPosts.push({
        title: post.title,
        category,
        status: 'review',
        messageId: null,
        dir,
        model: writer.model,
        cost,
        tokens,
        qa: `${qa.score}/${qa.possible}`,
        image: Boolean(downloaded),
        offer: Boolean(offerContext),
        at: new Date().toISOString(),
      });
      markSlot(state, slot.key, {
        status: 'review',
        category,
        title: post.title,
        postDir: dir,
        mode: RUN_MODE,
        reason,
        model: writer.model,
        fallback,
        cost: totalCost,
        tokens: totalTokens,
        qa: `${qa.score}/${qa.possible}`,
        posts: slotPosts,
      });
      await saveState(STATE_PATH, state);
      published = {
        post,
        category,
        dir,
        status: 'review',
        messageId: null,
        cost,
        tokens,
        qa,
        image: Boolean(downloaded),
        offer: Boolean(offerContext),
      };
    };

    if (quiet) {
      await routeReviewCopy({
        reason: 'quiet_hours',
        note: 'این پست در ساعات آرام آماده شد و به جای انتشار در کانال اصلی، با برچسب واجد شرایط به بازبینی کپی شده است.',
      });
      console.log('  QUIET_HOURS review_copy=yes main_eligible=yes');
      break;
    }

    let status = 'ready';
    let messageId = null;
    if (SEND) {
      if (!window.ok) {
        await routeReviewCopy({
          reason: window.reason,
          note:
            window?.reason === 'quiet_hours'
              ? 'پست در مرز ساعات آرام آماده شد؛ ارسال به کانال اصلی متوقف و نسخه واجد شرایط به بازبینی رفت.'
              : 'سقف پست روزانه پر شده بود؛ پست آماده به کانال اصلی نرفت و برای بازبینی نگه داشته شد.',
        });
        console.log(`  SEND_GUARD ${window?.reason ?? 'blocked'} review_copy=yes main_eligible=yes`);
        break;
      }
      if (lastSendAt && minGapMs) {
        const waitMs = lastSendAt + minGapMs - Date.now();
        if (waitMs > 0) {
          console.log(`  SLOT_GAP_WAIT ${Math.ceil(waitMs / 1000)}s`);
          await sleep(waitMs);
        }
        window = sendWindow({
          config,
          state,
          date: slot.date,
          now: new Date().toISOString(),
          reviewSend: REVIEW_SEND,
        });
        if (!window.ok) {
          await routeReviewCopy({
            reason: window.reason,
            note: 'گارد زمان اجرا پس از فاصله بین دو پست اسلات، ارسال را متوقف کرد و نسخه واجد شرایط به بازبینی رفت.',
          });
          console.log(`  SEND_GUARD ${window.reason} review_copy=yes main_eligible=yes`);
          break;
        }
      }
      try {
        let sent;
        for (let attempt = 1; ; attempt += 1) {
          try {
            sent = await sendTelegram(post, {
              token: env.TELEGRAM_BOT_TOKEN,
              chatId: CHAT_ID,
              imagePath: downloaded?.file ?? '',
            });
            break;
          } catch (error) {
            if (attempt >= 2 || error?.retryable !== true) throw error;
            const waitMs = Math.max(3000, Math.min(Number(error.retryAfter) || 0, 60) * 1000);
            console.log(
              `SEND_RETRY attempt=${attempt} reason=${redact(String(error?.message ?? error))} wait=${Math.ceil(waitMs / 1000)}s`
            );
            await sleep(waitMs);
          }
        }
        status = 'sent';
        messageId = sent.messageId;
      } catch (error) {
        status = slotPosts.some((entry) => entry.status === 'sent') ? 'sent' : 'ready';
        const sendError = String(error?.message ?? error);
        markSlot(state, slot.key, {
          status,
          category,
          title: post.title,
          postDir: dir,
          error: sendError,
          model: writer.model,
          cost: totalCost,
          tokens: totalTokens,
          qa: `${qa.score}/${qa.possible}`,
          posts: slotPosts,
        });
        try {
          await deliverReview({
            candidate,
            article,
            assessment: { reason: 'send_failed', expiry: offerAssessment?.expiry },
            reason: 'send_failed',
            kind: offerContext ? 'offer' : candidate.toolHint ? 'tool' : 'post',
            mainEligible: true,
            post,
            note: `ارسال به کانال اصلی ناموفق بود (${sendError.slice(0, 160)})؛ پست آماده برای بازبینی نگه داشته شد.`,
          });
        } catch (reviewError) {
          console.log(`REVIEW_PRESERVE_FAILED ${redact(reviewError?.message ?? reviewError)}`);
        }
        await deferOrClose(candidate, 'send_failed', sendError);
        console.log(`SEND_FAILED ${sendError}`);
        console.log(`OUTBOX ${dir}`);
        if (slotPosts.length) {
          console.log(`PARTIAL_SENT ${slotPosts.length}/${postsPerSlot}`);
        } else {
          console.log('NOTHING_WAS_SENT');
        }
        process.exit(1);
      }
    }

    slotPosts.push({
      title: post.title,
      category,
      status,
      messageId,
      dir,
      model: writer.model,
      fallback: Boolean(fallback),
      cost,
      tokens,
      qa: `${qa.score}/${qa.possible}`,
      image: Boolean(downloaded),
      offer: Boolean(offerContext),
      at: new Date().toISOString(),
    });
    markSlot(state, slot.key, {
      status,
      category,
      title: post.title,
      postDir: dir,
      messageId,
      mode: RUN_MODE,
      model: writer.model,
      fallback,
      cost: totalCost,
      tokens: totalTokens,
      qa: `${qa.score}/${qa.possible}`,
      posts: slotPosts,
    });
    markSeen(state, candidate.keys, {
      decision: 'publish',
      category,
      slot: slot.key,
      title: candidate.title,
      url: candidate.canonical,
    });
    recordPublished(state, {
      slot: slot.key,
      category,
      title: post.title,
      dedupeKey: parsed.dedupe_key,
      postKey: `${slot.date}/${slot.slot.replace(':', '-')}/${slotPosts.length}`,
      kind: offerContext ? 'offer' : 'news',
      why: importanceOf(parsed.body),
      sourceId: candidate.sourceId || candidate.leadSource || '',
      sourceName: candidate.sourceName || candidate.leadSource || '',
      sourceType: candidate.sourceType || 'telegram_channel',
      sourceTitle: article.title || candidate.title || '',
      sourceText: candidate.messageText || article.content || '',
      url: article.url,
    });
    if (offerContext?.openEnded && status === 'sent') {
      recordOpenEnded(state, {
        key: offerContext.key,
        vendor: offerContext.vendor,
        url: article.url,
        title: post.title,
        at: NOW,
      });
      console.log(
        `OPEN_OFFER recorded ${offerContext.key} | window ${config.offers.no_expiry_window_days}d | no announcement on end`
      );
    }
    pruneState(state, NOW, reviewPrune);
    await saveState(STATE_PATH, state);

    previousWhy = importanceOf(parsed.body);
    if (status === 'sent') lastSendAt = Date.now();
    published = { post, category, dir, status, messageId, cost, tokens, qa, image: Boolean(downloaded), offer: Boolean(offerContext) };
    console.log(
      `POST ${slotPosts.length}/${postsPerSlot} status=${status} category=${category} | QA ${qa.score}/${qa.possible} | $${cost.toFixed(6)} | ${dir}`
    );
    if (slotPosts.length >= postsPerSlot) break;

    quota = quotaSnapshot(config, state, week);
    budget = dailyBudget({ config, state, date: slot.date });
    if (!budget.ok) {
      console.log(`DAILY_CAP_REACHED ${budget.used}/${budget.cap}`);
      break;
    }
  }

  if (!published) {
    markSlot(state, slot.key, { status: 'empty', reason: 'all_candidates_rejected', cost: totalCost, tokens: totalTokens });
    pruneState(state, NOW, reviewPrune);
    await saveState(STATE_PATH, state);
    console.log(`RESULT EMPTY attempts=${attempts.length} reviews=${reviews} deferred=${Object.keys(state.deferred ?? {}).length} | cost $${totalCost.toFixed(6)} | tokens ${totalTokens}`);
    for (const attempt of attempts.slice(0, 12)) {
      console.log(`  EMPTY_ATTEMPT ${attempt.result}${attempt.reason ? ` reason=${attempt.reason}` : ''} | ${attempt.title}`);
    }
    if (attempts.length > 12) {
      console.log(`  EMPTY_ATTEMPT ... +${attempts.length - 12} more`);
    }
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const sentCount = slotPosts.filter((entry) => entry.status === 'sent').length;
  const reviewCount = slotPosts.filter((entry) => entry.status === 'review').length;
  const resultLabel = published.status === 'sent' ? 'SENT' : published.status === 'review' ? 'REVIEW' : 'READY';
  console.log(`RESULT ${resultLabel} category=${published.category} | offer=${published.offer ? 'yes' : 'no'} | image=${published.image ? 'yes' : 'no'} | QA ${published.qa.score}/${published.qa.possible} | cost $${totalCost.toFixed(6)} | post $${published.cost.toFixed(6)} | tokens ${totalTokens}`);
  console.log(`TITLE ${published.post.title}`);
  console.log(`OUTBOX ${published.dir}`);
  console.log(`SLOT_POSTS ${slotPosts.length}/${postsPerSlot} sent=${sentCount} review=${reviewCount}`);
  for (const entry of slotPosts) {
    console.log(`  POST ${entry.category} | ${entry.status} | $${Number(entry.cost).toFixed(6)} | ${entry.title}`);
  }
  console.log(
    sentCount > 0
      ? REVIEW_SEND
        ? 'SENT_TO_REVIEW'
        : 'SENT_TO_TELEGRAM'
      : reviewCount > 0
        ? 'REVIEW_COPY — NOTHING_SENT_TO_MAIN'
        : SEND
          ? 'NOTHING_WAS_SENT'
          : 'DRY_RUN — NOTHING_WAS_SENT'
  );
}

await main();
