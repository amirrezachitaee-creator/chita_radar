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

function storeOf(entries, pendingRejects = null, pendingNotes = null) {
  return {
    version: 1,
    offset: 0,
    items: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    actions: [],
    sources: {},
    ...(pendingRejects ? { pendingRejects } : {}),
    ...(pendingNotes ? { pendingNotes } : {}),
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

function noteUpdate(text, { replyTo = 42, messageId = 500, updateId = 7, chatId = -1001 } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: chatId },
      from: { id: 99, username: 'amir' },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  };
}

async function run(
  updates,
  entries,
  now = NOW,
  { queueNotice = false, env = {}, pendingRejects = null, pendingNotes = null } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'qoder-actions-'));
  const feedback = join(dir, 'feedback.json');
  const content = `${JSON.stringify(storeOf(entries, pendingRejects, pendingNotes), null, 2)}\n`;
  await writeFile(feedback, content, 'utf8');
  const updatesPath = join(dir, 'updates.json');
  await writeFile(updatesPath, JSON.stringify({ ok: true, result: updates }), 'utf8');
  const args = [
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
    '--review-chat',
    '-1001',
  ];
  if (queueNotice) args.push('--queue-notice');
  const output = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(await readFile(feedback, 'utf8'), content, 'dry run must not write the store');
  return output;
}

test('a reject callback is logged with its reason and deletes the card', async () => {
  const output = await run([update('x', 'deadbeef01', { extra: 'quality' })], [item()]);
  assert.match(output, /REVIEW_REJECTED id=deadbeef01 reason=quality deleted=no/);
  assert.match(output, /DRY_ANSWER رد شد؛ پیام پاک می‌شود/);
  assert.match(output, /REVIEW_ACTIONS_DONE handled=1 failed=0/);
});

test('a reject is applied even while an automatic slot is busy', async () => {
  const output = await run([update('x', 'deadbeef01', { extra: 'quality' })], [item()], NOW, {
    env: { SLOT_BUSY: '1' },
  });
  assert.match(output, /REVIEW_REJECTED id=deadbeef01 reason=quality/);
  assert.match(output, /DRY_ANSWER رد شد؛ پیام پاک می‌شود/);
  assert.doesNotMatch(output, /REVIEW_PUBLISH_QUEUED|SLOT_BUSY/);
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
  assert.match(output, /DRY_ANSWER این دکمه دیگر معتبر نیست/);
  assert.doesNotMatch(output, /REVIEW_REJECTED/);
});

test('a reject for a card not yet saved is queued without blocking the queue', async () => {
  const output = await run([update('x', 'deadbeef01', { extra: 'quality' })], []);
  assert.match(output, /DRY_ANSWER رد شد؛ پیام پاک می‌شود/);
  assert.match(output, /REVIEW_REJECT_PENDING id=deadbeef01 reason=quality/);
  assert.doesNotMatch(output, /REVIEW_ACTION_RETRY|این کارت هنوز در سیستم ثبت نشده/);
  assert.match(output, /REVIEW_ACTIONS_DONE handled=1 failed=0/);
});

test('the reason menu opens even when the card is not saved yet', async () => {
  const output = await run([update('r', 'deadbeef01')], []);
  assert.match(output, /DRY_ANSWER دلیل رد را انتخاب کن/);
  assert.match(output, /REVIEW_REJECT_MENU id=deadbeef01 unregistered=1/);
  assert.doesNotMatch(output, /REVIEW_ACTION_RETRY/);
  assert.match(output, /REVIEW_ACTIONS_DONE handled=1 failed=0/);
});

test('a queued reject is applied once the card is registered', async () => {
  const output = await run([], [item()], NOW, {
    pendingRejects: {
      deadbeef01: {
        reason: 'quality',
        actor: 'amir',
        at: '2026-11-14T14:59:00Z',
        messageId: 42,
      },
    },
  });
  assert.match(output, /REVIEW_REJECT_APPLIED id=deadbeef01 reason=quality/);
  assert.match(output, /REVIEW_ACTIONS_DONE/);
});

