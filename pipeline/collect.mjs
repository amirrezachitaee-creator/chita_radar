import { canonicalUrl, freshness } from './normalize.mjs';
import { fetchText, parseFeed } from './engine.mjs';
import { dedupeKeys, findSeenInStates } from './store.mjs';
import { hasReferral, offerHint } from './offers.mjs';
import { aiHint, isAiCentral } from './relevance.mjs';
import { categoryHint } from './diversity.mjs';
import { fetchArticleIndex } from './benchmark.mjs';
import { fetchDailyPapers, selectDailyPapers } from './hf-papers.mjs';
import {
  classifyLead,
  hasExternalLink,
  hasPromoText,
  isEducationLead,
  isPromotionalUrl,
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
    const cleanText = stripLeadNoise(message.text, { maxChars: 1600 });
    const hint = `${title} ${cleanText}`;
    const aiCentral = isAiCentral(title, stripLeadNoise(message.text, { maxChars: 600 }));
    const aiMention = aiHint(hint);
    const offerCue = offerHint(hint);
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
    if (selection) {
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
    } else if (isEducationLead(hint)) {
      if (!aiCentral) {
        stats.telegram.nonAiEducation += 1;
        continue;
      }
      const anyLink = selectAnyLink(message);
      link = anyLink && !isSameChannelUrl(anyLink, source.username) ? anyLink : message.url;
      leadKind = 'education';
    }
    if (!link) {
      if (promo) stats.telegram.promoted += 1;
      else if (hasExternalLink(message)) stats.telegram.denied += 1;
      else stats.telegram.noLink += 1;
      continue;
    }
    if (leadKind === 'promotion' || leadKind === 'off_topic_education') {
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
    const needsReview =
      aiMention &&
      (fallbackLink || referral) &&
      (leadKind === 'tool_lead' || leadKind === 'free_offer' || leadKind === 'news');
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      link,
      canonical,
      messageText: cleanText,
      leadPostUrl: message.url,
      published: message.published,
      summary: '',
      images: [],
      ageHours: gate.ageHours,
      aiHint: aiMention,
      aiCentral,
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
      reviewReason: needsReview ? 'referral_link' : '',
      keys,
      leadSource: source.username,
      leadMessageId: message.id,
      leadChannelUrl: `https://t.me/${source.username}`,
      sourceFocus: source.focus || '',
      leadKind,
      educationHint: leadKind === 'education',
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
}) {
  const stats = {
    sources: 0,
    feedItems: 0,
    indexItems: 0,
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
      candidates.push({
        sourceId: source.id,
        sourceName: source.name,
        sourceType: source.type,
        title: item.title,
        link: item.link,
        canonical,
        published: item.published,
        summary: item.summary,
        images: item.images,
        ageHours: gate.ageHours,
        aiHint: aiHint(`${item.title} ${item.summary}`),
        aiCentral: isAiCentral(item.title, item.summary),
        offerHint: offerHint(`${item.title} ${item.summary}`),
        sourceCategories: Array.isArray(source.categories) ? source.categories : [],
        categoryHint: categoryHint({
          title: item.title,
          summary: item.summary,
          sourceCategories: source.categories ?? [],
          offerHint: offerHint(`${item.title} ${item.summary}`),
        }),
        keys,
      });
    }
  }

  stats.kept = candidates.length;
  return { candidates: rankCandidates(candidates), stats };
}
