import { canonicalUrl, freshness } from './normalize.mjs';
import { fetchText, parseFeed } from './engine.mjs';
import { dedupeKeys, findSeenInStates } from './store.mjs';
import { hasReferral, offerHint } from './offers.mjs';
import { aiHint, isAiCentral } from './relevance.mjs';
import { categoryHint } from './diversity.mjs';
import { fetchArticleIndex } from './benchmark.mjs';
import { fetchGamefeel } from './gamefeel.mjs';
import { watchPolicySource } from './policy-watch.mjs';
import { fetchDailyPapers, selectDailyPapers } from './hf-papers.mjs';
import {
  classifyLead,
  externalLinksOf,
  hasAdOfferText,
  hasExternalLink,
  hasPromoText,
  isDigestText,
  isEducationLead,
  isOfficialCourse,
  isPromoHost,
  isPromotionalUrl,
  isRumorText,
  leadTitle,
  parseTelegramChannel,
  selectAnyLink,
  selectLeadLink,
  selectReviewLink,
  stripLeadNoise,
  telegramSourceEnabled,
} from './telegram-source.mjs';

export { aiHint };
export { categoryHint };

export function rankCandidates(candidates) {
  return [...candidates].sort(
    (left, right) =>
      Number(right.policy) - Number(left.policy) ||
      Number(right.offerHint) - Number(left.offerHint) ||
      Number(right.aiCentral) - Number(left.aiCentral) ||
      Number(right.aiHint) - Number(left.aiHint) ||
      left.ageHours - right.ageHours ||
      String(left.title).localeCompare(String(right.title))
  );
}

const afterStart = (published, activeFrom) => {
  const publishedMs = Date.parse(String(published ?? ''));
  const startMs = Date.parse(String(activeFrom ?? ''));
  if (!Number.isFinite(publishedMs) || !Number.isFinite(startMs)) return true;
  return publishedMs >= startMs;
};

const emptyTelegramStats = () => ({
  channels: 0,
  posts: 0,
  pending: 0,
  leads: 0,
  noLink: 0,
  denied: 0,
  promoted: 0,
  nonAiEducation: 0,
  reviewSkipped: 0,
  reviewAds: 0,
  stale: 0,
  beforeStart: 0,
  duplicate: 0,
  crossLane: 0,
  truncated: 0,
  errors: 0,
});

function seenAcrossLanes(state, memoryStates, keys, now) {
  const active = findSeenInStates([state], keys, now);
  if (active) return { hit: active, crossLane: false };
  const memory = findSeenInStates(memoryStates, keys, now);
  if (memory) return { hit: memory, crossLane: true };
  return null;
}

async function collectIndexSource({
  source,
  state,
  memoryStates,
  now,
  maxAgeHours,
  perSource,
  fetchImpl,
  redact,
  stats,
  candidates,
  seenThisRun,
}) {
  stats.sources += 1;
  let items;
  try {
    items = await fetchArticleIndex(source, fetchImpl, redact);
  } catch (error) {
    stats.errors.push({ source: source.id, kind: 'benchmark', error: String(error?.message ?? error) });
    return;
  }
  stats.indexItems += items.length;

  for (const item of items.slice(0, perSource)) {
    const gate = freshness(item.published, now, { maxAgeHours });
    if (!gate.ok) {
      if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
      else stats.stale += 1;
      continue;
    }
    let canonical;
    try {
      canonical = canonicalUrl(item.link);
    } catch {
      stats.noDate += 1;
      continue;
    }
    if (seenThisRun.has(canonical)) {
      stats.duplicate += 1;
      continue;
    }
    const keys = dedupeKeys({ url: canonical, title: item.title });
    const seen = seenAcrossLanes(state, memoryStates, keys, now);
    if (seen) {
      stats.duplicate += 1;
      if (seen.crossLane) stats.crossLane += 1;
      continue;
    }

    seenThisRun.add(canonical);
    const summary = item.summary ?? '';
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title: item.title,
      link: item.link,
      canonical,
      published: item.published,
      summary,
      images: [],
      ageHours: gate.ageHours,
      aiHint: aiHint(`${item.title} ${summary}`),
      aiCentral: isAiCentral(item.title, summary),
      offerHint: false,
      sourceCategories: Array.isArray(source.categories) ? source.categories : [],
      categoryHint: categoryHint({
        title: item.title,
        summary,
        sourceCategories: source.categories ?? [],
      }),
      keys,
    });
  }
}

