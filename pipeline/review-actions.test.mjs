import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(ROOT, 'pipeline', 'review-actions.mjs');
const NOW = '2026-11-14T15:00:00Z';
const NIGHT = '2026-11-14T02:00:00Z';

const VALID_BODY = [
  'شرکت اوپن‌ای‌آی اعلام کرد که دسترسی به اعتبار رایگان این سرویس برای توسعه‌دهندگان تازه آغاز شده است.',
  '',
  '- هر حساب تازه صد دلار اعتبار رایگان دریافت می‌کند',
  '- این اعتبار برای فراخوانی مدل و ابزارهای صوتی قابل استفاده است',
  '- امکان انتقال اعتبار به حساب دیگر وجود ندارد',
  '',
  'این آفر تا ۳۱ دسامبر ۲۰۲۶ معتبر است و پس از آن اعتبار باقی‌مانده سوخت می‌شود.',
  '',
  'این موضوع از اونجایی مهمه که این آفر هزینه شروع کار برای تیم‌های کوچک را کاهش می‌دهد و رقابت میان سرویس‌دهندگان را جدی‌تر می‌کند.',
  '',
  'منبع: [OpenAI](https://openai.com/news/test-offer)',
].join('\n');

const PUBLISH_POST = {
  decision: 'publish',
  title: 'اعتبار رایگان صددلاری برای توسعه‌دهندگان',
  body: VALID_BODY,
  post_type: 'standard',
  importance: 3,
  verification: 'official',
  category: 'tools',
  source_url: 'https://openai.com/news/test-offer',
  image_url: '',
  key_facts: ['صد دلار اعتبار رایگان', 'اعتبار تا پایان دسامبر'],
  entities: { companies: ['OpenAI'], models: [] },
  dedupe_key: 'openai-free-credits',
};

function item(fields = {}) {
  return {
    id: 'deadbeef01',
    messageId: 42,
    chatId: '-1001',
    status: 'pending',
    kind: 'offer',
    source: 'openai-blog',
    sourceName: 'OpenAI',
    sourceType: 'official_blog',
    title: 'اعتبار رایگان صددلاری برای توسعه‌دهندگان',
    url: 'https://openai.com/news/test-offer',
    leadPostUrl: '',
    messageText: VALID_BODY,
    relatedLinks: [],
    images: [],
    imageUrl: '',
    publishedAt: '2026-11-14T10:00:00Z',
    keys: ['url:abc123', 'title:def456'],
    benchmark: false,
    toolHint: false,
    offerHint: true,
    rumorHint: false,
    policy: false,
    mainEligible: false,
    qaPass: false,
    post: PUBLISH_POST,
    expiry: { date: '۳۱ دسامبر ۲۰۲۶', year: 2026, month: 12, day: 31, remainingHours: 500 },
    rewrites: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

function storeOf(entries) {
  return {
    version: 1,
    offset: 0,
    items: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    actions: [],
    sources: {},
  };
}

function update(action, id, { extra = '', messageId = 42, updateId = 7 } = {}) {
  const data = extra ? `rv1|${action}|${id}|${extra}` : `rv1|${action}|${id}`;
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: { id: 99, username: 'amir' },
      message: { message_id: messageId, chat: { id: -1001 } },
    },
  };
}

