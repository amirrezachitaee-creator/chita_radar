import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEducationDigest,
  buildEducationMessage,
  buildEducationMessages,
  classifyLead,
  educationDigestLeads,
  educationLeadLabel,
  educationSignals,
  hasPromoText,
  isAllowedLink,
  isEducationLead,
  isOfficialCourse,
  isPromotionalUrl,
  leadTitle,
  matchesPublishedStory,
  parseTelegramChannel,
  selectAnyLink,
  selectLeadLink,
} from './telegram-source.mjs';
import { collectCandidates } from './collect.mjs';
import { emptyState } from './store.mjs';

const NOW = '2026-11-03T15:00:00Z';
const ACTIVE_FROM = '2026-11-03T00:00:00+03:30';

const block = ({ id, datetime, text = '', preview = null, forwarded = false }) => `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message" data-post="testchannel/${id}">
    ${forwarded ? '<div class="tgme_widget_message_forwarded_from"><a href="https://t.me/other">Other</a></div>' : ''}
    <div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>
    ${
      preview
        ? `<a class="tgme_widget_message_link_preview" href="${preview.url}">
            <div class="link_preview_site_name">${preview.site ?? 'Example'}</div>
            <div class="link_preview_title">${preview.title ?? ''}</div>
            <div class="link_preview_description">${preview.description ?? ''}</div>
          </a>`
        : ''
    }
    <div class="tgme_widget_message_footer">
      <a class="tgme_widget_message_date" href="https://t.me/testchannel/${id}">
        <time datetime="${datetime}">time</time>
      </a>
    </div>
  </div>
</div>`;

const page = [
  block({
    id: 101,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      '&rlm;خبر تازه هوش مصنوعی<br/><a href="https://example.com/article?utm_source=tg">جزئیات</a>',
    preview: {
      url: 'https://example.com/article?utm_source=tg',
      title: 'OpenAI ships a new agent model',
      description: 'A short description',
    },
  }),
  block({
    id: 102,
    datetime: '2026-11-03T11:00:00+00:00',
    text: 'عکس جدید <a href="https://www.instagram.com/p/abc">اینستاگرام</a>',
    preview: { url: 'https://www.instagram.com/p/abc', title: 'Instagram post' },
  }),
  block({
    id: 103,
    datetime: '2026-11-03T12:00:00+00:00',
    text: 'یک یادداشت کوتاه بدون لینک',
  }),
  block({
    id: 104,
    datetime: '2026-11-01T10:00:00+00:00',
    text: 'خبر قدیمی <a href="https://example.com/old">old</a>',
    preview: { url: 'https://example.com/old', title: 'Old article' },
  }),
  block({
    id: 105,
    datetime: '2026-11-03T13:00:00+00:00',
    text: 'عامل هوشمند تازه برای ساخت ابزار <a href="https://example.org/allowed">لینک</a>',
    preview: { url: 'https://www.youtube.com/watch?v=1', title: 'Video' },
  }),
  block({
    id: 106,
    datetime: '2026-11-03T13:30:00+00:00',
    forwarded: true,
    text:
      'ایجنت هوش مصنوعی برای کدنویسی <a href="https://github.com/example/repo">repo</a>',
    preview: { url: 'https://github.com/example/repo', title: 'GitHub - example/repo', site: 'GitHub' },
  }),
].join('\n');

const fetchPage = (html, url = 'https://t.me/s/testchannel') => async (target) => {
  assert.equal(target, url);
  return { text: html, url: target };
};

test('parser reads message id, date, text and preview without leaking markup', () => {
  const messages = parseTelegramChannel(page, 'testchannel');
  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map((message) => message.id), [101, 102, 103, 104, 105, 106]);
  assert.equal(messages[0].published, '2026-11-03T10:00:00+00:00');
  assert.ok(messages[0].text.includes('خبر تازه هوش مصنوعی'));
  assert.ok(!messages[0].text.includes('<a'));
  assert.ok(!messages[0].text.includes('\u200f'));
  assert.equal(messages[0].preview.title, 'OpenAI ships a new agent model');
  assert.equal(messages[0].preview.site, 'Example');
  assert.equal(messages[5].forwarded, true);
  assert.equal(messages[3].forwarded, false);
});

test('pinned service notices never become posts', () => {
  const pinned = block({
    id: 199,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'MiladXtalks | آموزش هوش مصنوعی | MX AI ACADEMY pinned a GIF',
  });
  assert.deepEqual(parseTelegramChannel(pinned, 'testchannel'), []);
});

test('link filter keeps articles and drops social, video and shorteners', () => {
  assert.equal(isAllowedLink('https://example.com/a'), true);
  assert.equal(isAllowedLink('https://github.com/example/repo'), true);
  assert.equal(isAllowedLink('https://blog.google/technology/ai/x'), true);
  assert.equal(isAllowedLink('https://www.instagram.com/p/x'), false);
  assert.equal(isAllowedLink('https://youtu.be/x'), false);
  assert.equal(isAllowedLink('https://www.youtube.com/watch?v=x'), false);
  assert.equal(isAllowedLink('https://x.com/x'), false);
  assert.equal(isAllowedLink('https://bit.ly/x'), false);
  assert.equal(isAllowedLink('https://news.google.com/rss/articles/x'), false);
  assert.equal(isAllowedLink('tg://webproxy?server=x'), false);
  assert.equal(isAllowedLink('https://example.com/file.pdf'), false);
  assert.equal(isAllowedLink('https://localhost/a'), false);
  assert.equal(isAllowedLink('https://example.com/'), false);
  assert.equal(isAllowedLink('http://Helixworld.ai/'), false);
  assert.equal(isAllowedLink('https://example.com/?utm_source=tg'), false);
  assert.equal(isAllowedLink('https://example.com/?p=123'), true);
});

