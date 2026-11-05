import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash, earliestDate, freshness, windowFor } from './normalize.mjs';
import {
  loadEnv,
  makeRedactor,
  fetchText,
  extractArticle,
  imageVerdict,
  downloadImage,
  buildUserMessage,
  buildQaRepairMessage,
  callWithRetry,
  extractJson,
  qaPost,
  applyLeadPolicy,
  applyMechanicalFixes,
  renderPreview,
  MAIN_CATEGORIES,
} from './engine.mjs';
import { collectCandidates } from './collect.mjs';
import { categoryCountForDate, lastPublishedOnDate, planSlotQueue, slotTarget } from './diversity.mjs';
import { dailyBudget, sendWindow } from './guards.mjs';
import { buildEducationDigest, buildEducationMessages, educationDigestLeads, matchesPublishedStory } from './telegram-source.mjs';
import { assessOffer, detectOffer, offerUsage, offerReviewUsage, recordOfferReview, reviewCapacity, reviewText, enqueueReviewPending, listReviewPending, removeReviewPending } from './offers.mjs';
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
  educationReviewUsage,
  pruneState,
  deferCandidate,
  deferredId,
  listDeferred,
  clearDeferred,
  deliveredEntries,
  MAX_DEFER_ATTEMPTS,
  DEFER_TTL_HOURS,
} from './store.mjs';
import { sendTelegram, sendText, captionLength, postText } from './telegram.mjs';
import { newsDateLine } from './newstime.mjs';

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
  Number(MAX_CANDIDATES_ARG || config.diversity?.max_candidates || 6)
);
const registry = JSON.parse(await readFile(resolve(ROOT, SOURCES_FILE), 'utf8'));
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

function outboxDir(slot) {
  const [date, time] = String(slot).split('T');
  return resolve(OUT_ROOT, date, time.slice(0, 5).replace(':', '-'));
}

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

function storyText(candidate) {
  return [candidate.title, candidate.messageText, candidate.summary].filter(Boolean).join(' ');
}

function findStoryDuplicate(candidate, delivered) {
  return delivered.find((entry) => matchesPublishedStory(storyText(candidate), entry));
}

const importanceOf = (body) => {
  const before = String(body ?? '').split(/^[ \t]*منبع\s*[:：]/m)[0];
  return before.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).at(-1) ?? '';
};