async function run(updates, entries, now = NOW) {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-actions-'));
  const feedback = join(dir, 'feedback.json');
  const content = `${JSON.stringify(storeOf(entries), null, 2)}\n`;
  await writeFile(feedback, content, 'utf8');
  const updatesPath = join(dir, 'updates.json');
  await writeFile(updatesPath, JSON.stringify({ ok: true, result: updates }), 'utf8');
  const output = execFileSync(
    process.execPath,
    [
      SCRIPT,
      '--updates',
      updatesPath,
      '--review-feedback',
      feedback,
      '--state',
      join(dir, 'state.json'),
      '--review-state',
      join(dir, 'review-state.json'),
      '--now',
      now,
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  assert.equal(await readFile(feedback, 'utf8'), content, 'dry run must not write the store');
  return output;
}

test('a reject callback is logged with its reason and deletes the card', async () => {
  const output = await run([update('x', 'deadbeef01', { extra: 'quality' })], [item()]);
  assert.match(output, /REVIEW_REJECTED id=deadbeef01 reason=quality deleted=no/);
  assert.match(output, /DRY_ANSWER رد شد؛ پیام پاک می‌شود/);
  assert.match(output, /REVIEW_ACTIONS_DONE handled=1 failed=0/);
});

test('the reject button asks for a reason and then deletes the card', async () => {
  const menu = await run([update('r', 'deadbeef01')], [item()]);
  assert.match(menu, /REVIEW_REJECT_MENU id=deadbeef01/);
  assert.match(menu, /DRY_ANSWER دلیل رد را انتخاب کن/);
  assert.doesNotMatch(menu, /REVIEW_REJECTED/);
  const rejected = await run([update('x', 'deadbeef01', { extra: 'quality' })], [item()]);
  assert.match(rejected, /REVIEW_REJECTED id=deadbeef01 reason=quality/);
  const back = await run([update('m', 'deadbeef01')], [item()]);
  assert.match(back, /DRY_ANSWER دکمه‌ها برگشتند/);
});

test('a delete callback removes a lead card without a stored item', async () => {
  const output = await run([update('d', '00000000')], []);
  assert.match(output, /DRY_ANSWER حذف شد/);
  assert.match(output, /DRY_DELETE message=42/);
});

test('a rewrite preview shows the next keyboard with repeat rewrite and publish', async () => {
  const output = await run([update('w', 'deadbeef01')], [item()]);
  assert.match(output, /REVIEW_REWRITE_START id=deadbeef01 attempt=1\/2/);
  assert.match(output, /DRY_REWRITE id=deadbeef01 rewrites=0->1/);
  assert.match(output, /بازنویسی مجدد/);
  assert.match(output, /ارسال به کانال اصلی/);
});

test('a manual rewrite starts from the item flag and logs manual=1', async () => {
  const output = await run([update('w', 'deadbeef01')], [item({ manual: true })]);
  assert.match(output, /REVIEW_REWRITE_START id=deadbeef01 attempt=1\/2 manual=1/);
  assert.match(output, /DRY_REWRITE id=deadbeef01 rewrites=0->1/);
});

test('a rewrite over the item cap is refused before any model call', async () => {
  const output = await run([update('w', 'deadbeef01')], [item({ rewrites: 2 })]);
  assert.match(output, /DRY_NOTIFY سقف بازنویسی این مورد پر است \(2\/2\)/);
  assert.doesNotMatch(output, /DRY_REWRITE/);
});

test('a publish callback previews the guard result without sending', async () => {
  const output = await run([update('p', 'deadbeef01')], [item()]);
  assert.match(output, /DRY_PUBLISH id=deadbeef01 guard=ok category=tools/);
  assert.doesNotMatch(output, /REVIEW_PUBLISHED/);
});

test('a publish outside the send window is blocked with the quiet-hours reason', async () => {
  const output = await run([update('p', 'deadbeef01')], [item()], NIGHT);
  assert.match(output, /REVIEW_PUBLISH_BLOCKED id=deadbeef01 reason=quiet_hours/);
  assert.match(output, /DRY_NOTIFY ارسال نشد/);
});

test('a manual publish bypasses quiet hours in the dry preview', async () => {
  const output = await run([update('p', 'deadbeef01')], [item({ manual: true })], NIGHT);
  assert.match(output, /DRY_PUBLISH id=deadbeef01 guard=ok category=tools manual=1/);
  assert.doesNotMatch(output, /quiet_hours/);
  assert.doesNotMatch(output, /REVIEW_PUBLISH_BLOCKED/);
});

test('a callback from another message id is ignored', async () => {
  const output = await run([update('x', 'deadbeef01', { extra: 'quality', messageId: 77 })], [item()]);
  assert.match(output, /DRY_NOTIFY این دکمه دیگر معتبر نیست/);
  assert.doesNotMatch(output, /REVIEW_REJECTED/);
});

test('an unknown callback payload is answered but not dispatched', async () => {
  const output = await run([update('z', 'deadbeef01')], [item()]);
  assert.match(output, /DRY_ANSWER این دکمه شناسایی نشد/);
  assert.match(output, /handled=0 failed=0/);
});

test('a status-only button answers without touching the item', async () => {
  const closed = await run([update('s', 'deadbeef01')], [item()]);
  assert.match(closed, /DRY_ANSWER این نسخه بسته شده؛ پیام تازه را ببین/);
  assert.match(closed, /handled=1 failed=0/);
  const rewritten = await run([update('s', 'deadbeef01')], [item({ rewrites: 1 })]);
  assert.match(rewritten, /DRY_ANSWER این نسخه بازنویسی شده؛ پیام تازه را ببین/);
});

test('the live publisher imports every store helper it calls', async () => {
  const src = await readFile(new URL('./review-actions.mjs', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*\brecordPublished\b[^}]*\}\s*from\s*'\.\/store\.mjs'/s);
});