test('lead selection prefers an allowed article over a denied preview', () => {
  const messages = parseTelegramChannel(page, 'testchannel');
  const first = selectLeadLink(messages[0]);
  assert.equal(first.url, 'https://example.com/article?utm_source=tg');
  assert.equal(first.canonical, 'https://example.com/article');
  assert.equal(selectLeadLink(messages[1]), null);
  assert.equal(selectLeadLink(messages[2]), null);
  assert.equal(selectLeadLink(messages[4]).url, 'https://example.org/allowed');
  assert.equal(selectLeadLink(messages[5]).url, 'https://github.com/example/repo');
});

test('lead titles come from the preview or a meaningful text line', () => {
  const messages = parseTelegramChannel(page, 'testchannel');
  assert.equal(leadTitle(messages[0], messages[0].preview.title), 'OpenAI ships a new agent model');
  assert.ok(leadTitle(messages[4]).startsWith('عامل هوشمند'));
  assert.equal(leadTitle({ id: 9, text: 'Web Proxy\nیک توضیح سه کلمه‌ای' }), 'یک توضیح سه کلمه‌ای');
  assert.equal(leadTitle({ id: 9, text: '' }), 'سرنخ 9');
});

test('channel products, app-store links and referrals are promotions', () => {
  assert.equal(isPromotionalUrl('https://cafebazaar.ir/app/com.lahze.app'), true);
  assert.equal(isPromotionalUrl('https://play.google.com/store/apps/details?id=x'), true);
  assert.equal(isPromotionalUrl('https://zcode.z.ai/invite/GCCYZR39'), true);
  assert.equal(isPromotionalUrl('https://example.com/article'), false);
  assert.equal(hasPromoText('اپلیکیشن لحظه! در کافه‌بازار منتشر شد'), true);
  assert.equal(hasPromoText('وقت کلیم کردن رسیده'), true);
  assert.equal(hasPromoText('با لینک من جوین شید'), true);
  assert.equal(hasPromoText('خبر تازه مدل زبانی'), false);
  assert.equal(
    classifyLead('https://cafebazaar.ir/app/com.lahze.app', 'اپلیکیشن لحظه'),
    'promotion'
  );
  assert.equal(
    classifyLead('https://example.com/shop', 'کد تخفیف دوره را بزنید'),
    'off_topic_education'
  );
  assert.equal(classifyLead('https://example.com/news', 'خبر تازه مدل زبانی'), 'news');
});

test('only official academy courses are news-eligible', () => {
  assert.equal(
    classifyLead('https://www.anthropic.com/learn/claude', 'دوره رسمی کلود منتشر شد', {
      aiRelevant: true,
    }),
    'official_course'
  );
  assert.equal(
    classifyLead('https://openai.com/academy', 'OpenAI Academy', { aiRelevant: true }),
    'official_course'
  );
  assert.equal(
    classifyLead(
      'https://grow.google/healthcare-professionals/',
      'دوره تخصصی هوش مصنوعی برای کادر درمان',
      { aiRelevant: true }
    ),
    'official_course'
  );
  assert.equal(
    classifyLead('https://learn.microsoft.com/excel', 'دوره جامع اکسل برای کارمندان'),
    'off_topic_education'
  );
  assert.equal(isOfficialCourse('https://www.anthropic.com/learn/claude', 'دوره'), true);
  assert.equal(isOfficialCourse('https://example.com/course', 'دوره'), false);
  assert.equal(
    classifyLead('https://example.com/course', 'دوره آموزش هوش مصنوعی'),
    'off_topic_education'
  );
  assert.equal(
    classifyLead('https://example.com/course', 'دوره آموزش هوش مصنوعی', { aiCentral: true }),
    'education'
  );
  assert.equal(
    classifyLead('https://example.com/course', 'دوره رسمی کلود', { aiCentral: true }),
    'education'
  );
  assert.equal(
    classifyLead('https://example.com/machine-learning-news', 'machine learning model'),
    'news'
  );
});

test('lead selection skips promo links and keeps a real article', () => {
  const message = {
    id: 1,
    preview: null,
    links: ['https://cafebazaar.ir/app/com.lahze.app', 'https://example.com/article'],
  };
  assert.equal(selectLeadLink(message).url, 'https://example.com/article');
  assert.equal(
    selectLeadLink({ id: 2, preview: null, links: ['https://cafebazaar.ir/app/x'] }),
    null
  );
  assert.equal(
    selectLeadLink({ id: 3, preview: null, links: ['https://zcode.z.ai/invite/ABC'] }),
    null
  );
});

