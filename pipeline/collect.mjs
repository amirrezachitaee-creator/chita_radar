import { canonicalUrl, freshness } from './normalize.mjs';
import { fetchText, parseFeed } from './engine.mjs';
import { dedupeKeys, findSeen } from './store.mjs';
import { offerHint } from './offers.mjs';

const AI_HINT = /\b(ai|a\.i\.|openai|anthropic|claude|chatgpt|gemini|deepmind|llm|llms|model|models|agent|agents|agentic|inference|nvidia|gpu|gpus|data center|data centers|machine learning|neural|chatbot|copilot|robot|robotics|semiconductor|chip|chips)\b/i;

export function aiHint(text) {
  return AI_HINT.test(String(text ?? ''));
}

export function rankCandidates(candidates) {
  return [...candidates].sort(
    (left, right) =>
      Number(right.offerHint) - Number(left.offerHint) ||
      Number(right.aiHint) - Number(left.aiHint) ||
      left.ageHours - right.ageHours ||
      String(left.title).localeCompare(String(right.title))
  );
}

export async function collectCandidates({
  sources,
  state,
  now,
  perSource = 12,
  maxAgeHours = 72,
  fetchImpl = fetchText,
  redact,
}) {
  const stats = {
    sources: 0,
    feedItems: 0,
    stale: 0,
    noDate: 0,
    duplicate: 0,
    kept: 0,
    errors: [],
  };
  const candidates = [];
  const seenThisRun = new Set();

  for (const source of sources) {
    if (!source.feed_url) continue;
    stats.sources += 1;
    let feed;
    try {
      feed = await fetchImpl(source.feed_url, {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        redact,
      });
    } catch (error) {
      stats.errors.push({ source: source.id, error: String(error?.message ?? error) });
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
        offerHint: offerHint(`${item.title} ${item.summary}`),
        keys,
      });
    }
  }

  stats.kept = candidates.length;
  return { candidates: rankCandidates(candidates), stats };
}
