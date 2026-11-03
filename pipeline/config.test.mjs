import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const vendors = JSON.parse(readFileSync(new URL('./vendors.json', import.meta.url), 'utf8'));

const MAIN = ['tools', 'models', 'security', 'business'];
const USES = new Set(['feed', 'reference', 'lead_only', 'api', 'page']);
const VENDOR_TYPES = new Set([
  'offer_directory',
  'offer_dataset',
  'api_provider',
  'model_host',
  'coding_agent',
  'voice_api',
  'image_video',
  'open_source',
  'credit_program',
]);

test('four main categories carry the weekly quotas and sum to 42', () => {
  assert.deepEqual(Object.keys(config.categories).filter((key) => config.categories[key].main_channel), MAIN);
  const total = MAIN.reduce((sum, key) => sum + config.categories[key].weekly_quota, 0);
  assert.equal(total, 42);
  assert.equal(config.categories.tools.weekly_quota, 17);
  assert.equal(config.categories.models.weekly_quota, 13);
  assert.equal(config.categories.security.weekly_quota, 6);
  assert.equal(config.categories.business.weekly_quota, 6);
});

test('education is private and never part of the main channel', () => {
  assert.equal(config.categories.education.main_channel, false);
  assert.equal(config.categories.education.weekly_quota, 0);
  assert.equal(config.categories.education.lane, 'private_research');
});

test('six Tehran slots, sorted, none inside sleeping hours', () => {
  const slots = config.schedule.slots;
  assert.equal(slots.length, 6);
  assert.equal(new Set(slots).size, 6);
  assert.deepEqual([...slots].sort(), slots);
  const [quietStart, quietEnd] = config.schedule.quiet_hours;
  for (const slot of slots) {
    assert.ok(slot >= quietEnd || slot <= quietStart, `${slot} is inside quiet hours`);
  }
  assert.equal(config.timezone, 'Asia/Tehran');
  assert.equal(config.schedule.max_posts_per_day, 6);
});

test('freshness windows match the approved policy', () => {
  assert.deepEqual(config.freshness_hours, {
    pre_gate: 72,
    tools: 48,
    models: 48,
    security: 72,
    business: 72,
    education: 720,
  });
  assert.equal(config.max_future_hours, 24);
});

test('media caption stays below the Telegram limit with a text fallback', () => {
  assert.ok(config.media.max_caption_chars < config.media.telegram_caption_limit);
  assert.ok(config.media.max_caption_chars <= 900);
  assert.equal(config.media.fallback, 'text_only');
  assert.deepEqual(config.media.allowed, ['article_lead_image']);
  assert.ok(config.media.forbidden.includes('stock_photo'));
  assert.ok(config.media.forbidden.includes('logo'));
});

test('offer policy is active and routes unclear cases to review', () => {
  assert.equal(config.offers.status, 'active');
  assert.equal(config.offers.category, 'tools');
  assert.ok(config.offers.max_per_day <= config.offers.max_per_week);
  assert.ok(config.offers.min_remaining_hours > 0);
  assert.ok(config.offers.max_age_hours <= config.freshness_hours.tools);
  assert.equal(config.offers.referral_allowed, false);
  assert.equal(config.offers.review.enabled, true);
  assert.equal(config.offers.review.chat_env, 'TELEGRAM_REVIEW_CHAT_ID');
  for (const reason of ['source_not_official', 'expiry_missing', 'expiry_soon', 'offer_qa_failed']) {
    assert.ok(config.offers.review.reasons.includes(reason), `${reason} is not routed to review`);
  }
});