test('education posts are flagged for the private lane', () => {
  assert.equal(isEducationLead('دوره رایگان یادگیری هوش مصنوعی'), true);
  assert.equal(isEducationLead('ثبت‌نام وبینار تازه'), true);
  assert.equal(isEducationLead('AI for beginners course'), true);
  assert.equal(isEducationLead('آموزش نصب برنامه'), true);
  assert.equal(isEducationLead('در این ویدیو یاد می‌دم چطور بکاپ بگیرید'), true);
  assert.equal(isEducationLead('آموزش مدل زبانی روی داده‌های جدید'), false);
  assert.equal(isEducationLead('این ویدیو مدرکشه که مدل جدید آمده'), false);
  assert.equal(isEducationLead('خبر تازه مدل زبانی'), false);
  assert.equal(isEducationLead(''), false);
});

test('a news story about education is not an education lead', () => {
  const classroomStory = [
    'گوگل قراره از اوایل سال آینده میلادی، دسترسی به ابزارهای هوش مصنوعی خودش رو برای حساب‌های دانش‌آموزی مدارس ابتدایی تا دبیرستان به‌صورت پیش‌فرض غیرفعال کنه.',
    'این شرکت در ماه اوت، قابلیت‌های هوش مصنوعی رو به‌صورت پیش‌فرض در گوگل کلاس‌روم فعال کرده بود.',
    'کریس فیلیپس، معاون بخش آموزش گوگل، در گفت‌وگو با نیویورک تایمز گفته جست‌وجو و هوش مصنوعی به‌شدت به هم وابسته و یکپارچه شدن.',
  ].join(' ');

  assert.equal(isEducationLead(classroomStory), false);
  assert.equal(classifyLead('https://example.com/news', classroomStory), 'news');
  assert.equal(
    educationLeadLabel({
      title: classroomStory,
      messageText: classroomStory,
      link: 'https://example.com/news',
    }),
    'نامشخص'
  );

  const signals = educationSignals(classroomStory);
  assert.ok(signals.news.includes('announcement'));
  assert.ok(signals.news.includes('educationTopic'));
  assert.equal(signals.education.includes('course'), false);
  assert.equal(signals.education.includes('tutorial'), false);
  assert.ok(signals.newsScore > signals.educationScore);

  assert.equal(
    isEducationLead('کریس فیلیپس، معاون بخش آموزش گوگل، گفت جست‌وجو و هوش مصنوعی یکی شده‌اند.'),
    false
  );
});

test('education needs more than one weak word and keeps real courses', () => {
  assert.equal(isEducationLead('دوره متوسطه و مدارس ابتدایی'), false);
  assert.equal(isEducationLead('کلاس‌روم گوگل برای مدارس'), false);
  assert.equal(isEducationLead('خبر تازه مدل زبانی'), false);

  const signals = educationSignals('دوره رایگان یادگیری هوش مصنوعی');
  assert.ok(signals.education.includes('course'));
  assert.ok(signals.education.includes('qualifier'));
  assert.ok(signals.educationScore >= 3);
  assert.equal(isEducationLead('دوره رایگان یادگیری هوش مصنوعی'), true);

  assert.equal(isEducationLead('در گوگل کلاس‌روم دوره هوش مصنوعی را ثبت‌نام کنید'), true);

  const guidePost =
    'این ۳ ابزار رایگان با فایل PDF راهنمای فارسی (۱۰ صفحه) و نصب قدم‌به‌قدم برای مک و ویندوز و پرامپت‌های آماده';
  assert.equal(isEducationLead(guidePost), true);
  assert.equal(
    educationLeadLabel({
      title: 'صدای واقعی برای ویدیوهایی که با کلاود می‌سازی',
      messageText: guidePost,
      link: 'https://github.com/example/skills',
    }),
    'آموزش'
  );
  assert.equal(
    educationLeadLabel({
      title: 'ثبت نام دوره جامع هوش مدرن',
      messageText: 'آموزش کامل هوش مصنوعی از پایه',
      link: 'https://www.mghacademy.ir/product/modern-intelligence-course',
    }),
    'فروش دوره'
  );
});