async function collectBenchmarkSource({
  source,
  state,
  memoryStates,
  now,
  maxAgeHours,
  perSource,
  fetchImpl,
  redact,
  stats,
  candidates,
  seenThisRun,
}) {
  stats.sources += 1;
  let items;
  try {
    items = await fetchGamefeel(source, fetchImpl, redact);
  } catch (error) {
    stats.errors.push({ source: source.id, kind: 'benchmark', error: String(error?.message ?? error) });
    return;
  }
  stats.benchmarkItems += items.length;

  for (const item of items.slice(0, perSource)) {
    const gate = freshness(item.published, now, { maxAgeHours });
    if (!gate.ok) {
      if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
      else stats.stale += 1;
      continue;
    }
    let canonical;
    try {
      canonical = canonicalUrl(item.link);
    } catch {
      stats.noDate += 1;
      continue;
    }
    if (seenThisRun.has(canonical)) {
      stats.duplicate += 1;
      continue;
    }
    const keys = dedupeKeys({ url: canonical, title: item.title });
    const seen = seenAcrossLanes(state, memoryStates, keys, now);
    if (seen) {
      stats.duplicate += 1;
      if (seen.crossLane) stats.crossLane += 1;
      continue;
    }

    seenThisRun.add(canonical);
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title: item.title,
      link: item.link,
      canonical,
      published: item.published,
      summary: item.summary,
      messageText: item.messageText,
      images: [],
      ageHours: gate.ageHours,
      aiHint: true,
      aiCentral: true,
      offerHint: false,
      sourceCategories: Array.isArray(source.categories) ? source.categories : [],
      categoryHint: 'models',
      keys,
    });
  }
}

async function collectPolicySource({
  source,
  state,
  memoryStates,
  now,
  maxAgeHours,
  fetchImpl,
  redact,
  stats,
  candidates,
  seenThisRun,
  policyState,
  policy,
}) {
  stats.sources += 1;
  if (!policyState || typeof policyState !== 'object') {
    stats.errors.push({ source: source.id, kind: 'policy', error: 'policy_state_missing' });
    return;
  }

  let result;
  try {
    result = await watchPolicySource({
      source,
      policyState,
      now,
      fetchImpl,
      redact,
      reminderDays: Number(policy?.reminder_days ?? 7),
      slotDate: policy?.slot_date || '',
    });
  } catch (error) {
    stats.errors.push({ source: source.id, kind: 'policy', error: String(error?.message ?? error) });
    return;
  }
  for (const error of result.errors) {
    stats.errors.push({ source: source.id, kind: 'policy', error: `${error.url}: ${error.error}` });
  }

  stats.policyItems += result.items.length;
  stats.policyChanges += result.changes.length;
  stats.policyReminder += result.reminder ? 1 : 0;

  for (const item of result.items) {
    const canonical = item.canonical;
    if (seenThisRun.has(canonical)) {
      stats.duplicate += 1;
      continue;
    }
    const seen = seenAcrossLanes(state, memoryStates, item.keys, now);
    if (seen) {
      stats.duplicate += 1;
      if (seen.crossLane) stats.crossLane += 1;
      continue;
    }
    const gate = freshness(item.published, now, { maxAgeHours });
    if (!gate.ok) {
      if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
      else stats.stale += 1;
      continue;
    }

    seenThisRun.add(canonical);
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      policy: true,
      policyKind: item.policyKind,
      policyReminder: item.policyKind === 'effective_reminder',
      effectiveDate: item.effectiveDate || '',
      policyPageUrl: item.pageUrl || '',
      policyPageLabel: item.pageLabel || '',
      policyCountries: result.countries || null,
      title: item.title,
      link: item.link,
      canonical,
      published: item.published,
      summary: item.summary,
      messageText: item.messageText,
      images: [],
      ageHours: gate.ageHours,
      aiHint: true,
      aiCentral: true,
      offerHint: false,
      sourceCategories: Array.isArray(source.categories) ? source.categories : [],
      categoryHint: 'business',
      keys: item.keys,
      educationHint: false,
      webEducation: false,
      leadKind: 'policy',
    });
  }
}