test('every source points at a known category with an https url', () => {
  for (const source of sources.sources) {
    assert.ok(source.id, 'source id is required');
    assert.match(source.url, /^https:\/\//, `${source.id} is not https`);
    assert.ok(source.categories.length > 0, `${source.id} has no category`);
    assert.ok(USES.has(source.use), `${source.id} has unknown use ${source.use}`);
    for (const category of source.categories) {
      assert.ok(config.categories[category], `${source.id} uses unknown category ${category}`);
    }
    if (source.paywalled) assert.equal(source.use, 'lead_only', `${source.id} must be lead_only`);
    if (source.categories.includes('education')) {
      assert.equal(source.lane, 'private_research', `${source.id} must be private`);
    }
  }
});

test('every main category has at least one feed source', () => {
  for (const category of MAIN) {
    const feeds = sources.sources.filter(
      (source) => source.categories.includes(category) && source.use === 'feed'
    );
    assert.ok(feeds.length > 0, `${category} has no feed source`);
  }
});

test('source ids are unique and no directory is left in the news registry', () => {
  assert.equal(new Set(sources.sources.map((source) => source.id)).size, sources.sources.length);
  for (const id of ['perq', 'ai-free', 'free-inference', 'free-llm-api-hub']) {
    assert.ok(!sources.sources.some((source) => source.id === id), `${id} must live in vendors.json`);
  }
  assert.equal(sources.pending_url, undefined);
  assert.equal(sources.vendor_registry, 'vendors.json');
});

test('the vendor registry carries all 55 sources from the user document', () => {
  assert.equal(vendors.vendors.length, 55);
  assert.equal(new Set(vendors.vendors.map((vendor) => vendor.id)).size, 55);
  for (const vendor of vendors.vendors) {
    assert.ok(vendor.id, 'vendor id is required');
    assert.match(vendor.url, /^https:\/\//, `${vendor.id} is not https`);
    assert.ok(vendor.categories.length > 0, `${vendor.id} has no category`);
    assert.ok(VENDOR_TYPES.has(vendor.type), `${vendor.id} has unknown type ${vendor.type}`);
    assert.equal(vendor.offer_watch, vendor.status !== 'retired', `${vendor.id} has wrong watch flag`);
    for (const category of vendor.categories) {
      assert.ok(config.categories[category], `${vendor.id} uses unknown category ${category}`);
    }
  }
});

test('vendor groups cover the document without gaps', () => {
  const byId = new Map(vendors.vendors.map((vendor) => [vendor.id, vendor]));
  const groups = {
    discovery: ['perq', 'ai-free', 'free-llm-api-hub', 'o-llm-free-llm', 'free-inference'],
    api: [
      'google-ai-studio', 'openrouter', 'cloudflare-workers-ai', 'zai', 'cohere', 'deepgram',
      'jina-ai', 'ai21-labs', 'ovhcloud-ai-endpoints', 'vercel-ai-gateway', 'groq', 'mistral',
      'huggingface', 'fireworks-ai', 'siliconflow',
    ],
    coding: ['qoder', 'cursor', 'cline', 'kilo-code', 'windsurf', 'trae', 'freebuff'],
    voice: ['elevenlabs', 'speechmatics', 'assemblyai', 'cartesia', 'gladia', 'hume-ai', 'sarvam-ai'],
    image: ['leonardo-ai', 'ideogram', 'pixverse', 'hailuo-ai', 'kling-ai', 'playground'],
    local: ['ollama', 'lm-studio', 'jan', 'gpt4all', 'llama-cpp', 'comfyui', 'open-webui', 'anythingllm', 'vllm', 'localai'],
    credits: ['google-cloud', 'microsoft-for-startups', 'cloudflare', 'amd-developer-cloud', 'daytona'],
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, ids.length])),
    { discovery: 5, api: 15, coding: 7, voice: 7, image: 6, local: 10, credits: 5 }
  );
  for (const ids of Object.values(groups)) {
    for (const id of ids) assert.ok(byId.has(id), `${id} is missing from vendors.json`);
  }
});

test('the four discovery directories have exact urls and are discovery-only', () => {
  const byId = new Map(vendors.vendors.map((vendor) => [vendor.id, vendor]));
  const expected = {
    perq: 'https://perq.sh/',
    'ai-free': 'https://aifree.dev/',
    'free-inference': 'https://www.freeinference.dev/',
    'free-llm-api-hub': 'https://github.com/pacocartones/free-llm-api-hub',
  };
  for (const [id, url] of Object.entries(expected)) {
    const vendor = byId.get(id);
    assert.ok(vendor, `${id} is missing`);
    assert.equal(vendor.url, url);
    assert.equal(vendor.discovery_only, true);
    assert.deepEqual(vendor.categories, ['tools']);
  }
  assert.equal(byId.get('o-llm-free-llm').status, 'retired');
});

test('news sources and vendor registry do not overlap', () => {
  const sourceIds = new Set(sources.sources.map((source) => source.id));
  for (const vendor of vendors.vendors) {
    assert.ok(!sourceIds.has(vendor.id), `${vendor.id} is registered twice`);
  }
});

test('the eight earlier gap sources are recorded as proposed, not verified', () => {
  const proposed = sources.sources
    .filter((source) => source.status === 'proposed')
    .map((source) => source.id)
    .sort();
  assert.deepEqual(proposed, [
    'arxiv',
    'bleepingcomputer',
    'gdelt',
    'google-news-rss',
    'krebs',
    'the-record',
    'trm-labs',
    'wsj',
  ]);
});