test('real channel noise does not enter the education lane', () => {
  const productNews = [
    '🤖 قابلیت جدید Gemini؛ ساخت و شخصی‌سازی بیش از ۲۰۰۰ نوع صدا با هوش مصنوعی!',
    '🔵گوگل از قابلیت جدیدی به نام Voice Remixing برای مدل Gemini 3.8 Flash TTS رونمایی کرده که امکان انتخاب، طراحی و تغییر صداها را با استفاده از دستورات متنی فراهم می‌کند.',
    '🔵با این قابلیت می‌توانید از میان بیش از ۲۰۰۰ صدای مختلف انتخاب کنید یا حتی صدایی کاملاً جدید با ویژگی‌های دلخواه خود بسازید.',
    '🔵این قابلیت از طریق Google AI Studio و Gemini API در دسترس قرار گرفته و می‌تواند در ساخت پادکست، کتاب صوتی، دوبله، ویدئو و محتوای آموزشی کاربرد زیادی داشته باشد.',
    '🔵نکته مهم اینکه برای استفاده از قابلیت ریمیکس و ذخیره صداهای اختصاصی، پروژه شما در Gemini API باید به سطح پرداختی ارتقا پیدا کرده باشد.',
    '🔵 معرفی و آموزش رسمی:',
    'همراه ما باشید @ai_farshad',
  ].join('\n');
  assert.equal(isEducationLead(productNews), false);
  assert.notEqual(
    classifyLead('https://ai.google.dev/gemini-api/docs/voice-remixing', productNews, {
      aiRelevant: true,
      aiCentral: true,
    }),
    'education'
  );
  assert.equal(
    educationLeadLabel({
      title: '🤖 قابلیت جدید Gemini؛ ساخت و شخصی‌سازی بیش از ۲۰۰۰ نوع صدا با هوش مصنوعی!',
      messageText: productNews,
      link: 'https://ai.google.dev/gemini-api/docs/voice-remixing',
    }),
    'نامشخص'
  );

  const domainFreebie = [
    '✅دامنه رایگان✅',
    'رایگان به مدت 1 سال',
    'o6-MtSm-iDh',
    'دوره اعتبار: تا 8 نوامبر 2026',
    'لینک دریافت:',
    'order.idwebhost.com/domain-gratis',
  ].join('\n');
  assert.equal(isEducationLead(domainFreebie), false);

  const diary = [
    'دارم فکر میکنم همین ربات ثبت نام کارت به کارت رو میشه فروخت به آنلاین شاپا یا پیج های آموزشی اینستا 🤔',
    'پیام پارسال دقیقا همین روز',
    'جایی که ثبت نام دوره‌ها داشت با کارت به کارت انجام می‌شد و یه ربات هوشمند ساخته بودیم که عکس رسید رو چک میکرد.',
  ].join('\n');
  assert.equal(isEducationLead(diary), false);

  assert.equal(
    isEducationLead(
      '✈️ تلگرام تو نسخه بتای اندروید خودش داره یه قابلیت جدید به اسم Compact Mode رو تست می‌کنه که می‌تونه ظاهر چت کردن با ایجنت‌های هوش مصنوعی رو شبیه به رابط ChatGPT کنه. تیم تلگرام داره تجربه پیام‌رسانی کلاسیک خودش رو برای آینده تطبیق می‌ده.'
    ),
    false
  );
  assert.equal(
    isEducationLead(
      '🤖 کمپانی OpenAI بالاخره ChatGPT Images 2.6 رو داد بیرون و ساخت مستقیم گیف‌های متحرک رو ممکن کرد. این یعنی رسماً دوره زیر و رو کردن ده تا سایت و بات برای ساخت میم متحرک تموم شد.'
    ),
    false
  );
  assert.equal(
    isEducationLead(
      'Certificate authority DigiCert reports data breach involving business customer info. DigiCert explained that an internal business system was externally accessible when that was not intended, and someone had created an unauthorized account.'
    ),
    false
  );
  assert.equal(
    isEducationLead(
      'Understanding AI from the Inside: Neural networks are among the most consequential artefacts in human history. We continue to build increasingly powerful systems without fully understanding how they work, how they will behave in unfamiliar situations, or how to reliably control them.'
    ),
    false
  );

  const toolWithTutorialLink = [
    '😍😍😍😍😍',
    'نسخه اندروید BPB منتشر شد و حالا به راحتی میتونید با گوشی موبایلتون کانفیگ های اختصاصی بسازید و استفاده کنید.',
    '———',
    'برای مشاهده آموزش از یوتیوب اینجا بزنید 😎',
    '———',
    'لینک پروژه و دانلود برنامه مورد نیاز از گیتهاب ⛓',
  ].join('\n');
  assert.equal(isEducationLead(toolWithTutorialLink), false);

  assert.equal(
    isEducationLead(
      '😍😍😍😍😍\nآموزش کامل ساخت ویدیو های شورت وایرال با کلاد بدون نیاز به هزینه\nبرای مشاهده آموزش از یوتیوب اینجا بزنید 😎'
    ),
    true
  );
  assert.equal(isEducationLead('آموزش فعال‌سازی VPN داخلی فایرفاکس'), true);
  assert.equal(
    isEducationLead(
      `${'توضیح بلند درباره ایجنت‌ها و ابزارهای هوش مصنوعی. '.repeat(80)}دوره جامع هوش مدرن با ثبت نام از طریق لینک`
    ),
    true
  );
  assert.equal(
    isEducationLead(
      'یادم میاد پارسال دنبال دوره بودم؛ برای ثبت نام دوره جامع هوش مصنوعی از لینک زیر استفاده کنید'
    ),
    true
  );
});

