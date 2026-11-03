import { canonicalUrl, freshness } from './normalize.mjs';
import { fetchText, parseFeed } from './engine.mjs';
import { dedupeKeys, findSeen } from './store.mjs';
import { offerHint } from './offers.mjs';
import { aiHint, isAiCentral } from './relevance.mjs';
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
  telegramSourceEnabled,
} from './telegram-source.mjs';

export { aiHint };

export function rankCandidates(candidates) {
  return [...candidates].sort(
    (left, right) =>
      Number(right.offerHint) - Number(left.offerHint) ||
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
  stale: 0,
  beforeStart: 0,
  duplicate: 0,
  truncated: 0,
  errors: 0,
});

async function collectTelegramSource({
  source,
  state,
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

    const selection = selectLeadLink(message, {
      denyDomains: settings.deny_domains ?? [],
      denyExtensions: settings.deny_extensions ?? [],
      promoDomains: settings.promo_domains ?? [],
    });
    const title = leadTitle(message, selection?.previewTitle ?? message.preview?.title ?? '');
    const hint = `${title} ${message.text}`;
    let link = selection?.url ?? '';
    let leadKind = '';
    if (selection) {
      leadKind = classifyLead(link, hint, {
        promoDomains: settings.promo_domains ?? [],
        officialCourseDomains: settings.official_course_domains ?? [],
      });
    } else if (isEducationLead(hint)) {
      link = selectAnyLink(message) || message.url;
      leadKind = 'education';
    }
    if (!link) {
      if (promo) stats.telegram.promoted += 1;
      else if (hasExternalLink(message)) stats.telegram.denied += 1;
      else stats.telegram.noLink += 1;
      continue;
    }
    if (leadKind === 'promotion') {
      stats.telegram.promoted += 1;
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
    if (findSeen(state, keys)) {
      stats.duplicate += 1;
      stats.telegram.duplicate += 1;
      continue;
    }

    seenThisRun.add(canonical);
    candidates.push({
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      link,
      canonical,
      messageText: message.text,
      leadPostUrl: message.url,
      published: message.published,
      summary: '',
      images: [],
      ageHours: gate.ageHours,
      aiHint: aiHint(hint),
      aiCentral: isAiCentral(title, message.text),
      offerHint: false,
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
  now,
  perSource = 12,
  maxAgeHours = 72,
  fetchImpl = fetchText,
  redact,
  telegram = {},
}) {
  const stats = {
    sources: 0,
    feedItems: 0,
    stale: 0,
    noDate: 0,
    duplicate: 0,
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
      if (findSeen(state, keys)) {
        stats.duplicate += 1;
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
        keys,
      });
    }
  }

  stats.kept = candidates.length;
  return { candidates: rankCandidates(candidates), stats };
}