async function collectApiSource({
  source,
  state,
  memoryStates,
  now,
  maxAgeHours,
  settings,
  fetchImpl,
  redact,
  stats,
  candidates,
  seenThisRun,
}) {
  if (settings.enabled === false) return;
  stats.sources += 1;

  let items;
  try {
    items = await fetchDailyPapers(source, fetchImpl, redact);
  } catch (error) {
    stats.errors.push({ source: source.id, kind: 'api', error: String(error?.message ?? error) });
    return;
  }
  stats.apiItems += items.length;

  const eligible = [];
  for (const item of items) {
    const gate = freshness(item.published, now, { maxAgeHours });
    if (!gate.ok) {
      if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
      else stats.stale += 1;
      continue;
    }
    eligible.push({ ...item, gate });
  }

  for (const item of selectDailyPapers(eligible, settings)) {
    const { gate } = item;
    let canonical;
    try {
      canonical = canonicalUrl(item.url);
    } catch {
      stats.noDate += 1;
      continue;
    }
    if (seenThisRun.has(canonical)) {
      stats.duplicate += 1;
      continue;
    }
    const keys = dedupeKeys({ url: canonical, title: item.title });
    const seen = seenAcrossLanes(state, memoryStates, keys, now);
    if (seen) {
      stats.duplicate += 1;
      if (seen.crossLane) stats.crossLane += 1;
      continue;
    }

    seenThisRun.add(canonical);
    const summary = item.summary ?? '';
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title: item.title,
      link: item.url,
      canonical,
      published: item.published,
      summary,
      messageText: summary,
      images: [],
      ageHours: gate.ageHours,
      aiHint: aiHint(`${item.title} ${summary}`),
      aiCentral: isAiCentral(item.title, summary),
      offerHint: false,
      needsReview: true,
      reviewReason: 'research_paper',
      sourceCategories: Array.isArray(source.categories) ? source.categories : [],
      categoryHint: categoryHint({
        title: item.title,
        summary,
        sourceCategories: source.categories ?? [],
      }),
      keys,
    });
  }
}

function isSameChannelUrl(raw, username) {
  try {
    const url = new URL(String(raw));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 't.me' && host !== 'telegram.me') return false;
    const [owner] = url.pathname.split('/').filter(Boolean);
    return String(owner ?? '').toLowerCase() === String(username ?? '').toLowerCase();
  } catch {
    return false;
  }
}