test('a product news post with a tutorial phrase stays out of education', async () => {
  const gemini = [
    '🤖 قابلیت جدید Gemini؛ ساخت و شخصی‌سازی بیش از ۲۰۰۰ نوع صدا با هوش مصنوعی!',
    '🔵گوگل از قابلیت جدیدی به نام Voice Remixing برای مدل Gemini 3.8 Flash TTS رونمایی کرده که امکان انتخاب، طراحی و تغییر صداها را با استفاده از دستورات متنی فراهم می‌کند.',
    '🔵با این قابلیت می‌توانید از میان بیش از ۲۰۰۰ صدای مختلف انتخاب کنید یا حتی صدایی کاملاً جدید با ویژگی‌های دلخواه خود بسازید؛ مثلاً صدایی شبیه یک اژدهای افسانه‌ای!',
    '🔵این قابلیت از طریق Google AI Studio و Gemini API در دسترس قرار گرفته و می‌تواند در ساخت پادکست، کتاب صوتی، دوبله، ویدئو و محتوای آموزشی کاربرد زیادی داشته باشد.',
    '🔵نکته مهم اینکه برای استفاده از قابلیت ریمیکس و ذخیره صداهای اختصاصی، پروژه شما در Gemini API باید به سطح پرداختی ارتقا پیدا کرده باشد.',
    '🔵 معرفی و آموزش رسمی:',
    'همراه ما باشید @ai_farshad',
  ].join('\n');
  assert.equal(isEducationLead(gemini), false);

  const newsPage = block({
    id: 302,
    datetime: '2026-11-03T10:00:00+00:00',
    text: `${gemini}<br/><a href="https://ai.google.dev/gemini-api/docs/voice-remixing">معرفی</a>`,
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-news',
        name: 'AI channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state: emptyState(),
    now: NOW,
    fetchImpl: fetchPage(newsPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].educationHint, false);
  assert.notEqual(result.candidates[0].leadKind, 'education');
});

test('a review lead that repeats a published story is detected', () => {
  const published = { title: 'مدارس از ۲۰۲۷ یا هوش مصنوعی گوگل یا جست‌وجو' };
  const classroomStory = [
    '🔍گوگل قراره از اوایل سال آینده میلادی، دسترسی به ابزارهای هوش مصنوعی خودش رو برای حساب‌های دانش‌آموزی مدارس ابتدایی تا دبیرستان به‌صورت پیش‌فرض غیرفعال کنه.',
    'این شرکت در ماه اوت، قابلیت‌های هوش مصنوعی رو به‌صورت پیش‌فرض در گوگل کلاس‌روم فعال کرده بود.',
    'کریس فیلیپس، معاون بخش آموزش گوگل، در گفت‌وگو با نیویورک تایمز گفته جست‌وجو و هوش مصنوعی به‌شدت به هم وابسته و یکپارچه شدن.',
  ].join(' ');

  assert.equal(matchesPublishedStory(classroomStory, published), true);
  assert.equal(
    matchesPublishedStory('گوگل مدل جمینی ۳ را معرفی کرد و در دسترس همه قرار داد', published),
    false
  );
  assert.equal(
    matchesPublishedStory('بودجه مدارس برای آموزش هوش مصنوعی دو برابر شد', published),
    false
  );
  assert.equal(
    matchesPublishedStory('گوگل سیاست جدیدش برای مدارس را اصلاح کرد', published),
    false
  );
  assert.equal(matchesPublishedStory(classroomStory, {}), false);
});

test('education digest keeps one link per lead and stays private', () => {
  const digest = buildEducationDigest({
    leads: [
      {
        title: 'دوره مقدماتی هوش مصنوعی',
        sourceName: 'کانال تست',
        leadSource: 'testchannel',
        published: '2026-11-03T10:00:00Z',
        canonical: 'https://example.com/course',
      },
      {
        title: 'همان دوره',
        sourceName: 'کانال تست',
        leadSource: 'testchannel',
        published: '2026-11-03T10:00:00Z',
        canonical: 'https://example.com/course',
      },
      {
        title: 'کارگاه تازه',
        sourceName: 'کانال دوم',
        leadSource: 'second',
        canonical: 'https://example.com/workshop',
      },
    ],
    date: '2026-11-03',
    slot: '14:00',
  });
  assert.ok(digest.includes('لیدهای آموزشی'));
  assert.ok(digest.includes('دوره مقدماتی هوش مصنوعی'));
  assert.ok(digest.includes('کارگاه تازه'));
  assert.equal(digest.match(/https:\/\/example\.com\/course/g).length, 1);
  assert.ok(digest.includes('https://example.com/workshop'));
  assert.ok(digest.includes('کانال اصلی'));
  assert.equal(buildEducationDigest({ leads: [] }), '');
  const many = Array.from({ length: 7 }, (_, index) => ({
    title: `دوره ${index}`,
    canonical: `https://example.com/course-${index}`,
  }));
  assert.equal(educationDigestLeads(many, { max: 100 }).length, 7);
  assert.equal(educationDigestLeads(many).length, 5);
  const fullDigest = buildEducationDigest({ leads: many });
  assert.equal(fullDigest.match(/^برچسب:/gm).length, 5);
  assert.equal(fullDigest.includes('لید آموزشی دیگر'), false);
  assert.equal(fullDigest.includes('https://example.com/course-6'), false);

  const ranked = educationDigestLeads([
    { title: 'دوره تازه', canonical: 'https://example.com/new', published: '2026-11-05T10:00:00Z' },
    {
      title: 'دوره هوش مصنوعی',
      canonical: 'https://example.com/ai',
      published: '2026-11-01T10:00:00Z',
    },
  ]);
  assert.equal(ranked[0].canonical, 'https://example.com/ai');
});

test('education labels separate a tutorial from a course sale', () => {
  assert.equal(
    educationLeadLabel({
      title: 'ثبت نام دوره جامع هوش مدرن',
      messageText: 'ظرفیت محدود، ثبت نام دوره جامع',
      link: 'https://www.mghacademy.ir/product/modern-intelligence-course',
    }),
    'فروش دوره'
  );
  assert.equal(
    educationLeadLabel({
      title: 'آموزش اجرای هرمس روی سرور رایگان',
      messageText: 'در این ویدئو قدم به قدم یاد می‌دم',
      link: 'https://youtu.be/d9n6cRNhFSc',
    }),
    'آموزش'
  );
  assert.equal(
    educationLeadLabel({ title: 'یک ویدئوی تازه', link: 'https://www.youtube.com/watch?v=1' }),
    'آموزش'
  );
  assert.equal(educationLeadLabel({ title: 'یک یادداشت کوتاه', link: 'https://example.com/a' }), 'نامشخص');
});

test('an education message carries the original text and both links', () => {
  const message = buildEducationMessage({
    title: 'آموزش بکاپ هرمس',
    messageText: 'در این ویدئو یاد می‌دم چطور از هرمس بکاپ بگیرید.',
    sourceName: 'کانال تست',
    leadSource: 'testchannel',
    published: '2026-11-03T10:00:00Z',
    canonical: 'https://youtu.be/x',
    link: 'https://youtu.be/x',
    leadPostUrl: 'https://t.me/testchannel/5',
  });
  assert.ok(message.includes('لید آموزشی | آموزش'));
  assert.ok(message.includes('در این ویدئو یاد می‌دم'));
  assert.ok(message.includes('https://t.me/testchannel/5'));
  assert.ok(message.includes('https://youtu.be/x'));
  const long = buildEducationMessages(
    {
      title: 'آموزش بلند',
      messageText: 'خط\n'.repeat(2000),
      link: 'https://youtu.be/x',
    },
    { maxTextChars: 100000 }
  );
  assert.ok(long.length > 1);
  assert.ok(long.every((part) => part.length < 4096));
  assert.ok(long.at(-1).includes('https://youtu.be/x'));
  assert.ok(long.join('\n').includes('🎓 لید آموزشی | ادامه'));
  assert.equal((long.join('\n').match(/^خط$/gm) || []).length, 2000);
  assert.equal(long.join('\n').includes(' …'), false);

  const [capped] = buildEducationMessages(
    { title: 'آموزش بلند', messageText: 'جمله '.repeat(500) },
    { maxTextChars: 1200 }
  );
  assert.ok(capped.includes(' …'));

  const [cleaned] = buildEducationMessages({
    title: 'آموزش پاک‌سازی',
    messageText: 'خط اول\nhttps://example.com/promo\nخط دوم',
    link: 'https://example.com/main',
  });
  assert.equal(cleaned.includes('https://example.com/promo'), false);
  assert.ok(cleaned.includes('https://example.com/main'));

  assert.equal(selectAnyLink({ preview: null, links: ['https://youtu.be/x'] }), 'https://youtu.be/x');
  assert.equal(selectAnyLink({ preview: null, links: [] }), '');
});

test('a title already present in the original text is not repeated', () => {
  const [message] = buildEducationMessages({
    title: '🚀 نسخه جدید #TheFeed (v.0.41.0)',
    messageText: '🚀 نسخه جدید #TheFeed (v.0.41.0)\nجزئیات بیشتر در پست.',
    sourceName: 'کانال تست',
    leadPostUrl: 'https://t.me/ch/1',
  });
  assert.equal((message.match(/#TheFeed/g) || []).length, 1);
});

test('collector marks education leads and keeps channel focus', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 201,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'دوره تازه هوش مصنوعی <a href="https://example.com/course">ثبت‌نام</a>',
    preview: { url: 'https://example.com/course', title: 'AI course' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu',
        name: 'Edu channel',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].educationHint, true);
  assert.equal(result.candidates[0].sourceFocus, 'education');
});

test('a tutorial with only a YouTube link still reaches the private lane', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 202,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      '🎬 آموزش اجرای عامل هوش مصنوعی هرمس روی سرور رایگان<br/><a href="https://youtu.be/d9n6cRNhFSc">یوتیوب</a>',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-video',
        name: 'Edu video channel',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.leadKind, 'education');
  assert.equal(lead.educationHint, true);
  assert.equal(lead.link, 'https://youtu.be/d9n6cRNhFSc');
  assert.equal(lead.leadPostUrl, 'https://t.me/testchannel/202');
  assert.ok(lead.messageText.includes('آموزش'));
  assert.equal(result.stats.telegram.denied, 0);
  assert.equal(result.stats.telegram.leads, 1);
});

