import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
const vendors = JSON.parse(readFileSync(new URL('./vendors.json', import.meta.url), 'utf8'));
const workflow = readFileSync(
  new URL('../.github/workflows/slot-runner.yml', import.meta.url),
  'utf8'
);

const MAIN = ['tools', 'models', 'security', 'business'];
const USES = new Set(['feed', 'reference', 'lead_only', 'api', 'page', 'benchmark', 'policy']);
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

test('four main categories carry the weekly quotas and sum to 77', () => {
  assert.deepEqual(Object.keys(config.categories).filter((key) => config.categories[key].main_channel), MAIN);
  const total = MAIN.reduce((sum, key) => sum + config.categories[key].weekly_quota, 0);
  assert.equal(total, 77);
  assert.equal(config.categories.tools.weekly_quota, 31);
  assert.equal(config.categories.models.weekly_quota, 24);
  assert.equal(config.categories.security.weekly_quota, 11);
  assert.equal(config.categories.business.weekly_quota, 11);
});

test('education is private and never part of the main channel', () => {
  assert.equal(config.categories.education.main_channel, false);
  assert.equal(config.categories.education.weekly_quota, 0);
  assert.equal(config.categories.education.lane, 'private_research');
});

test('the workflow candidate cap cannot override the runtime config', () => {
  assert.ok(
    workflow.includes(`default: "${config.diversity.max_candidates}"`),
    'the dispatch default drifted from config.diversity.max_candidates'
  );
  assert.ok(
    workflow.includes(`|| '${config.diversity.max_candidates}'`),
    'the scheduled fallback drifted from config.diversity.max_candidates'
  );
});

test('external dispatch cannot force a slot and the six cron slots stay as backup', () => {
  assert.match(workflow, /repository_dispatch:\s*\n\s*types:\s*\[slot-tick\]/);
  assert.equal(workflow.includes('client_payload.force'), false, 'dispatch can still force a run');
  assert.ok(
    workflow.includes("github.event_name == 'workflow_dispatch' && github.event.inputs.force"),
    'force is not limited to manual dispatch'
  );
  assert.ok(workflow.includes('DISPATCH_FORCE_REJECTED'));
  for (const cron of ['0 5 * * *', '0 8 * * *', '30 10 * * *', '30 13 * * *', '0 17 * * *', '30 19 * * *']) {
    assert.ok(workflow.includes(`cron: "${cron}"`), `backup cron ${cron} is missing`);
  }
});

test('education review is uncapped, model-free and verbatim', () => {
  assert.equal(config.education_review.enabled, true);
  assert.equal(config.education_review.max_per_day, 0);
  assert.equal(config.education_review.max_per_source_per_day, 0);
  assert.equal(config.education_review.require_ai_central, false);
  assert.equal(config.education_review.verbatim, true);
  assert.equal(config.education_review.max_text_chars, 0);
});

test('the main review channel is uncapped and keeps only a retry buffer', () => {
  assert.equal(config.offers.review.enabled, true);
  assert.equal(config.offers.review.max_per_day, 0);
  assert.equal(config.offers.review.max_per_source_per_day, 0);
  assert.ok(config.offers.review.pending_ttl_hours >= 240);
  assert.ok(config.offers.review.reasons.includes('qa_failed'));
});

test('six Tehran slots, sorted, none inside sleeping hours and two posts each', () => {
  const slots = config.schedule.slots;
  assert.equal(slots.length, 6);
  assert.equal(new Set(slots).size, 6);
  assert.deepEqual([...slots].sort(), slots);
  const [quietStart, quietEnd] = config.schedule.quiet_hours;
  for (const slot of slots) {
    assert.ok(slot >= quietEnd || slot <= quietStart, `${slot} is inside quiet hours`);
  }
  assert.equal(config.timezone, 'Asia/Tehran');
  assert.equal(config.schedule.max_posts_per_day, 11);
  assert.equal(config.schedule.max_posts_per_slot, 2);
  assert.equal(config.schedule.min_gap_minutes, 12);
});

