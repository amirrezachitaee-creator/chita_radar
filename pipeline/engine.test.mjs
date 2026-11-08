import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLeadPolicy,
  applyMechanicalFixes,
  countTitleWords,
  ensureSourceLine,
  ensureOpenEndedNote,
  ensurePolicyIranNote,
  fitImageCaption,
  imageVerdict,
  isFalseStaleSkip,
  normalizePostFields,
  qaPost,
  trimBody,
  trimQuote,
  trimTitle,
  TITLE_MAX_WORDS,
  clampText,
  buildUserMessage,
  buildQaRepairMessage,
  buildTitleRepairMessage,
  TITLE_QA_PROBLEMS,
  callModel,
  callWithRetry,
  extractArticle,
  parseFeed,
  pickToolUsageLink,
} from './engine.mjs';

test('an over-limit image caption is shortened without dropping the image or the quote', () => {
  const date = '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵';
  const base = {
    decision: 'publish',
    title: 'عنوان',
    body: 'م'.repeat(700),
    quote: 'ط'.repeat(500),
    image_url: 'https://example.com/a.jpg',
  };
  const fitted = fitImageCaption(base, date);
  assert.equal(fitted.image_url, base.image_url);
  assert.ok(fitted.quote.length > 0);
  assert.ok(fitted.quote.length < base.quote.length);
  const visible = (value) =>
    [value.title, date, value.body, value.quote].filter(Boolean).join('\n\n').length;
  assert.ok(visible(fitted) <= 900);

  const bodyHeavy = fitImageCaption(
    { ...base, body: 'م'.repeat(950), quote: '' },
    date
  );
  assert.equal(bodyHeavy.image_url, base.image_url);
  assert.ok(bodyHeavy.body.length < 950);
});

test('a long middle paragraph moves into the telegram quote and the image survives', () => {
  const lead = `لید خبر. ${'الف '.repeat(100).trim()}`;
  const middle = `جزئیات تکمیلی. ${'ب '.repeat(120).trim()}`;
  const importance = 'اهمیتش اینه که کار تیم‌ها ساده‌تر می‌شه.';
  const parsed = {
    decision: 'publish',
    category: 'models',
    post_type: 'standard',
    importance: 4,
    title: 'خبر تازه',
    body: [lead, middle, importance].join('\n\n'),
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [] },
    verification: 'reported',
    source_url: 'https://example.com/a',
    image_url: 'https://example.com/a.jpg',
    dedupe_key: 'test-detail-quote',
  };
  const fixed = applyMechanicalFixes(parsed, {
    sourceName: 'منبع',
    sourceUrl: 'https://example.com/a',
    imageUrl: 'https://example.com/a.jpg',
    newsDate: '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵',
  });
  assert.ok(fixed.quote.includes('جزئیات تکمیلی'));
  assert.ok(fixed.body.startsWith('لید خبر'));
  assert.ok(fixed.body.includes(importance));
  assert.equal(fixed.body.includes('جزئیات تکمیلی'), false);
  assert.equal(fixed.image_url, 'https://example.com/a.jpg');
  assert.equal(fixed.post_type, 'standard');
  assert.ok(fixed.body.endsWith('منبع: [منبع](https://example.com/a)'));
});

test('an open-ended offer post carries the no-expiry note and drops invented dates', () => {
  const note = 'بدون تاریخ انقضای اعلام‌شده؛ پیش از اقدام، صفحهٔ رسمی را ببینید';
  const parsed = {
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'دسترسی رایگان به سه مدل',
    body: [
      'انویدیا دسترسی رایگان به سه مدل تازه را برای توسعه‌دهنده‌ها باز کرده.',
      'این آفر تا ۳۰ آذر ۱۴۰۵ معتبر است.',
      'اهمیتش اینه که تست مدل‌ها بدون هزینه شروع می‌شه.',
      '',
      'منبع: [NVIDIA](https://build.nvidia.com/)',
    ].join('\n\n'),
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: ['NVIDIA'], models: [] },
    verification: 'official',
    source_url: 'https://build.nvidia.com/',
    image_url: '',
    dedupe_key: 'test-open-ended',
  };
  const fixed = applyMechanicalFixes(parsed, {
    sourceName: 'NVIDIA',
    sourceUrl: 'https://build.nvidia.com/',
    openEnded: true,
    noExpiryNote: note,
  });
  assert.ok(fixed.body.includes(note));
  assert.equal(fixed.body.includes('۳۰ آذر'), false);
  assert.ok(fixed.body.endsWith('منبع: [NVIDIA](https://build.nvidia.com/)'));

  const direct = ensureOpenEndedNote({
    decision: 'publish',
    body: `متن آفر.\n\n${note}\n\nمنبع: [NVIDIA](https://build.nvidia.com/)`,
  }, note);
  assert.equal(direct.body, `متن آفر.\n\n${note}\n\nمنبع: [NVIDIA](https://build.nvidia.com/)`);
});