test('a publish during a busy slot is queued and not sent', async () => {
  const output = await run([update('p', 'deadbeef01')], [item()], NOW, {
    env: { SLOT_BUSY: '1' },
  });
  assert.match(output, /REVIEW_PUBLISH_QUEUED id=deadbeef01 slot_busy=1/);
  assert.match(output, /DRY_ANSWER درخواست ثبت شد/);
  assert.match(output, /DRY_NOTIFY ⏳ انتشار این کارت/);
  assert.doesNotMatch(output, /DRY_PUBLISH/);
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

test('a queued press is announced with the busy-slot reason and stays unprocessed', async () => {
  const output = await run([update('p', 'deadbeef01')], [item()], NOW, { queueNotice: true });
  assert.match(output, /DRY_QUEUE_NOTICE callbacks=1/);
  assert.match(output, /DRY_NOTIFY ⏳ دکمه‌ات رفت تو صف، چون اسلات خودکار مشغول است/);
  assert.doesNotMatch(output, /DRY_PUBLISH/);
  assert.doesNotMatch(output, /REVIEW_PUBLISH/);
});

test('several queued presses are counted in one notice', async () => {
  const output = await run(
    [
      update('p', 'deadbeef01', { updateId: 8 }),
      update('x', 'deadbeef01', { extra: 'quality', updateId: 9, messageId: 43 }),
    ],
    [item()],
    NOW,
    { queueNotice: true }
  );
  assert.match(output, /DRY_QUEUE_NOTICE callbacks=2/);
  assert.match(output, /DRY_NOTIFY ⏳ 2 دکمه رفت تو صف، چون اسلات خودکار مشغول است/);
  assert.doesNotMatch(output, /DRY_PUBLISH|DRY_REWRITE|REVIEW_REJECTED/);
});

test('the note button explains the reply step and never blocks the queue', async () => {
  const output = await run([update('n', 'deadbeef01')], [item()]);
  assert.match(output, /DRY_ANSWER یادداشت یا منبع را به همین کارت ریپلای کن/);
  assert.match(output, /REVIEW_NOTE_HINT id=deadbeef01 \| اعتبار رایگان/);
  assert.match(output, /REVIEW_ACTIONS_DONE handled=1 failed=0/);
});

test('the note hint still answers when the card is not registered yet', async () => {
  const output = await run([update('n', 'deadbeef01')], []);
  assert.match(output, /REVIEW_NOTE_HINT id=deadbeef01 unregistered=1/);
  assert.doesNotMatch(output, /REVIEW_ACTION_RETRY/);
  assert.match(output, /handled=1 failed=0/);
});

test('a closed card refuses a note instead of attaching it', async () => {
  const output = await run([update('n', 'deadbeef01')], [item({ status: 'rejected' })]);
  assert.match(output, /DRY_ANSWER این کارت بسته شده؛ یادداشت ثبت نمی‌شود/);
  assert.match(output, /handled=1 failed=0/);
});

test('a reply note attaches to the card and keeps its link count', async () => {
  const output = await run(
    [noteUpdate('منبع مکمل: https://example.com/extra', { replyTo: 42, updateId: 101 })],
    [item()]
  );
  assert.match(output, /REVIEW_ACTIONS updates=1 callbacks=0 notes=1/);
  assert.match(output, /REVIEW_NOTE id=deadbeef01 chars=\d+ links=1 replaced=0 message=42/);
  assert.match(output, /DRY_NOTIFY یادداشت ثبت شد؛ در بازنویسی بعدی لحاظ می‌شود/);
  assert.match(output, /منبع مکمل/);
  assert.match(output, /handled=1 failed=0/);
});

test('a newer note replaces the old one on the same card', async () => {
  const output = await run(
    [noteUpdate('این را هم لحاظ کن', { replyTo: 42, updateId: 102 })],
    [item({ note: 'یادداشت قدیمی' })]
  );
  assert.match(output, /replaced=1 message=42/);
  assert.match(output, /DRY_NOTIFY یادداشت تازه ثبت شد و جایگزین قبلی شد/);
});

test('a note on an older card finds the item through its previous ids', async () => {
  const output = await run(
    [noteUpdate('منبع قدیمی', { replyTo: 41, updateId: 103 })],
    [item({ messageId: 500, previousMessageIds: [41] })]
  );
  assert.match(output, /REVIEW_NOTE id=deadbeef01/);
  assert.match(output, /message=41/);
});

test('a note for a card not yet saved is queued and then applied on the next run', async () => {
  const queued = await run(
    [noteUpdate('این منبع را ببین https://example.com/late', { replyTo: 77, updateId: 104 })],
    []
  );
  assert.match(queued, /REVIEW_NOTE_PENDING message=77 chars=\d+/);
  assert.match(queued, /DRY_NOTIFY یادداشت ذخیره شد؛ به‌محض ثبت همین کارت/);
  assert.match(queued, /handled=1 failed=0/);

  const applied = await run([], [item()], NOW, {
    pendingNotes: {
      42: {
        text: 'این منبع را ببین https://example.com/late',
        at: '2026-11-14T14:55:00Z',
        actor: 'amir',
        chatId: '-1001',
      },
    },
  });
  assert.match(applied, /REVIEW_NOTE_APPLIED id=deadbeef01 message=42 chars=\d+/);
  assert.match(applied, /DRY_NOTIFY یادداشت ذخیره‌شده روی کارت ثبت شد/);
});

test('a queued note for a closed card is dropped silently', async () => {
  const output = await run([], [item({ status: 'sent' })], NOW, {
    pendingNotes: {
      42: { text: 'دیر رسید', at: '2026-11-14T14:55:00Z', actor: 'amir', chatId: '-1001' },
    },
  });
  assert.doesNotMatch(output, /REVIEW_NOTE_APPLIED/);
  assert.doesNotMatch(output, /REVIEW_NOTE_CLOSED/);
});

test('a message without a reply is ignored without stalling the queue', async () => {
  const output = await run([noteUpdate('سلام', { replyTo: 0, updateId: 105 })], [item()]);
  assert.match(output, /REVIEW_NOTE_IGNORED no_reply/);
  assert.match(output, /handled=0 failed=0/);
  assert.doesNotMatch(output, /REVIEW_NOTE /);
});

test('a message from another chat is never treated as a note', async () => {
  const output = await run(
    [noteUpdate('https://example.com/extra', { replyTo: 42, updateId: 106, chatId: -1002 })],
    [item()]
  );
  assert.doesNotMatch(output, /REVIEW_NOTE/);
  assert.match(output, /handled=0 failed=0/);
});

test('callbacks and notes in one batch are counted and handled in update order', async () => {
  const output = await run(
    [
      noteUpdate('یادداشت همراه', { replyTo: 42, updateId: 108, messageId: 501 }),
      update('x', 'deadbeef01', { extra: 'quality', updateId: 109, messageId: 42 }),
    ],
    [item()]
  );
  assert.match(output, /REVIEW_ACTIONS updates=2 callbacks=1 notes=1/);
  assert.match(output, /REVIEW_REJECTED id=deadbeef01 reason=quality/);
  assert.match(output, /REVIEW_NOTE id=deadbeef01/);
  assert.match(output, /DRY_ANSWER رد شد؛ پیام پاک می‌شود/);
  assert.match(output, /handled=2 failed=0/);
});
