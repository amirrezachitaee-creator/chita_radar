import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLeadPolicy,
  ensureSourceLine,
  fitCaption,
  imageVerdict,
  normalizePostFields,
  qaPost,
  clampText,
  buildUserMessage,
  buildQaRepairMessage,
  callModel,
  callWithRetry,
} from './engine.mjs';

test('an over-limit image caption drops the quote before the image', () => {
  const body = 'م'.repeat(850);
  const date = '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵';
  const base = {
    decision: 'publish',
    title: 'عنوان',
    body,
    quote: 'ط'.repeat(100),
    image_url: 'https://example.com/a.jpg',
  };
  const withQuote = fitCaption(base, date);
  assert.equal(withQuote.quote, '');
  assert.equal(withQuote.image_url, base.image_url);
  const withoutImage = fitCaption({ ...base, quote: '' }, `${date} ${'x'.repeat(80)}`);
  assert.equal(withoutImage.image_url, '');
});

test('image policy rejects logos and stock files even with underscore names', () => {
  assert.equal(imageVerdict('https://example.com/goldman_sachs_logo.png').ok, false);
  assert.equal(imageVerdict('https://example.com/stock-photo.jpg').ok, false);
  assert.equal(imageVerdict('https://example.com/assets/banner_2026.webp').ok, false);
  assert.equal(imageVerdict('https://example.com/2026/11/goldman-sachs-office.jpg').ok, true);
});

test('the old why label is rewritten into a natural sentence', () => {
  const normalized = normalizePostFields({
    title: 'خبر',
    body: 'لید خبر.\n\nچرا مهمه: این تصمیم هزینه تیم‌ها را کم می‌کند.\n\nمنبع: [منبع](https://example.com)',
  });
  assert.ok(normalized.body.includes('اهمیتش اینه که این تصمیم هزینه تیم‌ها را کم می‌کند.'));
  assert.equal(normalized.body.includes('چرا مهمه:'), false);
});

test('an official course lead is always routed to tools', () => {
  const parsed = { decision: 'publish', category: 'education' };
  assert.equal(applyLeadPolicy(parsed, { officialCourse: true }).category, 'tools');
  assert.equal(applyLeadPolicy(parsed, {}).category, 'education');
  assert.equal(
    applyLeadPolicy({ decision: 'skip', category: 'education' }, { officialCourse: true }).category,
    'education'
  );
  assert.equal(
    applyLeadPolicy({ decision: 'publish', category: 'models' }, { officialCourse: true }).category,
    'tools'
  );
});

test('quote is trimmed and kept as a separate field', () => {
  const normalized = normalizePostFields({ title: 'خبر', body: 'متن', quote: '  جزئیات بیشتر  ' });
  assert.equal(normalized.quote, 'جزئیات بیشتر');
});

test('translated tech terms are rewritten deterministically', () => {
  const normalized = normalizePostFields({
    title: 'عامل‌های هوشمند در شهرها',
    body: 'این عامل‌ها با مدل متن‌باز کار می‌کنند و هر عامل هوشمند یک وظیفه دارد.\n\nعامل اصلی رشد همین است.',
    quote: 'یک عامل دیگر هم هست.',
  });
  assert.equal(normalized.title, 'ایجنت‌های هوشمند در شهرها');
  assert.ok(normalized.body.includes('ایجنت‌ها با مدل اوپن سورس'));
  assert.ok(normalized.body.includes('هر ایجنت هوشمند'));
  assert.ok(normalized.body.includes('عامل اصلی رشد همین است.'));
  assert.equal(normalized.quote, 'یک عامل دیگر هم هست.');
});

test('repeating the previous importance opener is only a soft warning', () => {
  const base = {
    decision: 'publish',
    category: 'business',
    post_type: 'standard',
    importance: 4,
    title: 'خبر کوتاه',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: 'https://example.com',
    image_url: '',
    dedupe_key: 'test-why-repeat',
  };
  const context = {
    url: 'https://example.com',
    host: 'example.com',
    sourceType: 'news',
    category: 'business',
    imageUrl: '',
    title: 'خبر کوتاه',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
    previousWhy: 'این موضوع از اونجایی مهمه که هزینه‌ها روی عرضه اولیه فشار میاره.',
  };
  const repeated = qaPost({
    ...base,
    body: 'لید خبر.\n\nاین موضوع از اونجایی مهمه که هزینه‌ها روی عرضه اولیه فشار میاره.\n\nمنبع: [منبع](https://example.com)',
  }, context);
  assert.ok(repeated.warnings.includes('why_repeat'));
  const varied = qaPost({
    ...base,
    body: 'لید خبر.\n\nاهمیتش اینه که هزینه‌ها روی عرضه اولیه فشار میاره.\n\nمنبع: [منبع](https://example.com)',
  }, context);
  assert.equal(varied.warnings.includes('why_repeat'), false);
  const implicit = qaPost({
    ...base,
    body: 'لید خبر.\n\nبا این کار، تیم‌های کوچک هم می‌تونن مدل سنگین رو اجرا کنن.\n\nمنبع: [منبع](https://example.com)',
  }, { ...context, previousWhy: '' });
  assert.equal(implicit.problems.includes('why'), false);
});