test('a linkless education post falls back to its channel permalink', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 203,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'آموزش کوتاه: قبل از هر آپدیت از مدل هوش مصنوعی بکاپ بگیرید.',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-note',
        name: 'Edu note channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadKind, 'education');
  assert.equal(result.candidates[0].link, 'https://t.me/testchannel/203');
  assert.equal(result.stats.telegram.noLink, 0);
});

test('education without AI centrality still reaches the private lane', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 205,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'دوره رایگان مدیریت زمان و بهره‌وری <a href="https://example.com/time">ثبت‌نام</a>',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-offtopic',
        name: 'Off-topic education',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadKind, 'education');
  assert.equal(result.candidates[0].educationHint, true);
  assert.equal(result.stats.telegram.nonAiEducation, 1);
  assert.equal(result.stats.telegram.leads, 1);
  assert.equal(state.telegram.testchannel.last_id, 205);
});

test('verbatim education keeps the original text even when it contains an ad line', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 206,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'دوره هوش مصنوعی برای مبتدی‌ها<br/>تبلیغات: فلان سرویس ویژه<br/><a href="https://example.com/course">ثبت‌نام</a>',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-ad',
        name: 'AI education with an ad',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.educationHint, true);
  assert.equal(lead.aiCentral, true);
  assert.ok(lead.messageText.includes('دوره هوش مصنوعی'));
  assert.ok(lead.messageText.includes('تبلیغات'));
  assert.ok(lead.messageText.includes('سرویس ویژه'));
});