async function collectTelegramSource({
  source,
  state,
  memoryStates,
  now,
  maxAgeHours,
  fetchImpl,
  redact,
  settings,
  stats,
  candidates,
  seenThisRun,
}) {
  if (!telegramSourceEnabled(source, settings)) return;
  stats.telegram.channels += 1;

  const perChannel = Math.max(
    1,
    Number(source.max_posts_per_check ?? settings.per_channel ?? 15) || 15
  );
  const activeFrom = source.active_from || settings.active_from || '';
  const channelUrl = `https://t.me/s/${source.username}`;

  let page;
  try {
    page = await fetchImpl(channelUrl, { accept: 'text/html', redact });
  } catch (error) {
    stats.errors.push({ source: source.id, kind: 'telegram', error: String(error?.message ?? error) });
    stats.telegram.errors += 1;
    return;
  }

  const messages = parseTelegramChannel(page.text, source.username);
  stats.telegram.posts += messages.length;

  const cursor = Number(state.telegram?.[source.username]?.last_id ?? 0) || 0;
  const firstRun = cursor === 0;
  let pending = messages.filter((message) => message.id > cursor);
  stats.telegram.pending += pending.length;

  if (firstRun && activeFrom) {
    const before = pending.filter((message) => !afterStart(message.published, activeFrom));
    stats.telegram.beforeStart += before.length;
    pending = pending.filter((message) => afterStart(message.published, activeFrom));
  }

  if (!pending.length) {
    if (firstRun && messages.length) {
      const newest = messages[messages.length - 1];
      state.telegram ??= {};
      state.telegram[source.username] = {
        last_id: Math.max(cursor, newest.id),
        last_at: newest.published,
        checked_at: new Date(now).toISOString(),
      };
    } else if (state.telegram?.[source.username]) {
      state.telegram[source.username].checked_at = new Date(now).toISOString();
    }
    return;
  }

  const batch = pending.slice(0, perChannel);
  if (pending.length > batch.length) stats.telegram.truncated += 1;
  let lastProcessed = null;

  for (const message of batch) {
    lastProcessed = message;
    if (activeFrom && !afterStart(message.published, activeFrom)) {
      stats.telegram.beforeStart += 1;
      continue;
    }

    const gate = freshness(message.published, now, { maxAgeHours });
    if (!gate.ok) {
      if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
      else stats.telegram.stale += 1;
      continue;
    }

    const promo = hasPromoText(message.text) ||
      (message.links ?? []).some((link) =>
        isPromotionalUrl(link, { promoDomains: settings.promo_domains ?? [] })
      );

    const title = leadTitle(message, message.preview?.title ?? '');
    const rawText = String(message.text ?? '').replace(/\r\n?/g, '\n').trim();
    const detectionText = stripLeadNoise(message.text);
    const cleanText = stripLeadNoise(message.text, { maxChars: 1600 });
    const hint = `${title} ${detectionText}`;
    const officialCourseLink = [...(message.links ?? []), message.preview?.url]
      .filter(Boolean)
      .find((url) =>
        isOfficialCourse(url, hint, {
          officialCourseDomains: settings.official_course_domains ?? [],
        })
      );
    const educationCue = isEducationLead(hint) && !officialCourseLink;
    const aiCentral = isAiCentral(title, stripLeadNoise(message.text, { maxChars: 600 }));
    const aiMention = aiHint(hint);
    const titleAi = aiHint(title);
    const adText = hasAdOfferText(rawText);
    const rumorHint = isRumorText(hint);
    const relatedLinks = externalLinksOf(message, {
      promoDomains: settings.promo_domains ?? [],
    });
    const offerCue = offerHint(hint);
    const promoHost =
      (message.preview?.url
        ? isPromoHost(message.preview.url, { promoDomains: settings.promo_domains ?? [] })
        : false) ||
      (message.links ?? []).some((link) =>
        isPromoHost(link, { promoDomains: settings.promo_domains ?? [] })
      );
    if (promoHost && !educationCue) {
      stats.telegram.promoted += 1;
      continue;
    }
    const selectionOptions = {
      denyDomains: settings.deny_domains ?? [],
      denyExtensions: settings.deny_extensions ?? [],
      promoDomains: settings.promo_domains ?? [],
    };
    let selection = selectLeadLink(message, selectionOptions);
    let fallbackLink = false;
    if (!selection && aiMention) {
      selection = selectReviewLink(message, selectionOptions);
      fallbackLink = Boolean(selection);
    }
    let link = selection?.url ?? '';
    let leadKind = '';
    let linkFallback = '';
    if (educationCue) {
      leadKind = 'education';
      if (!aiCentral) stats.telegram.nonAiEducation += 1;
      if (!link) {
        const anyLink = selectAnyLink(message);
        link = anyLink && !isSameChannelUrl(anyLink, source.username) ? anyLink : message.url;
      }
    } else if (selection) {
      leadKind = classifyLead(link, hint, {
        promoDomains: settings.promo_domains ?? [],
        officialCourseDomains: settings.official_course_domains ?? [],
        aiRelevant: aiMention,
        aiCentral,
        offerCue,
      });
      if (fallbackLink && aiMention && leadKind === 'promotion') {
        leadKind = 'news';
      }
    } else if (aiMention) {
      link = message.url;
      leadKind = 'news';
      linkFallback = hasExternalLink(message) ? 'denied_link' : 'no_link';
    }
    if (!link) {
      if (promo) stats.telegram.promoted += 1;
      else if (hasExternalLink(message)) stats.telegram.denied += 1;
      else stats.telegram.noLink += 1;
      continue;
    }
    if (!educationCue && (leadKind === 'promotion' || leadKind === 'off_topic_education')) {
      if (leadKind === 'promotion') stats.telegram.promoted += 1;
      else stats.telegram.nonAiEducation += 1;
      continue;
    }

    let canonical;
    try {
      canonical = canonicalUrl(link);
    } catch {
      stats.telegram.noLink += 1;
      continue;
    }
    if (seenThisRun.has(canonical)) {
      stats.duplicate += 1;
      stats.telegram.duplicate += 1;
      continue;
    }

    const keys = dedupeKeys({ url: canonical, title });
    const seen = seenAcrossLanes(state, memoryStates, keys, now);
    if (seen) {
      stats.duplicate += 1;
      stats.telegram.duplicate += 1;
      if (seen.crossLane) {
        stats.crossLane += 1;
        stats.telegram.crossLane += 1;
      }
      continue;
    }

    seenThisRun.add(canonical);
    const referral =
      hasReferral(link) ||
      isPromotionalUrl(link, { promoDomains: settings.promo_domains ?? [] });
    const reviewCandidate =
      aiMention &&
      (fallbackLink || referral) &&
      (leadKind === 'tool_lead' || leadKind === 'free_offer' || leadKind === 'news');
    const reviewWorthy =
      aiCentral ||
      titleAi ||
      leadKind === 'tool_lead' ||
      leadKind === 'free_offer' ||
      leadKind === 'official_course';
    if (!reviewWorthy && (linkFallback || fallbackLink)) {
      stats.telegram.reviewSkipped += 1;
      continue;
    }
    if (isDigestText(hint) && (linkFallback || fallbackLink || reviewCandidate)) {
      stats.telegram.reviewSkipped += 1;
      continue;
    }
    if (adText && leadKind !== 'free_offer' && (linkFallback || fallbackLink || reviewCandidate)) {
      stats.telegram.reviewAds += 1;
      continue;
    }
    const needsReview = reviewWorthy && (Boolean(linkFallback) || reviewCandidate);
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      link,
      canonical,
      messageText: leadKind === 'education' ? rawText : cleanText,
      leadPostUrl: message.url,
      published: message.published,
      summary: '',
      images: message.images ?? [],
      ageHours: gate.ageHours,
      aiHint: aiMention,
      aiCentral,
      titleAi,
      rumorHint,
      relatedLinks,
      offerHint: aiMention && (leadKind === 'free_offer' || offerCue),
      toolHint: leadKind === 'tool_lead',
      sourceCategories: Array.isArray(source.categories) ? source.categories : [],
      categoryHint: categoryHint({
        title,
        summary: cleanText,
        sourceCategories: source.categories ?? [],
        toolHint: leadKind === 'tool_lead',
        offerHint: aiMention && (leadKind === 'free_offer' || offerCue),
        officialCourse: leadKind === 'official_course',
      }),
      referral,
      needsReview,
      reviewReason: linkFallback || (needsReview ? 'referral_link' : ''),
      keys,
      leadSource: source.username,
      leadMessageId: message.id,
      leadChannelUrl: `https://t.me/${source.username}`,
      sourceFocus: source.focus || '',
      leadKind,
      educationHint: leadKind === 'education',
      webEducation: false,
      officialCourse: leadKind === 'official_course',
    });
    stats.telegram.leads += 1;
  }

  if (lastProcessed) {
    state.telegram ??= {};
    state.telegram[source.username] = {
      last_id: Math.max(cursor, lastProcessed.id),
      last_at: lastProcessed.published,
      checked_at: new Date(now).toISOString(),
    };
  }
}

