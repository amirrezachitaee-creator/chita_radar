import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { canonicalUrl, contentHash } from './normalize.mjs';
import { parseFeed } from './engine.mjs';
import { dateKey } from './store.mjs';

export const DISCOVERY_VERSION = 1;
export const DEFAULT_DISCOVERY = Object.freeze({
  min_items: 2,
  window_days: 30,
  max_candidates: 4,
  max_attempts: 6,
  max_sources: 6,
  max_new_per_day: 1,
  timeout_ms: 8000,
  trial_days: 14,
  recent_days: 14,
  feed_paths: ['/feed', '/feed/', '/rss.xml', '/rss/', '/atom.xml', '/feed.xml', '/index.xml'],
});

const AI_WORD = /(?:\b(?:ai|a\.i\.|llm|llms|gpt|chatgpt|claude|gemini|deepseek|qwen|mistral|openai|anthropic|huggingface|hugging\s+face|transformer|transformers|machine\s+learning|deep\s+learning|neural|inference|benchmark|model|models|agent|agents|diffusion|rag|embedding|embeddings)\b|هوش\s*مصنوعی|یادگیری\s*ماشین|مدل\s*زبان|مدل|ایجنت|بنچمارک|استنتاج)/iu;

export function looksAi(text) {
  return AI_WORD.test(String(text ?? ''));
}

export function emptyDynamicSources() {
  return {
    version: DISCOVERY_VERSION,
    updatedAt: '',
    lastDiscoveryDate: '',
    lastCheckedAt: '',
    sources: [],
  };
}

export function normalizeDynamicSources(value) {
  const base = emptyDynamicSources();
  if (!value || typeof value !== 'object') return base;
  return {
    ...base,
    ...value,
    version: DISCOVERY_VERSION,
    sources: Array.isArray(value.sources)
      ? value.sources.filter((source) => source && typeof source === 'object' && source.id)
      : [],
  };
}