test('open-ended offer QA accepts the note together with a resolved official page', () => {
  const note = 'بدون تاریخ انقضای اعلام‌شده؛ پیش از اقدام، صفحهٔ رسمی را ببینید';
  const body = [
    'انویدیا دسترسی رایگان به سه مدل تازه را برای توسعه‌دهنده‌ها باز کرده و کار با آن‌ها بدون کارت بانکی شروع می‌شه.',
    note,
    'اهمیتش اینه که تیم‌های کوچک بدون هزینه اولیه می‌تونن مدل‌ها را تست کنند و انتخاب سریع‌تری داشته باشند.',
    '',
    'منبع: [NVIDIA Build](https://build.nvidia.com/)',
  ].join('\n\n');
  const qa = qaPost({
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'دسترسی رایگان به سه مدل',
    body,
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: ['NVIDIA'], models: [] },
    verification: 'official',
    source_url: 'https://build.nvidia.com/',
    image_url: '',
    dedupe_key: 'open-ended-qa',
  }, {
    url: 'https://build.nvidia.com/',
    host: 'build.nvidia.com',
    sourceType: 'telegram_channel',
    category: 'tools',
    imageUrl: '',
    title: 'NVIDIA Build free access',
    description: '',
    content: 'free access to three models without a bank card',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
    offer: {
      detected: true,
      openEnded: true,
      note,
      date: '',
      remainingHours: null,
      expiry: { ok: false, reason: 'expiry_missing' },
      minRemainingHours: 24,
    },
    officialResolved: true,
    previousWhy: '',
  });
  const check = (name) => qa.checks.find((item) => item.name === name);
  assert.equal(check('offer_expiry').ok, true);
  assert.equal(check('offer_remaining').ok, true);
  assert.equal(check('offer_source').ok, true);
});