export async function collectCandidates({
  sources,
  state,
  memoryStates = [],
  now,
  perSource = 12,
  maxAgeHours = 72,
  fetchImpl = fetchText,
  redact,
  telegram = {},
  hfPapers = {},
  policyState = null,
  policy = {},
}) {
  const stats = {
    sources: 0,
    feedItems: 0,
    indexItems: 0,
    benchmarkItems: 0,
    policyItems: 0,
    policyChanges: 0,
    policyReminder: 0,
    apiItems: 0,
    stale: 0,
    noDate: 0,
    duplicate: 0,
    crossLane: 0,
    kept: 0,
    errors: [],
    telegram: emptyTelegramStats(),
  };
  const candidates = [];
  const seenThisRun = new Set();

  for (const source of sources) {
    if (source.type === 'telegram_channel') {
      await collectTelegramSource({
        source,
        state,
        memoryStates,
        now,
        maxAgeHours,
        fetchImpl,
        redact,
        settings: telegram,
        stats,
        candidates,
        seenThisRun,
      });
      continue;
    }
    if (source.status === 'proposed') continue;
    if (source.use === 'policy' && Array.isArray(source.watch_urls)) {
      await collectPolicySource({
        source,
        state,
        memoryStates,
        now,
        maxAgeHours,
        fetchImpl,
        redact,
        stats,
        candidates,
        seenThisRun,
        policyState,
        policy,
      });
      continue;
    }
    if (source.use === 'benchmark' && source.commits_url && source.data_url) {
      await collectBenchmarkSource({
        source,
        state,
        memoryStates,
        now,
        maxAgeHours,
        perSource,
        fetchImpl,
        redact,
        stats,
        candidates,
        seenThisRun,
      });
      continue;
    }
    if (source.use === 'page' && source.index_url) {
      await collectIndexSource({
        source,
        state,
        memoryStates,
        now,
        maxAgeHours,
        perSource,
        fetchImpl,
        redact,
        stats,
        candidates,
        seenThisRun,
      });
      continue;
    }
    if (source.use === 'api' && source.api_url) {
      await collectApiSource({
        source,
        state,
        memoryStates,
        now,
        maxAgeHours,
        settings: hfPapers,
        fetchImpl,
        redact,
        stats,
        candidates,
        seenThisRun,
      });
      continue;
    }
    if (!source.feed_url) continue;
    stats.sources += 1;
    let feed;
    try {
      feed = await fetchImpl(source.feed_url, {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        redact,
      });
    } catch (error) {
      stats.errors.push({ source: source.id, kind: 'feed', error: String(error?.message ?? error) });
      continue;
    }

    const items = parseFeed(feed.text).slice(0, perSource);
    stats.feedItems += items.length;

    for (const item of items) {
      const gate = freshness(item.published, now, { maxAgeHours });
      if (!gate.ok) {
        if (gate.reason === 'no_date' || gate.reason === 'bad_date') stats.noDate += 1;
        else stats.stale += 1;
        continue;
      }

      let canonical;
      try {
        canonical = canonicalUrl(item.link);
      } catch {
        stats.noDate += 1;
        continue;
      }
      if (seenThisRun.has(canonical)) {
        stats.duplicate += 1;
        continue;
      }

      const keys = dedupeKeys({ url: canonical, title: item.title });
      const seen = seenAcrossLanes(state, memoryStates, keys, now);
      if (seen) {
        stats.duplicate += 1;
        if (seen.crossLane) stats.crossLane += 1;
        continue;
      }

      seenThisRun.add(canonical);
      const feedText = `${item.title} ${item.summary}`;
      const aiRelevant = aiHint(feedText);
      const educationCategory =
        Array.isArray(source.categories) && source.categories.includes('education');
      const educationCue = aiRelevant && (educationCategory || isEducationLead(feedText));
      candidates.push({
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        title: item.title,
        link: item.link,
        canonical,
        published: item.published,
        summary: item.summary,
        messageText: educationCue ? String(item.summary ?? '') : '',
        leadPostUrl: item.link,
        images: item.images,
        ageHours: gate.ageHours,
        aiHint: aiRelevant,
        aiCentral: isAiCentral(item.title, item.summary),
        offerHint: offerHint(feedText),
        sourceCategories: Array.isArray(source.categories) ? source.categories : [],
        categoryHint: categoryHint({
          title: item.title,
          summary: item.summary,
          sourceCategories: source.categories ?? [],
          offerHint: offerHint(feedText),
        }),
        keys,
        educationHint: educationCue,
        webEducation: educationCue,
        leadKind: educationCue ? 'education' : '',
      });
    }
  }

  stats.kept = candidates.length;
  return { candidates: rankCandidates(candidates), stats };
}