export async function loadDynamicSources(path) {
  try {
    return normalizeDynamicSources(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyDynamicSources();
    throw error;
  }
}

export async function saveDynamicSources(path, document) {
  await mkdir(dirname(path), { recursive: true });
  document.updatedAt = new Date().toISOString();
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
}

function hostOf(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceHosts(source) {
  const hosts = [];
  const values = [
    source?.url,
    source?.feed_url,
    source?.api_url,
    source?.index_url,
    source?.commits_url,
    source?.data_url,
    ...(Array.isArray(source?.watch_urls) ? source.watch_urls.map((entry) => entry?.url) : []),
  ];
  for (const value of values) {
    const host = hostOf(value);
    if (host) hosts.push(host);
  }
  return hosts;
}

function isSameOrSubdomain(host, other) {
  return host === other || host.endsWith(`.${other}`) || other.endsWith(`.${host}`);
}

function isBlockedHost(host, denyDomains) {
  if (!host || !host.includes('.') || host === 'localhost') return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.invalid')) return true;
  return (denyDomains ?? [])
    .map((value) => String(value ?? '').toLowerCase().replace(/^www\./, ''))
    .filter(Boolean)
    .some((denied) => isSameOrSubdomain(host, denied));
}

export function extractCandidateDomains({
  states = [],
  registrySources = [],
  denyDomains = [],
  extraUrls = [],
  now,
  windowDays = DEFAULT_DISCOVERY.window_days,
  minItems = DEFAULT_DISCOVERY.min_items,
  maxCandidates = DEFAULT_DISCOVERY.max_candidates,
} = {}) {
  const nowMs = Date.parse(String(now ?? ''));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const cutoff = nowMs - Math.max(1, Number(windowDays) || DEFAULT_DISCOVERY.window_days) * 86400000;
  const registered = (registrySources ?? []).flatMap(sourceHosts);
  const seenHosts = new Map();

  const add = (raw, title = '', at = '') => {
    const ms = at ? Date.parse(String(at)) : NaN;
    if (Number.isFinite(ms) && ms < cutoff) return;
    const host = hostOf(raw);
    if (!host || isBlockedHost(host, denyDomains)) return;
    if (registered.some((other) => isSameOrSubdomain(host, other))) return;
    let canonical = '';
    try {
      canonical = canonicalUrl(raw);
    } catch {
      canonical = String(raw);
    }
    const entry = seenHosts.get(host) ?? { host, urls: new Set(), titles: [], firstAt: '' };
    entry.urls.add(canonical);
    if (title && entry.titles.length < 5) entry.titles.push(String(title).slice(0, 160));
    if (!entry.firstAt && at) entry.firstAt = at;
    seenHosts.set(host, entry);
  };

  for (const state of states ?? []) {
    for (const published of state?.published ?? []) {
      add(published?.url, published?.title, published?.at);
    }
  }
  for (const raw of extraUrls ?? []) add(raw);

  return [...seenHosts.values()]
    .filter((entry) => entry.urls.size >= Math.max(1, Number(minItems) || DEFAULT_DISCOVERY.min_items))
    .map((entry) => ({
      host: entry.host,
      urls: [...entry.urls].slice(0, 10),
      titles: entry.titles,
      count: entry.urls.size,
      firstAt: entry.firstAt,
    }))
    .sort((left, right) => right.count - left.count || left.host.localeCompare(right.host))
    .slice(0, Math.max(1, Number(maxCandidates) || DEFAULT_DISCOVERY.max_candidates));
}

function inferCategories(titles = []) {
  const text = titles.join(' ');
  const categories = [];
  if (/(model|models|benchmark|llm|gpt|claude|gemini|deepseek|qwen|mistral|مدل|بنچمارک)/iu.test(text)) {
    categories.push('models');
  }
  categories.push('tools');
  return categories;
}

function slug(value) {
  const base = String(value ?? '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34);
  return base || 'source';
}

export function dynamicSourceId(host) {
  return `auto-${slug(host)}-${contentHash(String(host).toLowerCase()).slice(0, 6)}`;
}

function feedCandidates(host, paths) {
  return [...new Set((paths ?? DEFAULT_DISCOVERY.feed_paths).map((path) => `https://${host}${path}`))];
}

async function safeFetchText(url, { accept, timeout, redact, denyDomains }) {
  let current = String(url);
  for (let hop = 0; hop < 4; hop += 1) {
    const host = hostOf(current);
    if (!host || isBlockedHost(host, denyDomains)) throw new Error('BLOCKED_HOST');
    const response = await fetch(current, {
      headers: { 'user-agent': 'chita-radar-source-discovery/1.0', accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status}`);
      current = new URL(location, current).href;
      continue;
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 2_000_000) throw new Error('FEED_TOO_LARGE');
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${redact(text).slice(0, 120)}`);
    return { text, url: current, status: response.status };
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

export async function discoverFeeds({
  candidates = [],
  fetchImpl = null,
  redact = (value) => String(value ?? '').slice(0, 160),
  now,
  settings = DEFAULT_DISCOVERY,
  denyDomains = [],
} = {}) {
  const nowMs = Date.parse(String(now ?? ''));
  if (!Number.isFinite(nowMs)) throw new Error('invalid now');
  const config = { ...DEFAULT_DISCOVERY, ...(settings ?? {}) };
  const recentCutoff = nowMs - Math.max(1, Number(config.recent_days) || 14) * 86400000;
  const found = [];
  const errors = [];
  let attempts = 0;

  for (const candidate of candidates ?? []) {
    if (attempts >= config.max_attempts) break;
    const host = String(candidate?.host ?? '');
    if (isBlockedHost(host, denyDomains)) continue;
    for (const url of feedCandidates(host, config.feed_paths)) {
      if (attempts >= config.max_attempts) break;
      attempts += 1;
      try {
        const response = fetchImpl
          ? await fetchImpl(url, {
              accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
              timeout: config.timeout_ms,
              redact,
            })
          : await safeFetchText(url, {
              accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
              timeout: config.timeout_ms,
              redact,
              denyDomains,
            });
        const finalHost = hostOf(response?.url || url);
        if (!finalHost || isBlockedHost(finalHost, denyDomains)) continue;
        const items = parseFeed(String(response?.text ?? '')).slice(0, 20);
        if (items.length < 2) continue;
        const dated = items.filter((item) => Number.isFinite(Date.parse(String(item.published ?? ''))));
        const recent = dated.filter((item) => Date.parse(String(item.published)) >= recentCutoff);
        const aiItems = items.filter((item) => looksAi(`${item.title ?? ''} ${item.summary ?? ''}`));
        if (!recent.length || !aiItems.length) continue;
        found.push({
          host,
          feedUrl: response?.url || url,
          itemCount: items.length,
          recentCount: recent.length,
          aiCount: aiItems.length,
          titles: aiItems.slice(0, 5).map((item) => item.title),
          sampleUrls: aiItems.slice(0, 3).map((item) => item.link),
        });
        break;
      } catch (error) {
        errors.push({ host, url, error: String(error?.message ?? error) });
      }
    }
  }

  return { found, errors, attempts };
}

export function shouldDiscover({ document, now }) {
  return document?.lastDiscoveryDate !== dateKey(now);
}

export function addDiscoveredSource(document, discovery, {
  now,
  settings = DEFAULT_DISCOVERY,
  discoveredFrom = [],
} = {}) {
  const config = { ...DEFAULT_DISCOVERY, ...(settings ?? {}) };
  const doc = normalizeDynamicSources(document);
  const host = String(discovery?.host ?? '');
  if (!host || !discovery?.feedUrl) return { added: false, reason: 'invalid', document: doc };
  if (doc.sources.length >= config.max_sources) return { added: false, reason: 'cap', document: doc };
  if (doc.sources.some((source) => String(source.feed_url ?? '') === discovery.feedUrl)) {
    return { added: false, reason: 'duplicate', document: doc };
  }
  const nowMs = Date.parse(String(now));
  const source = {
    id: dynamicSourceId(host),
    name: host,
    url: `https://${host}/`,
    feed_url: discovery.feedUrl,
    type: 'discovered_feed',
    use: 'feed',
    categories: inferCategories(discovery.titles),
    require_ai: true,
    max_items_per_run: 1,
    discoveredAt: new Date(nowMs).toISOString(),
    trialUntil: new Date(nowMs + Math.max(1, Number(config.trial_days) || 14) * 86400000).toISOString(),
    discoveredFrom: (discoveredFrom ?? []).slice(0, 5),
    sampleTitles: (discovery.titles ?? []).slice(0, 5),
  };
  doc.sources.push(source);
  return { added: true, source, document: doc };
}

export function discoverySummary(result, limit = 5) {
  return (result?.found ?? [])
    .slice(0, limit)
    .map((entry) => `${entry.host} (${entry.recentCount} تازه، ${entry.aiCount} هوش مصنوعی)`)
    .join('، ');
}