async function main() {
  const slot = activeSlot();
  const state = await loadState(STATE_PATH);
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
  const previousWhy = [...(state.published ?? [])].reverse().find((entry) => entry.why)?.why ?? '';
  const week = weekKey(slot.date);
  const quota = quotaSnapshot(config, state, week);
  const budget = dailyBudget({ config, state, date: slot.date });
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
      slot: slot.key,
      at: NOW,
      publishedAt: article?.published || candidate?.published || '',
      keys: candidate?.keys ?? [],
      leadPostUrl: candidate?.leadPostUrl ?? '',
      messageText: candidate?.messageText ?? '',
      expiry: assessment?.expiry ?? null,
      text: '',
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
      source: { id: payload.source, name: payload.sourceName, url: payload.url },
      title: payload.title,
      published_at: payload.publishedAt,
      expiry: payload.expiry,
      note: 'این مورد به کانال اصلی منتشر نشده و فقط برای بازبینی ثبت شده است.',
      createdAt: NOW,
    }, null, 2));
    await writeFile(resolve(dir, 'review.txt'), `${payload.text}\n`);
    return dir;
  }

  async function sendReviewText(text) {
    if (!SEND) return { messageId: null, sendError: '' };
    if (!reviewEnabled) return { messageId: null, sendError: 'REVIEW_DISABLED' };
    if (!REVIEW_CHAT_ID) return { messageId: null, sendError: 'REVIEW_CREDENTIALS_MISSING' };
    try {
      const sent = await sendText(text, { token: env.TELEGRAM_BOT_TOKEN, chatId: REVIEW_CHAT_ID });
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
    const { messageId, sendError } = await sendReviewText(payload.text);
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
      const payload = { ...entry };
      const dir = await writeReviewFiles(payload);
      const { messageId, sendError } = await sendReviewText(payload.text);
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

  if (reviewEnabled) await flushPendingReviews();

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
      (source.use === 'api' && Boolean(source.api_url))
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
  });
  console.log(`COLLECT sources=${stats.sources} items=${stats.feedItems} index=${stats.indexItems} api=${stats.apiItems} stale=${stats.stale} nodate=${stats.noDate} dup=${stats.duplicate} dup_other=${stats.crossLane} kept=${stats.kept} errors=${stats.errors.length}`);
  for (const error of stats.errors) {
    const label =
      error.kind === 'telegram'
        ? 'TELEGRAM_ERROR'
        : error.kind === 'benchmark'
          ? 'INDEX_ERROR'
          : error.kind === 'api'
            ? 'API_ERROR'
            : 'FEED_ERROR';
    console.log(`  ${label} ${error.source}: ${error.error}`);
  }
  const tg = stats.telegram;
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
  const reviewNoteOf = (reason) =>
    reason === 'research_paper'
      ? 'این مقاله پژوهشی برای بازبینی جدا شده و به کانال اصلی نرفته است.'
      : 'لینک این سرنخ ارجاعی یا تبلیغی است و پیش از انتشار باید بررسی شود.';

  const reviewLeads = mainCandidates.filter((candidate) => candidate.needsReview);
  mainCandidates = mainCandidates.filter((candidate) => !candidate.needsReview);
  if (reviewLeads.length) {
    console.log(`REVIEW_LEADS ${reviewLeads.length} separate_from_main=yes`);
    for (const candidate of reviewLeads) {
      const reason = reviewReasonOf(candidate);
      const kind = candidate.offerHint ? 'offer' : candidate.toolHint ? 'tool' : 'post';
      await deliverReview({
        candidate,
        article: null,
        assessment: { reason },
        reason,
        kind,
        text: candidate.messageText,
        note: reviewNoteOf(reason),
      });
    }
  }

  if (educationLeads.length) {
    const educationCap = Number(config.education_review?.max_per_day ?? 5);
    const educationSourceCap = Number(config.education_review?.max_per_source_per_day ?? 1);
    const usage = educationReviewUsage(state, NOW);
    const rankedLeads = educationDigestLeads(educationLeads, {
      max: Math.max(educationCap * 4, 20),
    });
    const remaining = Math.max(0, educationCap - usage.total);
    const sourceCounts = new Map(Object.entries(usage.bySource ?? {}));
    const selectedLeads = [];
    for (const candidate of rankedLeads) {
      if (selectedLeads.length >= remaining) break;
      const source = candidate.sourceId || candidate.leadSource || '';
      if (source && (sourceCounts.get(source) ?? 0) >= educationSourceCap) continue;
      selectedLeads.push(candidate);
      if (source) sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
    console.log(
      `TELEGRAM_EDU_LEADS ${educationLeads.length} selected=${selectedLeads.length} cap=${educationCap} used=${usage.total} private_only=yes`
    );
    for (const candidate of selectedLeads) {
      console.log(`  EDU_LEAD ${candidate.leadSource} | ${candidate.leadKind} | ${candidate.title}`);
    }
    if (selectedLeads.length === 0) {
      console.log('  EDU_REVIEW_SKIPPED cap_or_no_ai');
    } else {
      const digest = buildEducationDigest({
        leads: selectedLeads,
        date: slot.date,
        slot: slot.slot,
      });
      const digestDir = resolve(REVIEW_ROOT, slot.date, `${slot.slot.replace(':', '-')}-education`);
      await mkdir(digestDir, { recursive: true });
      const digestPath = resolve(digestDir, 'education.txt');
      await writeFile(digestPath, `${digest}\n`);

      const sentIds = [];
      let digestError = '';
      let sentCount = 0;
      if (SEND && config.telegram_discovery?.education_review !== false && REVIEW_CHAT_ID) {
        let sentAnything = false;
        for (const candidate of selectedLeads) {
          const messages = buildEducationMessages(candidate, {
            maxTextChars: config.education_review?.max_text_chars,
          });
          let leadSent = 0;
          for (const message of messages) {
            if (sentAnything) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 1200));
            }
            try {
              const sent = await sendText(message, {
                token: env.TELEGRAM_BOT_TOKEN,
                chatId: REVIEW_CHAT_ID,
              });
              if (sent.messageId) sentIds.push(sent.messageId);
              sentCount += 1;
              sentAnything = true;
              leadSent += 1;
            } catch (error) {
              digestError = String(error?.message ?? error);
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
        `  EDU_REVIEW sent=${sentCount}${sentIds.length ? ` ids=${sentIds.join(',')}` : ''}${sentCount ? '' : ` mode=${RUN_MODE}`} file=${digestPath}`
      );
      if (digestError) console.log(`  EDU_REVIEW_SEND_FAILED ${redact(digestError)}`);
    }
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
  if (queue.length === 0) {
    markSlot(state, slot.key, { status: 'empty', reason: 'diversity_unavailable' });
    await saveState(STATE_PATH, state);
    console.log('RESULT EMPTY reason=diversity_unavailable');
    console.log('NOTHING_WAS_SENT');
    return;
  }

  let published = null;
  let totalCost = 0;
  let totalTokens = 0;
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
    const label = `${candidate.sourceName} | ${candidate.title} | ${candidate.ageHours}h`;
    const deferredLabel = candidate.deferred ? ` | deferred ${candidate.deferred.attempts}/${MAX_DEFER_ATTEMPTS}` : '';
    console.log(`ATTEMPT ${index + 1}/${queue.length}${deferredLabel} ${label}`);
    const applyPolicy = (value) => {
      const next = applyLeadPolicy(value, candidate);
      if (next !== value) {
        console.log(`  CATEGORY_FIX ${value.category || 'none'}->${next.category} official_course`);
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
      article = extractArticle(page.text, candidate.title);
      article.url = page.url || candidate.link;
    } catch (error) {
      console.log(`  FETCH_FAILED ${redact(error?.message)}`);
      if (protectedLead) {
        const kind = candidate.offerHint || preOffer.isOffer ? 'offer' : 'tool';
        await deliverReview({
          candidate,
          article: null,
          assessment: { reason: 'fetch_failed' },
          reason: 'fetch_failed',
          kind,
          text: candidate.messageText,
          note: `خطای دریافت صفحه اصلی: ${redact(String(error?.message ?? error))}`,
        });
      } else {
        await deferOrClose(candidate, 'fetch_failed', redact(error?.message));
      }
      continue;
    }

    const publishedAt =
      earliestDate(article.published, article.modified, candidate.published) ||
      article.published ||
      candidate.published;
    article.published = publishedAt;
    const finalizePost = (value) => {
      const policy = applyPolicy(value);
      const fixed = applyMechanicalFixes(policy, {
        newsDate: newsDateLine(publishedAt),
        sourceName: candidate.sourceName,
        sourceUrl: article.url,
      });
      if (fixed.title !== policy.title) console.log('  TITLE_TRIM');
      if (fixed.body !== policy.body) console.log('  BODY_TRIM');
      if (String(fixed.quote ?? '') !== String(policy.quote ?? '')) console.log('  QUOTE_TRIM');
      if (fixed.image_url !== policy.image_url) console.log('  CAPTION_FIT dropped_image');
      return fixed;
    };

    const gate = freshness(publishedAt, NOW, { maxAgeHours: config.freshness_hours.pre_gate });
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
        await deliverReview({
          candidate,
          article,
          assessment: { reason: 'thin_content' },
          reason: 'thin_content',
          kind,
          text: leftover,
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
    let offerAssessment = null;
    let offerContext = null;
    if (offer.isOffer) {
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
        date: offerAssessment.expiry.date,
        remainingHours: offerAssessment.expiry.remainingHours,
        expiry: offerAssessment.expiry,
        minRemainingHours: config.offers.min_remaining_hours,
      };
      console.log(`  OFFER eligible | expires ${offerAssessment.expiry.date} | ${offerAssessment.expiry.remainingHours}h left`);
    }

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

    const newsDate = newsDateLine(publishedAt);
    const qaContext = {
      url: article.url,
      host,
      sourceType: candidate.sourceType,
      category: parsed.category,
      imageUrl,
      title: article.title,
      description: article.description,
      content: article.content,
      publishedAt,
      now: NOW,
      offer: offerContext,
      previousWhy,
    };
    let qa = qaPost(parsed, qaContext);
    let repair = null;

    const offerQaFailed = Boolean(offerContext) && qa.problems.some((problem) => problem.startsWith('offer_'));
    const relevanceFailed = qa.problems.includes('ai_relevance');
    const styleWarning =
      qa.warnings.includes('formal_verbs') ||
      qa.warnings.includes('why_repeat') ||
      qa.warnings.includes('why');
    if (parsed.decision === 'publish' && (!qa.pass || styleWarning) && !offerQaFailed && !relevanceFailed && !offerContext) {
      console.log(`  ${qa.pass ? 'STYLE_WARNING' : 'QA_FAILED'} ${qa.problems.join(',') || qa.warnings.join(',')} | one repair retry`);
      repair = await callWithRetry(
        writerOptions(writer, buildQaRepairMessage({ user: activeUser, parsed, qa, imageUrl, previousWhy, newsDate })),
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

    if (parsed.decision === 'skip') {
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
      } else {
        await deferOrClose(candidate, 'qa_failed', qa.problems.join(','));
      }
      console.log(`  QA_FAILED ${qa.problems.join(',')} | score ${qa.score}/${qa.possible}`);
      continue;
    }

    const category = parsed.category;
    if (!MAIN_CATEGORIES.includes(category)) {
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
    const categoryCap = Number(config.diversity?.max_per_category_per_day ?? 3);
    const todayCategoryCount = categoryCountForDate(state, slot.date)[category] ?? 0;
    if (todayCategoryCount >= categoryCap) {
      console.log(`  DIVERSITY_CATEGORY_DAILY ${category} ${todayCategoryCount}/${categoryCap}`);
      await deferOrClose(candidate, 'category_daily_cap', category);
      continue;
    }
    const previous = lastPublishedOnDate(state, slot.date);
    if (
      config.diversity?.no_consecutive_category !== false &&
      !offerPriority &&
      previous?.category === category
    ) {
      console.log(`  DIVERSITY_CATEGORY_CONSECUTIVE ${category}`);
      await deferOrClose(candidate, 'category_consecutive', category);
      continue;
    }

    const dir = outboxDir(slot.key);
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
      diversity: {
        target: planned.target,
        hint: candidate.categoryHint ?? '',
        source_usage: planned.sourceUsage,
      },
      offer: offerContext ? {
        detected: true,
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
      dedupe_key: parsed.dedupe_key,
      post_type: parsed.post_type,
      importance: parsed.importance,
      verification: parsed.verification,
      offer: offerContext ? { expiry: offerContext.expiry.date, remaining_hours: offerContext.remainingHours } : null,
      qa: { pass: qa.pass, score: qa.score, possible: qa.possible, warnings: qa.warnings },
      createdAt: NOW,
    }, null, 2));
    await writeFile(postFile, `${postText(post)}\n`);
    await writeFile(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(
      resolve(dir, 'response.txt'),
      [call.content, retry ? `--- JSON RETRY ---\n\n${retry.content}` : '', repair ? `--- QA REPAIR ---\n\n${repair.content}` : '']
        .filter(Boolean)
        .join('\n\n')
    );
    const window = SEND
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
      markSlot(state, slot.key, {
        status: 'review',
        category,
        title: post.title,
        postDir: dir,
        mode: RUN_MODE,
        reason,
        model: writer.model,
        fallback,
        cost,
        tokens,
        qa: `${qa.score}/${qa.possible}`,
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
      try {
        const sent = await sendTelegram(post, {
          token: env.TELEGRAM_BOT_TOKEN,
          chatId: CHAT_ID,
          imagePath: downloaded?.file ?? '',
        });
        status = 'sent';
        messageId = sent.messageId;
      } catch (error) {
        status = 'ready';
        const sendError = String(error?.message ?? error);
        markSlot(state, slot.key, {
          status,
          category,
          title: post.title,
          postDir: dir,
          error: sendError,
          model: writer.model,
          cost,
          tokens,
          qa: `${qa.score}/${qa.possible}`,
        });
        if (offerContext || candidate.toolHint || candidate.officialCourse) {
          try {
            await deliverReview({
              candidate,
              article,
              assessment: { reason: 'send_failed', expiry: offerAssessment?.expiry },
              reason: 'send_failed',
              kind: offerContext ? 'offer' : 'tool',
              mainEligible: true,
              post,
              note: `ارسال به کانال اصلی ناموفق بود (${sendError.slice(0, 160)})؛ پست آماده برای بازبینی نگه داشته شد.`,
            });
          } catch (reviewError) {
            console.log(`REVIEW_PRESERVE_FAILED ${redact(reviewError?.message ?? reviewError)}`);
          }
        }
        await deferOrClose(candidate, 'send_failed', sendError);
        console.log(`SEND_FAILED ${sendError}`);
        console.log(`OUTBOX ${dir}`);
        console.log('NOTHING_WAS_SENT');
        process.exit(1);
      }
    }

    markSlot(state, slot.key, {
      status,
      category,
      title: post.title,
      postDir: dir,
      messageId,
      mode: RUN_MODE,
      model: writer.model,
      fallback,
      cost,
      tokens,
      qa: `${qa.score}/${qa.possible}`,
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
      postKey: `${slot.date}/${slot.slot.replace(':', '-')}`,
      kind: offerContext ? 'offer' : 'news',
      why: importanceOf(parsed.body),
      sourceId: candidate.sourceId || candidate.leadSource || '',
      sourceName: candidate.sourceName || candidate.leadSource || '',
      sourceType: candidate.sourceType || 'telegram_channel',
      url: article.url,
    });
    pruneState(state, NOW, reviewPrune);
    await saveState(STATE_PATH, state);

    published = { post, category, dir, status, messageId, cost, tokens, qa, image: Boolean(downloaded), offer: Boolean(offerContext) };
    break;
  }

  if (!published) {
    markSlot(state, slot.key, { status: 'empty', reason: 'all_candidates_rejected', cost: totalCost, tokens: totalTokens });
    pruneState(state, NOW, reviewPrune);
    await saveState(STATE_PATH, state);
    console.log(`RESULT EMPTY attempts=${attempts.length} reviews=${reviews} deferred=${Object.keys(state.deferred ?? {}).length} | cost $${totalCost.toFixed(6)} | tokens ${totalTokens}`);
    console.log('NOTHING_WAS_SENT');
    return;
  }

  const resultLabel = published.status === 'sent' ? 'SENT' : published.status === 'review' ? 'REVIEW' : 'READY';
  console.log(`RESULT ${resultLabel} category=${published.category} | offer=${published.offer ? 'yes' : 'no'} | image=${published.image ? 'yes' : 'no'} | QA ${published.qa.score}/${published.qa.possible} | cost $${totalCost.toFixed(6)} | post $${published.cost.toFixed(6)} | tokens ${totalTokens}`);
  console.log(`TITLE ${published.post.title}`);
  console.log(`OUTBOX ${published.dir}`);
  console.log(
    published.status === 'review'
      ? 'REVIEW_COPY — NOTHING_SENT_TO_MAIN'
      : SEND
        ? (REVIEW_SEND ? 'SENT_TO_REVIEW' : 'SENT_TO_TELEGRAM')
        : 'DRY_RUN — NOTHING_WAS_SENT'
  );
}

await main();