test('freshness windows match the approved policy', () => {
  assert.deepEqual(config.freshness_hours, {
    pre_gate: 72,
    tools: 48,
    models: 48,
    security: 72,
    business: 72,
    education: 72,
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
  assert.equal(config.offers.allow_no_expiry, true);
  assert.ok(config.offers.no_expiry_window_days >= 7);
  assert.ok(config.offers.no_expiry_per_vendor_days >= 7);
  assert.ok(config.offers.no_expiry_recheck_hours > 0);
  assert.match(config.offers.no_expiry_note, /بدون تاریخ انقضا/u);
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

test('the Google models feed is registered as an AI-only official feed', () => {
  const feed = sources.sources.find((source) => source.id === 'google-models-research');
  assert.ok(feed, 'the Google models feed is missing');
  assert.equal(feed.use, 'feed');
  assert.equal(feed.type, 'official_blog');
  assert.equal(feed.require_ai, true);
  assert.equal(feed.feed_url, 'https://blog.google/innovation-and-ai/models-and-research/rss/');
  assert.deepEqual(feed.categories, ['models']);
});

test('source ids are unique and no directory is left in the news registry', () => {
  assert.equal(new Set(sources.sources.map((source) => source.id)).size, sources.sources.length);
  for (const id of ['perq', 'ai-free', 'free-inference', 'free-llm-api-hub']) {
    assert.ok(!sources.sources.some((source) => source.id === id), `${id} must live in vendors.json`);
  }
  assert.equal(sources.pending_url, undefined);
  assert.equal(sources.vendor_registry, 'vendors.json');
});

test('the vendor registry carries the 55 user sources plus watched additions', () => {
  assert.ok(vendors.vendors.length >= 55);
  assert.equal(new Set(vendors.vendors.map((vendor) => vendor.id)).size, vendors.vendors.length);
  assert.ok(vendors.vendors.some((vendor) => vendor.id === 'nvidia-build'));
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

test('telegram discovery is lead-only, starts today and keeps the filter', () => {
  const telegram = sources.sources.filter((source) => source.type === 'telegram_channel');
  assert.equal(telegram.length, 17);
  assert.deepEqual(
    telegram.map((source) => source.username).sort(),
    [
      'ArchiveTell',
      'MatinSenPaii',
      'Mohammad_zammani',
      'Sajadverse',
      'ai_farshad',
      'aibysadeghi',
      'asrnovin_ir',
      'codecloude',
      'dunijet_ai',
      'marketing_aida',
      'mgh_mobin',
      'miladxtalks',
      'pedramgholizadeh',
      'shayanode',
      'techiin_ir',
      'thenimaonAI',
      'web3nabu',
    ].sort()
  );
  assert.equal(new Set(telegram.map((source) => source.username.toLowerCase())).size, 17);
  for (const source of telegram) {
    assert.equal(source.use, 'lead_only', `${source.id} must be lead_only`);
    assert.equal(source.status, 'verified', `${source.id} must be verified`);
    assert.match(source.url, /^https:\/\/t\.me\//, `${source.id} is not a telegram link`);
    assert.match(source.username, /^[A-Za-z0-9_]+$/, `${source.id} has a bad username`);
    assert.equal(source.feed_url, undefined, `${source.id} must not claim a feed`);
    assert.equal(source.active_from, config.telegram_discovery.active_from, `${source.id} has a different start`);
    assert.ok(Date.parse(source.active_from) > 0, `${source.id} has an invalid start`);
    assert.ok(source.max_posts_per_check > 0, `${source.id} has no cap`);
    assert.ok(source.categories.length > 0, `${source.id} has no category`);
    for (const category of source.categories) {
      assert.ok(MAIN.includes(category), `${source.id} uses a non-main category`);
    }
  }
  assert.equal(config.telegram_discovery.enabled, true);
  assert.equal(config.telegram_discovery.education_review, true);
  assert.equal(config.telegram_discovery.per_channel, 15);
  for (const domain of ['instagram.com', 'youtube.com', 'x.com', 't.me', 'bit.ly']) {
    assert.ok(config.telegram_discovery.deny_domains.includes(domain), `${domain} is not denied`);
  }
  for (const extension of ['.png', '.mp4', '.pdf']) {
    assert.ok(config.telegram_discovery.deny_extensions.includes(extension));
  }
  for (const domain of ['cafebazaar.ir', 'play.google.com', 'apps.apple.com']) {
    assert.ok(config.telegram_discovery.promo_domains.includes(domain), `${domain} is not promo`);
  }
  for (const domain of ['anthropic.com', 'claude.com', 'openai.com']) {
    assert.ok(
      config.telegram_discovery.official_course_domains.includes(domain),
      `${domain} is not an official course domain`
    );
  }
  assert.equal(
    config.telegram_discovery.promo_domains.some((domain) =>
      config.telegram_discovery.official_course_domains.includes(domain)
    ),
    false
  );
});

test('every feed source has a unique verified https feed url', () => {
  const feeds = sources.sources.filter((source) => source.use === 'feed');
  assert.ok(feeds.length >= 17, 'the verified feed roster lost sources');
  for (const source of feeds) {
    assert.match(source.feed_url ?? '', /^https:\/\//, `${source.id} has no feed url`);
    assert.match(source.verified_at ?? '', /^\d{4}-\d{2}-\d{2}$/, `${source.id} has no verification date`);
    assert.equal(source.status === 'proposed', false, `${source.id} is still proposed`);
  }
  const urls = feeds.map((source) => source.feed_url);
  assert.equal(new Set(urls).size, urls.length, 'two feed sources share one address');
});

test('sources without a public feed are reclassified instead of skipped silently', () => {
  for (const source of sources.sources) {
    if (source.use === 'feed') continue;
    assert.equal(source.feed_url, undefined, `${source.id} is not a feed but claims a feed url`);
    if (source.no_feed_reason) assert.ok(source.no_feed_reason.length > 0);
  }
  const reclassified = sources.sources
    .filter((source) => source.no_feed_reason)
    .map((source) => source.id)
    .sort();
  assert.deepEqual(reclassified, [
    'anthropic-news',
    'anthropic-usage-policy',
    'arena',
    'artificial-analysis',
    'artificial-analysis-articles',
    'bleepingcomputer',
    'gamefeel-benchmark',
    'google-news-rss',
    'hf-papers',
    'livebench',
    'meta-ai-blog',
    'msrc',
    'reuters-tech',
    'the-batch',
  ]);
});

test('page sources have a verified index and a known parser', () => {
  const pages = sources.sources.filter((source) => source.use === 'page');
  assert.deepEqual(pages.map((source) => source.id).sort(), ['artificial-analysis-articles']);
  for (const source of pages) {
    assert.match(source.index_url ?? '', /^https:\/\//, `${source.id} has no index url`);
    assert.ok(['aa_articles'].includes(source.parser), `${source.id} has an unknown parser`);
    assert.equal(source.status, 'verified', `${source.id} is not verified`);
    assert.match(source.verified_at ?? '', /^\d{4}-\d{2}-\d{2}$/, `${source.id} has no verification date`);
    assert.ok(source.categories.includes('models'), `${source.id} is not a models source`);
  }
});

test('api sources have a verified endpoint and a strict paper filter', () => {
  const apis = sources.sources.filter((source) => source.use === 'api' && source.api_url);
  assert.deepEqual(apis.map((source) => source.id).sort(), ['hf-papers']);
  for (const source of apis) {
    assert.match(source.api_url ?? '', /^https:\/\//, `${source.id} has no api url`);
    assert.equal(source.status, 'verified', `${source.id} is not verified`);
    assert.match(source.verified_at ?? '', /^\d{4}-\d{2}-\d{2}$/, `${source.id} has no verification date`);
    assert.ok(source.categories.includes('models'), `${source.id} is not a models source`);
  }
  assert.equal(config.hf_papers.enabled, true);
  assert.ok(config.hf_papers.min_comments >= 3, 'the firehose bar is too low');
  assert.ok(config.hf_papers.notable_min_comments < config.hf_papers.min_comments);
  assert.ok(config.hf_papers.max_candidates >= 1 && config.hf_papers.max_candidates <= 2);
  for (const name of ['openai', 'anthropic', 'google', 'nvidia', 'tencent', 'qwen', 'deepseek']) {
    assert.ok(config.hf_papers.notable_organizations.includes(name), `${name} is missing`);
  }
});

test('the gamefeel benchmark is a verified models source with feed and data endpoints', () => {
  const benchmarks = sources.sources.filter((source) => source.use === 'benchmark');
  assert.deepEqual(benchmarks.map((source) => source.id), ['gamefeel-benchmark']);
  for (const source of benchmarks) {
    assert.equal(source.status, 'verified', `${source.id} is not verified`);
    assert.match(source.verified_at ?? '', /^\d{4}-\d{2}-\d{2}$/, `${source.id} has no verification date`);
    assert.match(source.commits_url ?? '', /^https:\/\//, `${source.id} has no commit feed`);
    assert.match(source.data_url ?? '', /^https:\/\//, `${source.id} has no score data`);
    assert.ok(source.categories.includes('models'), `${source.id} is not a models source`);
    assert.equal(source.feed_url, undefined);
  }
});

test('the remaining proposed sources are recorded as proposed, not verified', () => {
  const proposed = sources.sources
    .filter((source) => source.status === 'proposed')
    .map((source) => source.id)
    .sort();
  assert.deepEqual(proposed, ['bleepingcomputer', 'gdelt', 'wsj']);
});

test('the policy source watches the official news, legal text and country list', () => {
  const policies = sources.sources.filter((source) => source.use === 'policy');
  assert.deepEqual(policies.map((source) => source.id), ['anthropic-usage-policy']);
  const [policy] = policies;
  assert.equal(policy.status, 'verified');
  assert.match(policy.verified_at ?? '', /^\d{4}-\d{2}-\d{2}$/, 'the policy source has no verification date');
  assert.ok(policy.categories.includes('business'), 'the policy source is not a business source');
  assert.equal(policy.feed_url, undefined);
  assert.deepEqual(
    policy.watch_urls.map((entry) => entry.parser),
    ['policy', 'article', 'countries']
  );
  for (const entry of policy.watch_urls) {
    assert.match(entry.url ?? '', /^https:\/\//, 'a watched policy page has no https url');
    assert.ok(entry.label_fa, 'a watched policy page has no Persian label');
  }
  assert.equal(config.policy_watch.enabled, true);
  assert.ok(config.policy_watch.reminder_days >= 1);
  assert.match(
    config.policy_watch.state_path ?? '',
    /^data\/policy-state\.json$/,
    'the policy state lives outside the daily state lanes'
  );
  assert.match(workflow, /data\/policy-state\.json/, 'the workflow does not commit the policy state');
});