test('a channel mention link does not replace the education post permalink', async () => {
  const state = emptyState();
  const eduPage = block({
    id: 204,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'آموزش فعال‌سازی دستیار هوش مصنوعی در فایرفاکس <a href="https://t.me/testchannel">کانال</a>',
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-mention',
        name: 'Edu mention channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(eduPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadKind, 'education');
  assert.equal(result.candidates[0].link, 'https://t.me/testchannel/204');
  assert.equal(result.candidates[0].canonical, 'https://t.me/testchannel/204');
});

test('collector drops channel product ads before they reach news', async () => {
  const state = emptyState();
  const promoPage = block({
    id: 301,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'اپلیکیشن لحظه! در کافه‌بازار منتشر شد <a href="https://cafebazaar.ir/app/com.lahze.app">لینک</a>',
    preview: { url: 'https://cafebazaar.ir/app/com.lahze.app', title: 'لحظه' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-promo',
        name: 'Promo channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(promoPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.stats.telegram.promoted, 1);
  assert.equal(result.stats.telegram.leads, 0);
  assert.equal(state.telegram.testchannel.last_id, 301);
});

test('collector keeps an AI tool from Telegram for the main lane', async () => {
  const state = emptyState();
  const toolPage = block({
    id: 401,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'ابزار جدید هوش مصنوعی برای ساخت ویدیو <a href="https://example.com/tool">تست</a>',
    preview: { url: 'https://example.com/tool', title: 'AI video tool' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-tool',
        name: 'Tool channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(toolPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.leadKind, 'tool_lead');
  assert.equal(lead.toolHint, true);
  assert.equal(lead.offerHint, false);
  assert.equal(lead.educationHint, false);
  assert.equal(lead.needsReview, false);
  assert.equal(lead.categoryHint, 'tools');
  assert.equal(result.stats.telegram.promoted, 0);
});

test('collector keeps a Telegram free offer instead of calling it promotion', async () => {
  const state = emptyState();
  const offerPage = block({
    id: 402,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'اعتبار رایگان OpenAI برای ساخت اپلیکیشن <a href="https://platform.openai.com/apps">دریافت</a>',
    preview: { url: 'https://platform.openai.com/apps', title: 'OpenAI free credits' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-offer',
        name: 'Offer channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(offerPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.leadKind, 'free_offer');
  assert.equal(lead.offerHint, true);
  assert.equal(lead.educationHint, false);
  assert.equal(result.stats.telegram.promoted, 0);
});

test('an AI referral link goes to review instead of being dropped', async () => {
  const state = emptyState();
  const referralPage = block({
    id: 403,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'سرویس هوش مصنوعی زدکد رایگان با لینک دعوت <a href="https://zcode.z.ai/invite/ABC">لینک</a>',
    preview: { url: 'https://zcode.z.ai/invite/ABC', title: 'ZCode free access' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-referral',
        name: 'Referral channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(referralPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.leadKind, 'free_offer');
  assert.equal(lead.referral, true);
  assert.equal(lead.needsReview, true);
  assert.equal(lead.reviewReason, 'referral_link');
  assert.equal(result.stats.telegram.promoted, 0);
});

test('a referral query on an AI tool lead routes to review, not the main lane', async () => {
  const state = emptyState();
  const partnerPage = block({
    id: 405,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'عامل کدنویسی هوش مصنوعی تازه <a href="https://github.com/example/agent?partner=acme">repo</a>',
    preview: { url: 'https://github.com/example/agent?partner=acme', title: 'AI coding agent' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-partner',
        name: 'Partner channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(partnerPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  const lead = result.candidates[0];
  assert.equal(lead.leadKind, 'tool_lead');
  assert.equal(lead.referral, true);
  assert.equal(lead.needsReview, true);
  assert.equal(result.stats.telegram.promoted, 0);
});

test('an AI app-store ad is still a promotion, not a tool', async () => {
  const state = emptyState();
  const storePage = block({
    id: 404,
    datetime: '2026-11-03T10:00:00+00:00',
    text:
      'اپلیکیشن هوش مصنوعی ما در کافه‌بازار <a href="https://cafebazaar.ir/app/com.ai.app">نصب</a>',
    preview: { url: 'https://cafebazaar.ir/app/com.ai.app', title: 'AI app' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-store',
        name: 'Store channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(storePage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.stats.telegram.promoted, 1);
});

test('collector routes an official academy course to news, not education', async () => {
  const state = emptyState();
  const coursePage = block({
    id: 302,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'دوره رسمی کلود <a href="https://www.anthropic.com/learn/claude">ثبت‌نام</a>',
    preview: { url: 'https://www.anthropic.com/learn/claude', title: 'Claude Academy' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-course',
        name: 'Course channel',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(coursePage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadKind, 'official_course');
  assert.equal(result.candidates[0].educationHint, false);
  assert.equal(result.candidates[0].officialCourse, true);
  assert.equal(result.stats.telegram.leads, 1);
});

test('web education feeds mark only AI tutorials as education', async () => {
  const state = emptyState();
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Edu Feed</title>
  <item>
    <title>How to build an AI agent with Python</title>
    <link>https://edu.example/ai-agent</link>
    <description>Build a small AI agent step by step.</description>
    <pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Decorators for Timing and Caching in Python</title>
    <link>https://edu.example/decorators</link>
    <description>Learn how Python decorators work under the hood.</description>
    <pubDate>Tue, 03 Nov 2026 11:00:00 GMT</pubDate>
  </item>
</channel></rss>`;
  const result = await collectCandidates({
    sources: [
      {
        id: 'edu-feed',
        name: 'Edu Feed',
        type: 'education_blog',
        use: 'feed',
        feed_url: 'https://edu.example/feed',
        categories: ['education'],
        lane: 'private_research',
      },
    ],
    state,
    now: NOW,
    fetchImpl: async (target) => {
      assert.equal(target, 'https://edu.example/feed');
      return { text: feed, url: target };
    },
    telegram: { enabled: false },
  });

  const education = result.candidates.filter((candidate) => candidate.educationHint);
  assert.equal(education.length, 1);
  assert.match(education[0].title, /AI agent/);
  assert.equal(education[0].webEducation, true);
  const decorators = result.candidates.find((candidate) => /Decorators/.test(candidate.title));
  assert.equal(decorators.educationHint, false);
});

test('channel focus alone does not turn news into education', async () => {
  const state = emptyState();
  const newsPage = block({
    id: 303,
    datetime: '2026-11-03T10:00:00+00:00',
    text: 'خبر تازه مدل زبانی <a href="https://example.com/model">جزئیات</a>',
    preview: { url: 'https://example.com/model', title: 'A new language model' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-edu-channel',
        name: 'Edu channel',
        type: 'telegram_channel',
        use: 'lead_only',
        focus: 'education',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(newsPage),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadKind, 'news');
  assert.equal(result.candidates[0].educationHint, false);
  assert.equal(result.candidates[0].sourceFocus, 'education');
});

test('collector turns channel posts into article leads and stores a cursor', async () => {
  const state = emptyState();
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-test',
        name: 'Test channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(page),
    telegram: { enabled: true },
  });

  assert.equal(result.candidates.length, 3);
  assert.equal(result.stats.telegram.posts, 6);
  assert.equal(result.stats.telegram.leads, 3);
  assert.equal(result.stats.telegram.beforeStart, 1);
  assert.equal(result.stats.telegram.denied, 1);
  assert.equal(result.stats.telegram.noLink, 1);
  assert.equal(result.stats.telegram.duplicate, 0);
  assert.equal(state.telegram.testchannel.last_id, 106);

  const first = result.candidates.find((candidate) => candidate.leadMessageId === 101);
  assert.equal(first.link, 'https://example.com/article?utm_source=tg');
  assert.equal(first.canonical, 'https://example.com/article');
  assert.equal(first.title, 'OpenAI ships a new agent model');
  assert.equal(first.summary, '');
  assert.deepEqual(first.images, []);
  assert.equal(first.sourceType, 'telegram_channel');
  assert.equal(first.leadSource, 'testchannel');
  assert.equal(first.offerHint, false);
  assert.equal(first.aiHint, true);
  assert.equal(first.leadKind, 'news');
  assert.equal(first.educationHint, false);
  assert.equal(first.officialCourse, false);
  assert.equal(first.sourceFocus, '');
  assert.equal(result.stats.telegram.promoted, 0);

  const second = await collectCandidates({
    sources: [
      {
        id: 'tg-test',
        name: 'Test channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(page),
    telegram: { enabled: true },
  });
  assert.equal(second.candidates.length, 0);
  assert.equal(second.stats.telegram.pending, 0);
  assert.equal(second.stats.telegram.leads, 0);
  assert.equal(state.telegram.testchannel.last_id, 106);
});

test('a new channel message after the cursor becomes a new lead', async () => {
  const state = emptyState();
  state.telegram.testchannel = { last_id: 106, last_at: '2026-11-03T13:30:00+00:00' };
  const next = page + block({
    id: 107,
    datetime: '2026-11-03T14:00:00+00:00',
    text: 'مدل زبانی تازه <a href="https://example.com/new">لینک</a>',
    preview: { url: 'https://example.com/new', title: 'A new language model' },
  });
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-test',
        name: 'Test channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
        max_posts_per_check: 10,
      },
    ],
    state,
    now: NOW,
    fetchImpl: fetchPage(next),
    telegram: { enabled: true },
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].leadMessageId, 107);
  assert.equal(state.telegram.testchannel.last_id, 107);
});

test('disabled telegram discovery leaves the channel unread', async () => {
  const result = await collectCandidates({
    sources: [
      {
        id: 'tg-test',
        name: 'Test channel',
        type: 'telegram_channel',
        use: 'lead_only',
        username: 'testchannel',
        active_from: ACTIVE_FROM,
      },
    ],
    state: emptyState(),
    now: NOW,
    fetchImpl: async () => {
      throw new Error('must not fetch');
    },
    telegram: { enabled: false },
  });
  assert.equal(result.stats.telegram.channels, 0);
  assert.equal(result.candidates.length, 0);
});