test('a missing source line is appended and source QA checks the last line', () => {
  const body = 'لید خبر.\n\nهوش منبعی کمیاب است.\n\nاهمیتش اینه که دسترسی برای همه مهمه.';
  const fixed = ensureSourceLine(
    { decision: 'publish', body },
    { sourceName: 'The Decoder', sourceUrl: 'https://example.com/a' }
  );
  assert.ok(fixed.body.endsWith('منبع: [The Decoder](https://example.com/a)'));
  const already = ensureSourceLine(
    { decision: 'publish', body: `${body}\n\nمنبع: [The Decoder](https://example.com/a)` },
    { sourceName: 'The Decoder', sourceUrl: 'https://example.com/a' }
  );
  assert.ok(already.body.endsWith('منبع: [The Decoder](https://example.com/a)'));
  assert.equal(already.body.match(/https:\/\/example\.com\/a/g).length, 1);

  const base = {
    decision: 'publish',
    category: 'business',
    post_type: 'standard',
    importance: 4,
    title: 'خبر کوتاه',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: 'https://example.com/a',
    image_url: '',
    dedupe_key: 'test-source-line',
  };
  const context = {
    url: 'https://example.com/a',
    host: 'example.com',
    sourceType: 'news',
    category: 'business',
    imageUrl: '',
    title: 'خبر کوتاه',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
    previousWhy: '',
  };
  const missing = qaPost({ ...base, body }, context);
  assert.equal(missing.checks.find((check) => check.name === 'source').ok, false);
  const present = qaPost({ ...base, body: `${body}\n\nمنبع: [The Decoder](https://example.com/a)` }, context);
  assert.equal(present.checks.find((check) => check.name === 'source').ok, true);
});

test('clampText cuts long input at a word boundary for small-context writers', () => {
  const text = 'یک دو سه چهار پنج شش هفت هشت';
  const out = clampText(text, 15);
  assert.ok(out.endsWith(' …'));
  assert.ok(out.length <= 15);
  assert.equal(out.includes('پنج شش'), false);
  assert.equal(clampText('کوتاه', 100), 'کوتاه');
  assert.equal(clampText('هر چه', 0), 'هر چه');
});

test('an official course input carries the news policy to the writer', () => {
  const article = { title: 'Claude Academy', published: '2026-11-03', content: 'دوره رسمی', imageAlt: '' };
  const story = {
    item: { title: 'Claude Academy', published: '2026-11-03' },
    article,
    url: 'https://www.anthropic.com/learn/claude',
    now: '2026-11-03',
  };
  const withCourse = buildUserMessage({ ...story, officialCourse: true });
  const withoutCourse = buildUserMessage(story);
  assert.ok(withCourse.includes('دوره رسمی از خود شرکت'));
  assert.ok(withCourse.includes('reason_code promo'));
  assert.equal(withoutCourse.includes('دوره رسمی از خود شرکت'), false);
});

test('buildUserMessage can clamp the article for the emergency writer', () => {
  const article = { title: 'عنوان', published: '2026-11-03', content: 'الف '.repeat(2000), imageAlt: '' };
  const story = { item: { title: 'عنوان', published: '2026-11-03' }, article, url: 'https://example.com/a', now: '2026-11-03' };
  const full = buildUserMessage(story);
  const trimmed = buildUserMessage({ ...story, maxContentChars: 1200 });
  assert.ok(full.includes(article.content));
  assert.equal(trimmed.includes(article.content), false);
  assert.ok(trimmed.length < full.length);
  assert.ok(trimmed.includes('…'));
});