test('an allowed image is mandatory and deep becomes standard', () => {
  const parsed = {
    decision: 'publish',
    category: 'tools',
    post_type: 'deep',
    importance: 4,
    title: 'ابزار تازه',
    body: 'لید خبر.\n\nاهمیتش اینه که کار ساده‌تر می‌شه.',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [] },
    verification: 'reported',
    source_url: 'https://example.com/tool',
    image_url: '',
    dedupe_key: 'test-image-mandatory',
  };
  const fixed = applyMechanicalFixes(parsed, {
    sourceName: 'منبع',
    sourceUrl: 'https://example.com/tool',
    imageUrl: 'https://example.com/tool.jpg',
    newsDate: '📅 تاریخ خبر: سه‌شنبه ۱۲ آبان ۱۴۰۵',
  });
  assert.equal(fixed.image_url, 'https://example.com/tool.jpg');
  assert.equal(fixed.post_type, 'standard');

  const qa = qaPost(
    { ...fixed, image_url: '', body: `${fixed.body}` },
    {
      url: 'https://example.com/tool',
      host: 'example.com',
      sourceType: 'news',
      category: 'tools',
      imageUrl: 'https://example.com/tool.jpg',
      title: 'ابزار تازه',
      description: '',
      content: '',
      publishedAt: new Date().toISOString(),
      now: new Date().toISOString(),
      previousWhy: '',
    }
  );
  assert.ok(qa.problems.includes('image_used'));
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

test('the patch term keeps its transliteration instead of the literal word', () => {
  const normalized = normalizePostFields({
    title: 'یک وصله کوچک برای خلاصه هوشمند',
    body: 'این پچ فقط تکرار خط‌ها را رفع می‌کند. سرویس ابری روز ۵ نوامبر وصله شده و دو وصله امنیتی دیگر هم منتشر شد.\n\nاین وصله‌ها فقط برای نسخه دسکتاپ هستند.',
    quote: 'این پچ امنیتی هنوز منتشر نشده.',
  });
  assert.equal(normalized.title, 'یک پچ کوچک برای خلاصه هوشمند');
  assert.ok(normalized.body.includes('این پچ فقط تکرار'));
  assert.ok(normalized.body.includes('روز ۵ نوامبر پچ شده'));
  assert.ok(normalized.body.includes('دو پچ امنیتی دیگر'));
  assert.ok(normalized.body.includes('این پچ‌ها فقط'));
  assert.equal(normalized.quote, 'این پچ امنیتی هنوز منتشر نشده.');
  assert.ok(!/وصله/u.test(`${normalized.title}\n${normalized.body}\n${normalized.quote}`));
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

const titleBase = {
  decision: 'publish',
  category: 'business',
  post_type: 'standard',
  importance: 4,
  quote: '',
  key_facts: ['یک', 'دو'],
  numbers: [],
  entities: { companies: [], models: [], people: [] },
  verification: 'reported',
  source_url: 'https://example.com',
  image_url: '',
  dedupe_key: 'title-qa-test',
  body: 'لید خبر.\n\nاهمیتش اینه که کاربرها سریع‌تر به نتیجه می‌رسن.\n\nمنبع: [منبع](https://example.com)',
};

const titleContext = {
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
  previousWhy: '',
};

test('a question-shaped or dangling title is rejected', () => {
  const bad = qaPost(
    { ...titleBase, title: 'آیا شبیه‌سازهای هوش مصنوعی، پورت رسمی GTA VI را جلو' },
    titleContext
  );
  assert.ok(bad.problems.includes('title_complete'));
  const good = qaPost(
    { ...titleBase, title: 'شبیه‌سازهای هوش مصنوعی پورت رسمی GTA VI را جلو می‌اندازند' },
    titleContext
  );
  assert.equal(good.problems.includes('title_complete'), false);
});

test('an untranslated English word in a Persian title is rejected', () => {
  const bad = qaPost(
    { ...titleBase, title: 'متا برنامه تغییر قوانین تجاری را indefinitely معلق کرد' },
    titleContext
  );
  assert.ok(bad.problems.includes('title_latin'));
  const good = qaPost(
    { ...titleBase, title: 'مدل Qwen 4 Flash در صدر بنچمارک تازه ایستاد' },
    titleContext
  );
  assert.equal(good.problems.includes('title_latin'), false);
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

test('a tools post ends with the usage link and falls back to the source line', () => {
  const source = { sourceName: 'Google Blog', sourceUrl: 'https://blog.google/a' };
  const body = 'لید خبر.\n\nابزار چه ویژگی‌هایی دارد.\n\nاهمیتش اینه که کار کاربر ساده‌تر می‌شه.\n\nمنبع: [Google Blog](https://blog.google/a)';
  const fixed = ensureSourceLine(
    { decision: 'publish', category: 'tools', body },
    { ...source, usageUrl: 'https://gemini.google.com/', usageName: 'gemini.google.com' }
  );
  assert.ok(fixed.body.endsWith('لینک استفاده: [gemini.google.com](https://gemini.google.com/)'));
  assert.ok(!fixed.body.includes('منبع:'));

  const again = ensureSourceLine(
    fixed,
    { ...source, usageUrl: 'https://gemini.google.com/', usageName: 'gemini.google.com' }
  );
  assert.equal(again.body, fixed.body);

  const noUsage = ensureSourceLine(
    { decision: 'publish', category: 'tools', body },
    source
  );
  assert.ok(noUsage.body.endsWith('منبع: [Google Blog](https://blog.google/a)'));

  const otherCategory = ensureSourceLine(
    { decision: 'publish', category: 'models', body },
    { ...source, usageUrl: 'https://gemini.google.com/' }
  );
  assert.ok(otherCategory.body.endsWith('منبع: [Google Blog](https://blog.google/a)'));
});

test('a tool page yields a grounded usage link and ignores nav and news paths', () => {
  const article = {
    title: 'Gemini 3 developer release',
    links: [
      { url: 'https://ai.google.dev/gemini-api/docs', text: 'documentation', inBody: true },
      { url: 'https://www.theverge.com/2026/11/7/gemini-3', text: 'The Verge', inBody: true },
      { url: 'https://blog.google/about/', text: 'About', inBody: false },
    ],
  };
  const picked = pickToolUsageLink({
    article,
    sourceUrl: 'https://blog.google/technology/ai/gemini-3/',
    sourceType: 'news',
  });
  assert.equal(picked.url, 'https://ai.google.dev/gemini-api/docs');
  assert.equal(picked.name, 'ai.google.dev');

  const repo = pickToolUsageLink({
    article: {
      title: 'Gemini CLI is now open source',
      links: [
        { url: 'https://github.com/google-gemini/gemini-cli', text: 'github.com/google-gemini/gemini-cli', inBody: true },
        { url: 'https://x.com/Google', text: 'X', inBody: false },
      ],
    },
    sourceUrl: 'https://blog.google/technology/ai/gemini-cli/',
    sourceType: 'news',
  });
  assert.equal(repo.url, 'https://github.com/google-gemini/gemini-cli');
  assert.equal(repo.name, 'google-gemini/gemini-cli');

  const openSource = pickToolUsageLink({
    article: {
      title: 'ToyBlocks robot learning framework',
      links: [
        { url: 'https://huggingface.co/datasets/allenai/toyblocks-data', text: 'Data', inBody: true },
        { url: 'https://github.com/allenai/ToyBlocks', text: 'ToyBlocks', inBody: true },
      ],
    },
    sourceUrl: 'https://huggingface.co/blog/allenai/toyblocks',
    sourceType: 'official_blog',
  });
  assert.equal(openSource.url, 'https://github.com/allenai/ToyBlocks');

  const modelCard = pickToolUsageLink({
    article: {
      title: 'NVIDIA Cosmos 3 open models',
      links: [
        { url: 'https://huggingface.co/collections/nvidia/cosmos3', text: 'Cosmos 3', inBody: true },
        { url: 'https://huggingface.co/nvidia/Cosmos3-Nano-Transfer-Auto', text: 'Cosmos3-Nano-Transfer-Auto', inBody: true },
      ],
    },
    sourceUrl: 'https://huggingface.co/blog/nvidia/cosmos-interactive-world-simulation',
    sourceType: 'official_blog',
  });
  assert.equal(modelCard.url, 'https://huggingface.co/nvidia/Cosmos3-Nano-Transfer-Auto');
});

test('a hosted tool home beats an unrelated repo unless the story is open source', () => {
  const link = (url, text) => ({ url, text, inBody: true });
  const hosted = pickToolUsageLink({
    article: {
      title: 'Gemini 3 launches for everyone',
      links: [
        link('https://github.com/someone/random-agent', 'GitHub'),
        link('https://gemini.google.com/', 'Try Gemini'),
      ],
    },
    sourceUrl: 'https://blog.google/technology/ai/gemini-3/',
    sourceType: 'news',
  });
  assert.equal(hosted.url, 'https://gemini.google.com/');

  const openSource = pickToolUsageLink({
    article: {
      title: 'Gemini CLI is now open source',
      links: [
        link('https://gemini.google.com/', 'Try Gemini'),
        link('https://github.com/google-gemini/gemini-cli', 'gemini-cli'),
      ],
    },
    sourceUrl: 'https://blog.google/technology/ai/gemini-cli/',
    sourceType: 'news',
  });
  assert.equal(openSource.url, 'https://github.com/google-gemini/gemini-cli');
});

test('a tool home or repo source doubles as the usage link and offers are excluded', () => {
  const home = pickToolUsageLink({
    article: { title: 'ChatGPT update', links: [] },
    sourceUrl: 'https://chatgpt.com/',
    sourceType: 'repo',
  });
  assert.equal(home.url, 'https://chatgpt.com/');
  assert.equal(home.score, 100);

  const repo = pickToolUsageLink({
    article: { title: 'Whisper', links: [] },
    sourceUrl: 'https://github.com/openai/whisper',
    sourceType: 'repo',
  });
  assert.equal(repo.url, 'https://github.com/openai/whisper');

  const modelPage = pickToolUsageLink({
    article: { title: 'ToyBlocks', links: [] },
    sourceUrl: 'https://huggingface.co/allenai/ToyBlocks',
    sourceType: 'repo',
  });
  assert.equal(modelPage.url, 'https://huggingface.co/allenai/ToyBlocks');

  const providerBlog = pickToolUsageLink({
    article: { title: 'Perplexity launches a new agent', links: [] },
    sourceUrl: 'https://www.perplexity.ai/hub/blog/teammates-are-agents',
    sourceType: 'official_blog',
  });
  assert.equal(providerBlog, null);

  const blogSource = pickToolUsageLink({
    article: { title: 'ToyBlocks', links: [] },
    sourceUrl: 'https://huggingface.co/blog/allenai/toyblocks',
    sourceType: 'official_blog',
  });
  assert.equal(blogSource, null);

  const offer = pickToolUsageLink({
    article: { title: 'Free tokens', links: [] },
    sourceUrl: 'https://github.com/acme/tool',
    sourceType: 'telegram',
    offer: true,
  });
  assert.equal(offer, null);

  const course = pickToolUsageLink({
    article: { title: 'Official course', links: [] },
    sourceUrl: 'https://chatgpt.com/',
    sourceType: 'news',
    officialCourse: true,
  });
  assert.equal(course, null);
});

test('article extraction resolves relative links and marks body anchors', () => {
  const html = [
    '<p>See <a href="/docs/quickstart">the quickstart</a>.</p>',
    '<p><a href="https://github.com/acme/tool">acme/tool</a></p>',
    '<a href="/about">About</a>',
  ].join('');
  const article = extractArticle(html, 'Acme Tool', 'https://acme.dev/news/acme-tool');
  assert.ok(article.links.some((link) => link.url === 'https://acme.dev/docs/quickstart' && link.inBody));
  assert.ok(article.links.some((link) => link.url === 'https://github.com/acme/tool' && link.inBody));
  assert.ok(article.links.some((link) => link.url === 'https://acme.dev/about' && !link.inBody));
});

test('QA expects the usage tail on a tools post and rejects invented links', () => {
  const source = 'https://blog.google/a';
  const usage = 'https://gemini.google.com/';
  const base = {
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'ابزار تازه برای نوشتن',
    quote: '',
    key_facts: ['یک', 'دو'],
    numbers: [],
    entities: { companies: [], models: [], people: [] },
    verification: 'reported',
    source_url: source,
    image_url: '',
    dedupe_key: 'test-usage-tail',
  };
  const context = {
    url: source,
    host: 'blog.google',
    sourceType: 'news',
    category: 'tools',
    imageUrl: '',
    title: 'ابزار تازه برای نوشتن',
    description: '',
    content: '',
    publishedAt: new Date().toISOString(),
    now: new Date().toISOString(),
    previousWhy: '',
    links: [usage],
    usageUrl: usage,
  };
  const body = 'لید خبر.\n\nابزار چه ویژگی‌هایی دارد.\n\nاهمیتش اینه که کار کاربر ساده‌تر می‌شه.\n\nلینک استفاده: [gemini.google.com](https://gemini.google.com/)';
  const qa = qaPost({ ...base, body }, context);
  assert.equal(qa.checks.find((check) => check.name === 'source').ok, true);
  assert.equal(qa.checks.find((check) => check.name === 'links_grounded').ok, true);

  const sourceTail = qaPost({ ...base, body: `${body.split('\n\n')[0]}\n\nاهمیتش اینه که کار کاربر ساده‌تر می‌شه.\n\nمنبع: [Google Blog](${source})` }, context);
  assert.equal(sourceTail.checks.find((check) => check.name === 'source').ok, false);

  const invented = qaPost(
    { ...base, body: body.replace(usage, 'https://fake.example/tool') },
    { ...context, usageUrl: '', links: [] }
  );
  assert.equal(invented.checks.find((check) => check.name === 'links_grounded').ok, false);
});

test('trimQuote never cuts a number at its decimal point', () => {
  const value = `امتیاز مدل ۴۹.۹ از ۱۰۰ است ${'و '.repeat(50)}`;
  assert.equal(trimQuote(value, 14), 'امتیاز مدل');
  assert.equal(trimQuote('یک جمله کوتاه. ادامه ادامه', 20), 'یک جمله کوتاه.');
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

test('a benchmark update input carries the models policy to the writer', () => {
  const article = { title: 'Qwen-4-Flash-Early tops The Gamefeel Benchmark', published: '2026-11-07T23:56:28Z', content: 'امتیاز کل 49.9', imageAlt: '' };
  const story = {
    item: { title: 'Qwen-4-Flash-Early tops The Gamefeel Benchmark', published: '2026-11-07T23:56:28Z' },
    article,
    url: 'https://github.com/kodasdream/gamefeel-benchmark/commit/daa3d11',
    now: '2026-11-08',
  };
  const withBench = buildUserMessage({ ...story, benchmark: true });
  const withoutBench = buildUserMessage(story);
  assert.ok(withBench.includes('بنچمارک عمومی و منتشرشدهٔ'));
  assert.ok(withBench.includes('دسته models است'));
  assert.ok(withBench.includes('off_topic'));
  assert.equal(withoutBench.includes('بنچمارک عمومی و منتشرشدهٔ'), false);
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

test('the repair message targets the usage link on a tools post', () => {
  const message = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, category: 'tools', body: 'متن\n\nمنبع: [Hugging Face](https://huggingface.co/blog/a)' },
    qa: { problems: ['source'], warnings: [] },
    usageUrl: 'https://github.com/acme/tool',
  });
  assert.match(message, /خط لینک استفاده/);
  assert.match(message, /https:\/\/github\.com\/acme\/tool/);
  assert.doesNotMatch(message, /خط منبع/);
});

test('the repair message names the incomplete or untranslated title', () => {
  const incomplete = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, title: 'آیا شبیه‌سازهای هوش مصنوعی پورت رسمی GTA VI را جلو' },
    qa: { problems: ['title_complete'], warnings: [] },
  });
  assert.match(incomplete, /title_complete/);
  assert.match(incomplete, /جملهٔ کامل خبری/);

  const latin = buildQaRepairMessage({
    user: '',
    parsed: { ...repairPost, title: 'متا برنامه تغییر قوانین تجاری را indefinitely معلق کرد' },
    qa: { problems: ['title_latin'], warnings: [] },
  });
  assert.match(latin, /indefinitely/);
  assert.match(latin, /معادل فارسی/);
});

test('the focused title repair asks only for a corrected title', () => {
  const message = buildTitleRepairMessage({
    user: 'متن خبر',
    parsed: { ...repairPost, title: 'آیا شبیه‌سازهای هوش مصنوعی پورت رسمی GTA VI را جلو' },
    qa: { problems: ['title_complete', 'length'], warnings: [] },
  });
  assert.match(message, /فقط تیتر را بازنویسی کن/);
  assert.match(message, /آیا شبیه‌سازهای هوش مصنوعی/);
  assert.match(message, /نیمه‌کاره/);
  assert.match(message, /"title"/);
  assert.doesNotMatch(message, /حداقل 360 کاراکتر/);

  const latin = buildTitleRepairMessage({
    user: '',
    parsed: { ...repairPost, title: 'متا برنامه تغییر قوانین تجاری را indefinitely معلق کرد' },
    qa: { problems: ['title_latin'], warnings: [] },
  });
  assert.match(latin, /indefinitely/);
  assert.match(latin, /معادل فارسی/);
  assert.equal(TITLE_QA_PROBLEMS.has('length'), false);
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

test('a long title is trimmed to the shared word limit and cleaned', () => {
  const title = 'یک دو سه چهار پنج شش هفت هشت نه ده یازده دوازده سیزده **';
  const trimmed = trimTitle(title);
  assert.equal(countTitleWords(trimmed), TITLE_MAX_WORDS);
  assert.equal(trimmed.endsWith('.'), false);
  assert.equal(trimmed.includes('**'), false);
  const compound = trimTitle('یک دو سه چهار پنج شش هفت هشت نه ده می‌شود دوازده سیزده');
  assert.ok(countTitleWords(compound) <= TITLE_MAX_WORDS);
});

test('an over-long body is trimmed without losing the source or the importance paragraph', () => {
  const importance = 'اهمیتش اینه که این ابزار زمان تیم را کم می‌کند.';
  const body = [
    `لید خبر. ${'الف '.repeat(120).trim()}`,
    `زمینه. ${'ب '.repeat(120).trim()}`,
    importance,
    'منبع: [منبع](https://example.com/a)',
  ].join('\n\n');
  const trimmed = trimBody(body, 990);
  assert.ok(trimmed.length <= 990);
  assert.ok(trimmed.includes(importance));
  assert.ok(trimmed.includes('منبع: [منبع](https://example.com/a)'));
  assert.ok(trimmed.split(/\n{2,}/).filter(Boolean).length >= 2);
});

test('mechanical fixes repair title, body and quote before QA', () => {
  const importance = 'اهمیتش اینه که کار تیم ساده‌تر می‌شه.';
  const parsed = {
    decision: 'publish',
    post_type: 'standard',
    title: 'یک دو سه چهار پنج شش هفت هشت نه ده یازده دوازده سیزده',
    body: [
      `لید. ${'الف '.repeat(140).trim()}`,
      `زمینه. ${'ب '.repeat(140).trim()}`,
      importance,
    ].join('\n\n'),
    quote: 'ق'.repeat(1300),
    image_url: '',
  };
  const fixed = applyMechanicalFixes(parsed, {
    sourceName: 'منبع',
    sourceUrl: 'https://example.com/a',
  });
  assert.ok(trimTitle(fixed.title).split(/\s+/).filter(Boolean).length <= TITLE_MAX_WORDS);
  assert.ok(fixed.body.length <= 990);
  assert.ok(fixed.body.includes(importance));
  assert.ok(fixed.body.endsWith('منبع: [منبع](https://example.com/a)'));
  assert.ok(fixed.quote.length <= 1200);
});

test('article extraction keeps the original date next to the modified date', () => {
  const article = extractArticle(`<html><head>
    <meta property="og:title" content="Story">
    <meta property="article:published_time" content="2026-10-20T08:00:00Z">
    <meta property="article:modified_time" content="2026-11-05T08:00:00Z">
  </head><body><p>${'متن خبر. '.repeat(40)}</p></body></html>`);
  assert.equal(article.published, '2026-10-20T08:00:00Z');
  assert.equal(article.modified, '2026-11-05T08:00:00Z');

  const structured = extractArticle(`<html><head><script type="application/ld+json">
    {"@type":"NewsArticle","headline":"Structured","datePublished":"2026-10-21T08:00:00Z","dateModified":"2026-11-04T08:00:00Z"}
  </script></head></html>`);
  assert.equal(structured.published, '2026-10-21T08:00:00Z');
  assert.equal(structured.modified, '2026-11-04T08:00:00Z');
});

test('a clocked date wins over a date-only meta tag', () => {
  const article = extractArticle(`<html><head>
    <meta property="og:title" content="Google style">
    <meta property="date" content="2026-11-05">
    <script type="application/ld+json">
      {"@type":"NewsArticle","headline":"Google style","datePublished":"2026-11-05T17:00:00+00:00"}
    </script>
  </head></html>`);
  assert.equal(article.published, '2026-11-05T17:00:00+00:00');

  const dateOnly = extractArticle(`<html><head>
    <meta property="og:title" content="No clock">
    <meta property="date" content="2026-11-05">
  </head></html>`);
  assert.equal(dateOnly.published, '2026-11-05');
});

test('feed parsing keeps published and updated dates apart', () => {
  const [atom] = parseFeed(`<feed><entry>
    <title>Atom story</title>
    <link href="https://example.com/atom"/>
    <published>2026-10-20T08:00:00Z</published>
    <updated>2026-11-05T08:00:00Z</updated>
  </entry></feed>`);
  assert.equal(atom.published, '2026-10-20T08:00:00Z');
  assert.equal(atom.updated, '2026-11-05T08:00:00Z');

  const [onlyUpdated] = parseFeed(`<feed><entry>
    <title>Only updated</title>
    <link href="https://example.com/updated"/>
    <updated>2026-11-05T08:00:00Z</updated>
  </entry></feed>`);
  assert.equal(onlyUpdated.published, '2026-11-05T08:00:00Z');
  assert.equal(onlyUpdated.updated, '2026-11-05T08:00:00Z');
});

test('a fresh item skipped as stale is caught for one corrective retry', () => {
  assert.equal(isFalseStaleSkip({ decision: 'skip', reason_code: 'stale' }, { ok: true, ageHours: 0.4 }), true);
  assert.equal(isFalseStaleSkip({ decision: 'skip', reason_code: 'stale' }, { ok: false, ageHours: 90 }), false);
  assert.equal(isFalseStaleSkip({ decision: 'skip', reason_code: 'duplicate' }, { ok: true }), false);
  assert.equal(isFalseStaleSkip({ decision: 'publish', reason_code: '' }, { ok: true }), false);
  assert.equal(isFalseStaleSkip(null, { ok: true }), false);
  assert.equal(
    isFalseStaleSkip({ decision: 'skip', reason_code: 'stale' }, { ok: true, ageHours: 60 }, 48),
    false
  );
});

test('an official company blog gets the official verification label mechanically', () => {
  const base = {
    decision: 'publish',
    category: 'tools',
    post_type: 'standard',
    importance: 4,
    title: 'ابزار تازه',
    body: 'لید خبر.\n\nاهمیتش اینه که کار ساده‌تر می‌شه.',
    quote: '',
    verification: 'reported',
    dedupe_key: 'official-blog-test',
  };
  const official = applyMechanicalFixes(base, {
    sourceName: 'NVIDIA',
    sourceUrl: 'https://blogs.nvidia.com/blog/x',
    sourceType: 'official_blog',
  });
  assert.equal(official.verification, 'official');
  const news = applyMechanicalFixes(base, {
    sourceName: 'The Decoder',
    sourceUrl: 'https://the-decoder.com/x',
    sourceType: 'news',
  });
  assert.equal(news.verification, 'reported');
  const rumor = applyMechanicalFixes({ ...base, verification: 'rumor' }, { sourceType: 'official_blog' });
  assert.equal(rumor.verification, 'rumor');

  const policy = applyMechanicalFixes(base, {
    sourceName: 'Anthropic',
    sourceUrl: 'https://www.anthropic.com/legal/aup',
    sourceType: 'policy',
  });
  assert.equal(policy.verification, 'official');
});

test('a policy input carries the effective date and the Iran rule to the writer', () => {
  const article = {
    title: 'Updating our Usage Policy',
    published: '2026-10-08T00:00:00Z',
    content: 'The updated policy takes effect on November 12. Our policy prohibits the use of Claude in unsupported regions.',
    imageAlt: '',
  };
  const story = {
    item: { title: 'Updating our Usage Policy', published: '2026-10-08T00:00:00Z' },
    article,
    url: 'https://www.anthropic.com/news/2026-usage-policy-update',
    now: '2026-11-08',
  };
  const withPolicy = buildUserMessage({
    ...story,
    policy: true,
    effectiveDate: '2026-11-12',
    policyIran: true,
  });
  assert.ok(withPolicy.includes('دسته باید business باشد'));
  assert.ok(withPolicy.includes('۲۱ آبان ۱۴۰۵'));
  assert.ok(withPolicy.includes('2026-11-12'));
  assert.ok(withPolicy.includes('ایران در فهرست رسمی کشورهای پشتیبانی‌شده نیست'));
  assert.ok(withPolicy.includes('حذف نکن'));
  assert.ok(withPolicy.includes('برنامهٔ مسدودسازی حساب اعلام نکرده است'));
  assert.ok(withPolicy.includes('نقل‌قول انگلیسی'));

  const withoutPolicy = buildUserMessage(story);
  assert.equal(withoutPolicy.includes('دسته باید business باشد'), false);
  assert.equal(withoutPolicy.includes('ایران در فهرست رسمی'), false);
});

test('the missing Iran fact is added mechanically to the last paragraph', () => {
  const note = 'ایران در فهرست رسمی کشورهای پشتیبانی‌شده نیست و کشورهای فهرست‌نشده پشتیبانی نمی‌شوند.';
  const parsed = {
    decision: 'publish',
    body: 'لید خبر.\n\nاهمیتش اینه که دسترسی شفاف‌تر می‌شه.',
  };
  const fixed = ensurePolicyIranNote(parsed, true);
  assert.ok(fixed.body.startsWith('لید خبر.'));
  assert.ok(fixed.body.includes(`${note} اهمیتش اینه که دسترسی شفاف‌تر می‌شه.`));
  assert.equal(fixed.body.split(/\n{2,}/).length, 2);

  const already = ensurePolicyIranNote(
    { decision: 'publish', body: 'لید.\n\nایران در فهرست کشورهای پشتیبانی‌شده نیست.' },
    true
  );
  assert.equal(already.body, 'لید.\n\nایران در فهرست کشورهای پشتیبانی‌شده نیست.');

  const off = ensurePolicyIranNote(parsed, false);
  assert.equal(off.body, parsed.body);
});

test('mechanical policy fixes keep the Iran fact and the source tail', () => {
  const base = {
    decision: 'publish',
    category: 'business',
    post_type: 'standard',
    importance: 4,
    title: 'سیاست تازهٔ استفاده از سرویس',
    body: [
      'لید خبر دربارهٔ سیاست استفاده از سرویس.',
      'اهمیتش اینه که کاربرها تکلیف دسترسی رو بهتر می‌دونن.',
    ].join('\n\n'),
    quote: '',
    verification: 'reported',
    dedupe_key: 'policy-iran-mechanical',
  };
  const fixed = applyMechanicalFixes(base, {
    sourceName: 'Anthropic',
    sourceUrl: 'https://www.anthropic.com/news/2026-usage-policy-update',
    sourceType: 'policy',
    policyIran: true,
  });
  assert.ok(fixed.body.includes('ایران در فهرست رسمی کشورهای پشتیبانی‌شده نیست'));
  assert.ok(fixed.body.endsWith('منبع: [Anthropic](https://www.anthropic.com/news/2026-usage-policy-update)'));
  assert.ok(fixed.body.length <= 990);
  assert.equal(fixed.verification, 'official');
});