test('callModel sends reasoning_effort only when requested', async () => {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  };
  try {
    await callModel({ base: 'https://api.example.com/v1', apiKey: 'k', model: 'm', system: 's', user: 'u' });
    await callModel({
      base: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      system: 's',
      user: 'u',
      reasoningEffort: 'low',
      maxTokens: 1800,
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal('reasoning_effort' in bodies[0], false);
  assert.equal(bodies[1].reasoning_effort, 'low');
  assert.equal(bodies[1].max_tokens, 1800);
});

test('callWithRetry stops at once on an auth error so the fallback can start', async () => {
  let hits = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    hits += 1;
    return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  };
  try {
    const result = await callWithRetry(
      { base: 'https://api.example.com/v1', apiKey: 'k', model: 'm', system: 's', user: 'u' },
      4
    );
    assert.equal(result.status, 401);
    assert.equal(result.attempts, 1);
    assert.equal(hits, 1);
  } finally {
    globalThis.fetch = original;
  }
});

const repairPost = {
  decision: 'publish',
  category: 'models',
  post_type: 'standard',
  importance: 3,
  quote: '',
  key_facts: ['یک', 'دو'],
  numbers: [],
  entities: { companies: [], models: [] },
  verification: 'reported',
  source_url: 'https://example.com',
  image_url: '',
  dedupe_key: 'repair-length-test',
  title: 'تیتر خبر',
};

test('the repair message asks to expand a body that is too short', () => {
  const message = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, body: 'ا'.repeat(300) },
    qa: { problems: ['length'], warnings: [] },
  });
  assert.match(message, /حداقل 360 کاراکتر/);
  assert.match(message, /گسترش/);
  assert.doesNotMatch(message, /فقط title و body را کوتاه کن/);
});

test('the repair message still asks to shorten a body that is too long', () => {
  const message = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, body: 'ا'.repeat(1100) },
    qa: { problems: ['length'], warnings: [] },
  });
  assert.match(message, /حداکثر 990 کاراکتر/);
  assert.match(message, /کوتاه/);
});

test('the repair message keeps an existing quote inside the post', () => {
  const message = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, image_url: 'https://example.com/a.jpg', body: 'ا'.repeat(500), quote: 'جزئیات بیشتر' },
    qa: { problems: ['caption'], warnings: [] },
    imageUrl: 'https://example.com/a.jpg',
  });
  assert.match(message, /داخل همین پیام/);
  assert.doesNotMatch(message, /بولت و quote را خالی بگذار/);
});

test('a tools use case counts as the importance and a missing why never blocks the post', () => {
  const base = {
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'ابزار تازه برای ایجنت‌ها',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: 'https://example.com/tool',
    image_url: '',
    dedupe_key: 'test-why-tools',
  };
  const context = {
    url: 'https://example.com/tool',
    host: 'example.com',
    sourceType: 'news',
    category: 'tools',
    imageUrl: '',
    title: 'ابزار تازه برای ایجنت‌ها',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
    previousWhy: '',
  };
  const tools = qaPost(
    { ...base, body: 'لید خبر.\n\nبرای اجراش به یک سرور ساده نیاز دارید.\n\nمنبع: [منبع](https://example.com/tool)' },
    context
  );
  assert.equal(tools.problems.includes('why'), false);
  assert.equal(tools.warnings.includes('why'), false);
  assert.equal(tools.checks.find((check) => check.name === 'why').hard, false);

  const business = qaPost(
    {
      ...base,
      category: 'business',
      body: 'لید خبر.\n\nاین ابزار روی یک سرور معمولی اجرا می‌شه.\n\nمنبع: [منبع](https://example.com/tool)',
    },
    { ...context, category: 'business' }
  );
  assert.equal(business.problems.includes('why'), false);
  assert.equal(business.warnings.includes('why'), true);
});

test('a body with no blank-line paragraph breaks is rejected', () => {
  const parsed = {
    decision: 'publish',
    category: 'business',
    post_type: 'standard',
    importance: 4,
    title: 'خبر کوتاه',
    body: 'لید خبر و جزئیات.\nاهمیتش اینه که هزینه‌ها کم می‌شه.\n\nمنبع: [منبع](https://example.com)',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: 'https://example.com',
    image_url: '',
    dedupe_key: 'test-paragraphs',
  };
  const qa = qaPost(parsed, {
    url: 'https://example.com',
    host: 'example.com',
    sourceType: 'news',
    category: 'business',
    imageUrl: '',
    title: 'خبر کوتاه',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
  });
  assert.ok(qa.problems.includes('body_paragraphs'));
});

test('a post containing Chinese characters fails QA', () => {
  const parsed = {
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'ابزار تازه',
    body: 'لید خبر و جزئیات.\n\nاهمیتش اینه که کار ساده‌تر می‌شه.\n\nمنبع: [منبع](https://example.com)',
    quote: 'حساب提供商 خود را وصل کنید.',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: 'https://example.com',
    image_url: '',
    dedupe_key: 'test-script',
  };
  const qa = qaPost(parsed, {
    url: 'https://example.com',
    host: 'example.com',
    sourceType: 'news',
    category: 'tools',
    imageUrl: '',
    title: 'ابزار تازه',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
  });
  assert.ok(qa.problems.includes('script_clean'));
});
