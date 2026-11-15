import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMechanicalFixes,
  buildTitleRepairMessage,
  buildUserMessage,
  callWithRetry,
  downloadImage,
  loadEnv,
  makeRedactor,
} from './engine.mjs';
import { deliveredEntries, loadState, markSeen, saveState } from './store.mjs';
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  getUpdates,
  postHtml,
  postText,
  sendTelegram,
  sendText,
} from './telegram.mjs';
import {
  emptyReviewStore,
  keyboardFor,
  loadReviewStore,
  parseReviewCallback,
  pruneReviewStore,
  recordReviewAction,
  rejectKeyboard,
  removeKeyboard,
  REJECT_REASONS,
  rewriteCountForDay,
  saveReviewStore,
  statusKeyboard,
} from './review-items.mjs';
import { draftReviewPost, resolvedImageUrl, toolUsageForItem } from './review-draft.mjs';
import { publishGuards, publishSlotFor, qaForPublish, slotWindowStatus } from './review-publish.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);

const NOW = option('--now', new Date().toISOString());
const SEND = flag('--send');
const ALLOW_SLOT_WINDOW = flag('--allow-slot-window');
const UPDATES_FILE = option('--updates', '');
const MAX_ACTIONS_ARG = option('--max-actions', '');

const config = JSON.parse(await readFile(resolve(ROOT, 'pipeline/config.json'), 'utf8'));
const ACTION_SETTINGS = config.review_actions ?? {};
const REWRITE_CAP = Math.max(1, Number(ACTION_SETTINGS.max_rewrites_per_item ?? 2) || 2);
const REWRITE_DAY_CAP = Math.max(0, Number(ACTION_SETTINGS.max_rewrites_per_day ?? 20) || 0);
const MAX_ACTIONS = Math.max(
  1,
  Number(MAX_ACTIONS_ARG || ACTION_SETTINGS.poll_max_actions || 10) || 10
);

const STATE_PATH = resolve(ROOT, option('--state', 'data/state.json'));
const REVIEW_STATE_PATH = resolve(ROOT, option('--review-state', 'data/state.review.json'));
const FEEDBACK_PATH = resolve(ROOT, option('--review-feedback', 'data/review-feedback.json'));

let env = {};
try {
  env = await loadEnv(resolve(ROOT, '.env'));
} catch {
  if (SEND) {
    console.error('ENV_MISSING');
    process.exit(1);
  }
}
const redact = makeRedactor(env);

const TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const REVIEW_CHAT_ID = String(env[config.offers?.review?.chat_env || 'TELEGRAM_REVIEW_CHAT_ID'] || '');
const CHAT_ID = String(env.TELEGRAM_CHAT_ID || '');
const REVIEW_ENABLED = config.offers?.review?.enabled !== false && ACTION_SETTINGS.enabled !== false;

if (SEND && !REVIEW_ENABLED) {
  console.log('REVIEW_ACTIONS_DISABLED');
  process.exit(0);
}
if (SEND && (!TOKEN || !REVIEW_CHAT_ID || !CHAT_ID)) {
  console.error('TELEGRAM_CREDENTIALS_MISSING');
  process.exit(1);
}

const log = (line) => console.log(redact(line));

let store = emptyReviewStore();
try {
  store = await loadReviewStore(FEEDBACK_PATH);
} catch (error) {
  log(`REVIEW_STORE_LOAD_FAILED ${String(error?.message ?? error)}`);
  if (SEND) process.exit(1);
}

const state = await loadState(STATE_PATH);
const reviewState = await loadState(REVIEW_STATE_PATH);
const delivered = deliveredEntries(
  [
    { lane: 'main', state },
    { lane: 'review', state: reviewState },
  ],
  NOW
);

const persist = async () => {
  if (!SEND) return;
  await saveState(STATE_PATH, state);
  await saveState(REVIEW_STATE_PATH, reviewState);
  await saveReviewStore(FEEDBACK_PATH, store);
};

const persistStore = async () => {
  if (!SEND) return;
  await saveReviewStore(FEEDBACK_PATH, store);
};

function answer(callbackId, text) {
  if (!SEND) {
    log(`DRY_ANSWER ${text}`);
    return Promise.resolve();
  }
  return answerCallbackQuery(callbackId, { token: TOKEN, text }).catch((error) => {
    log(`ANSWER_FAILED ${String(error?.message ?? error)}`);
  });
}

async function notify(text) {
  if (!SEND) {
    log(`DRY_NOTIFY ${text.replace(/\n/g, ' | ')}`);
    return null;
  }
  try {
    const sent = await sendText(text, { token: TOKEN, chatId: REVIEW_CHAT_ID });
    return sent.messageId ?? null;
  } catch (error) {
    log(`REVIEW_NOTIFY_FAILED ${String(error?.message ?? error)}`);
    return null;
  }
}

async function setKeyboard(messageId, keyboard) {
  if (!SEND || !messageId) return;
  try {
    await editMessageReplyMarkup({
      token: TOKEN,
      chatId: REVIEW_CHAT_ID,
      messageId,
      replyMarkup: keyboard ?? removeKeyboard(),
    });
  } catch (error) {
    log(`KEYBOARD_EDIT_FAILED ${messageId} ${String(error?.message ?? error)}`);
  }
}

async function setStatusKeyboard(messageId, text, id) {
  await setKeyboard(messageId, statusKeyboard(id, text));
}

function itemKeysOf(item) {
  return Array.isArray(item?.keys) ? item.keys.filter(Boolean) : [];
}

function markDecision(keys, record) {
  for (const target of [state, reviewState]) {
    for (const key of keys) {
      if (record.decision === 'review_reject' && target.seen?.[key]?.decision === 'publish') continue;
      markSeen(target, [key], record);
    }
  }
}

function importanceOf(body) {
  const before = String(body ?? '').split(/^[ \t]*(?:منبع|لینک استفاده)\s*[:：]/m)[0];
  return before.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean).at(-1) ?? '';
}

function itemOutOfDate(item, query) {
  const message = query?.message ?? {};
  const chatId = String(message.chat?.id ?? '');
  const messageId = Number(message.message_id ?? 0);
  return String(item.chatId) !== chatId || Number(item.messageId) !== messageId;
}

function activeItem(review, query) {
  const item = store.items[review.id];
  if (!item) return { error: 'این مورد پیدا نشد؛ شاید پاک شده باشد.' };
  if (itemOutOfDate(item, query)) return { error: 'این دکمه دیگر معتبر نیست.' };
  if (item.status === 'sent') return { error: 'این مورد قبلاً به کانال اصلی رفته است.' };
  if (item.status === 'rejected') return { error: 'این مورد قبلاً رد شده است.' };
  if (item.status === 'rewriting') {
    const startedAt = Date.parse(item.updatedAt || '');
    if (Number.isFinite(startedAt) && Date.now() - startedAt < 15 * 60000) {
      return { error: 'بازنویسی این مورد در جریان است؛ کمی صبر کن.' };
    }
    item.status = 'pending';
  }
  return { item };
}

function cleanReviewMessage(item) {
  if (!item?.post) return { text: '', html: '' };
  return { text: postText(item.post), html: postHtml(item.post) };
}

async function handleRejectMenu(review, query) {
  const { item, error } = activeItem(review, query);
  if (error) return notify(error);
  await answer(query.id, 'دلیل رد را انتخاب کن.');
  await setKeyboard(item.messageId, rejectKeyboard(item.id));
}

async function handleBack(review, query) {
  const { item, error } = activeItem(review, query);
  if (error) return notify(error);
  await answer(query.id, 'دکمه‌ها برگشتند.');
  await setKeyboard(item.messageId, keyboardFor(item, { rewriteCap: REWRITE_CAP }));
}

async function handleReject(review, query) {
  const { item, error } = activeItem(review, query);
  if (error) return notify(error);
  const reason = REJECT_REASONS[review.extra] ?? review.extra;
  await answer(query.id, 'رد ثبت شد.');
  const at = new Date().toISOString();
  recordReviewAction(store, {
    item,
    action: 'reject',
    actor: query.from?.username || String(query.from?.id ?? ''),
    reason: review.extra,
    detail: item.title,
    at,
  });
  item.status = 'rejected';
  item.updatedAt = at;
  markDecision(itemKeysOf(item), {
    decision: 'review_reject',
    reason: review.extra,
    category: '',
    slot: item.slot,
    title: item.title,
    url: item.url,
  });
  await persist();
  await setStatusKeyboard(item.messageId, '✅ رد شد', item.id);
  log(`REVIEW_REJECTED id=${item.id} reason=${review.extra} | ${item.title}`);
  await notify(`رد شد: ${reason}\n${item.title}`);
  return null;
}

async function handleRewrite(review, query) {
  const { item, error } = activeItem(review, query);
  if (error) return notify(error);
  if (Number(item.rewrites) >= REWRITE_CAP) {
    return notify(`سقف بازنویسی این مورد پر است (${item.rewrites}/${REWRITE_CAP}).`);
  }
  if (REWRITE_DAY_CAP > 0 && rewriteCountForDay(store, NOW) >= REWRITE_DAY_CAP) {
    return notify(`سقف بازنویسی امروز پر است (${REWRITE_DAY_CAP}).`);
  }
  const snapshot = {
    post: item.post,
    qaPass: item.qaPass,
    mainEligible: item.mainEligible,
    rewrites: item.rewrites,
    status: item.status,
    messageId: item.messageId,
    updatedAt: item.updatedAt,
    manual: item.manual,
    reason: item.reason,
  };
  const oldMessageId = item.messageId;
  item.manual = true;
  item.status = 'rewriting';
  await persistStore();
  await answer(query.id, 'بازنویسی شروع شد؛ نتیجه در پیام تازه می‌آید.');
  log(`REVIEW_REWRITE_START id=${item.id} attempt=${Number(item.rewrites) + 1}/${REWRITE_CAP} manual=1`);

  if (!SEND) {
    const next = {
      ...item,
      rewrites: Number(item.rewrites) + 1,
      status: 'pending',
      post: item.post ?? { title: item.title },
    };
    const rows = keyboardFor(next, { rewriteCap: REWRITE_CAP })?.inline_keyboard ?? [];
    log(
      `DRY_REWRITE id=${item.id} rewrites=${item.rewrites}->${next.rewrites} next_keys=${rows
        .map((row) => row.map((button) => button.text).join(' + '))
        .join(' / ')}`
    );
    Object.assign(item, snapshot);
    return null;
  }

  const writer = {
    base: (env.AMD_BASE_URL || 'https://developer.amd.com.cn/radeon/api/v1').replace(/\/$/, ''),
    apiKey: env.AMD_API_KEY || '',
    model: option('--model', 'DeepSeek-V4-Flash'),
    maxTokens: 2600,
    timeoutMs: 150000,
    reasoningEffort: '',
  };
  const system = await readFile(resolve(ROOT, 'bench/system-prompt.md'), 'utf8');
  const result = await draftReviewPost({
    item,
    now: NOW,
    minChars: Number(ACTION_SETTINGS.min_source_chars ?? 320) || 320,
    maxAgeHours: Number(config.freshness_hours?.pre_gate ?? 72) || 72,
    config,
    manual: true,
    request: (story) =>
      callWithRetry(
        {
          base: writer.base,
          apiKey: writer.apiKey,
          model: writer.model,
          system,
          user: buildUserMessage(story),
          maxTokens: writer.maxTokens,
          timeoutMs: writer.timeoutMs,
          reasoningEffort: writer.reasoningEffort,
          redact,
        },
        3,
        log
      ),
    repairTitle: ({ story, parsed, qa }) =>
      callWithRetry(
        {
          base: writer.base,
          apiKey: writer.apiKey,
          model: writer.model,
          system,
          user: buildTitleRepairMessage({ user: buildUserMessage(story), parsed, qa }),
          maxTokens: 800,
          timeoutMs: writer.timeoutMs,
          reasoningEffort: writer.reasoningEffort,
          redact,
        },
        2,
        log
      ),
    log,
  });

  if (!result.post) {
    Object.assign(item, snapshot);
    await persistStore();
    log(
      `REVIEW_REWRITE_FAILED id=${item.id} reason=${result.reason}${
        result.detail ? ` ${result.detail}` : ''
      } cost=$${Number(result.cost ?? 0).toFixed(6)}`
    );
    await notify(
      `دکمهٔ بازنویسی دریافت شد، ولی بازنویسی نشد: ${result.reason}${
        result.detail ? ` (${result.detail})` : ''
      }`
    );
    return null;
  }

  item.post = result.post;
  item.qaPass = result.qa?.pass === true;
  item.mainEligible = item.qaPass;
  item.rewrites = Number(item.rewrites) + 1;
  item.status = 'pending';
  item.reason = 'manual_rewrite';
  item.updatedAt = new Date().toISOString();
  const { text, html } = cleanReviewMessage(item);
  const keyboard = keyboardFor(item, { rewriteCap: REWRITE_CAP });
  let sent;
  try {
    sent = await sendText(html || text, {
      token: TOKEN,
      chatId: REVIEW_CHAT_ID,
      parseMode: html ? 'HTML' : '',
      replyMarkup: keyboard,
    });
  } catch (sendError) {
    Object.assign(item, snapshot);
    await persistStore();
    log(`REVIEW_REWRITE_SEND_FAILED id=${item.id} ${String(sendError?.message ?? sendError)}`);
    await notify('پیش‌نویس تازه فرستاده نشد؛ دکمه‌های قبلی معتبرند.');
    return null;
  }
  item.messageId = sent.messageId ?? oldMessageId;
  recordReviewAction(store, {
    item,
    action: 'rewrite',
    actor: query.from?.username || String(query.from?.id ?? ''),
    detail: `${item.qaPass ? 'qa_pass' : 'qa_failed'} cost=$${Number(result.cost ?? 0).toFixed(6)}`,
    at: item.updatedAt,
  });
  await persistStore();
  await setStatusKeyboard(oldMessageId, '✅ بازنویسی اعمال شد', item.id);
  log(
    `REVIEW_REWRITTEN id=${item.id} attempt=${item.rewrites}/${REWRITE_CAP} manual=1 clean=1 qa=${
      item.qaPass ? 'PASS' : 'FAIL'
    } message=${item.messageId} cost=$${Number(result.cost ?? 0).toFixed(6)} tokens=${result.tokens}`
  );
  return null;
}

async function handlePublish(review, query) {
  const { item, error } = activeItem(review, query);
  if (error) return notify(error);
  if (!item.post) return notify('این مورد نسخهٔ آمادهٔ انتشار ندارد؛ اول بازنویسی کن.');
  const usage = toolUsageForItem(item);
  // Rebuild the tail from the item so an old draft cannot publish its channel name.
  item.post = applyMechanicalFixes(item.post, {
    sourceName: item.sourceName,
    sourceUrl: item.url || item.leadPostUrl || '',
    usageUrl: usage?.url ?? '',
    usageName: usage?.name ?? '',
    imageUrl: resolvedImageUrl(item),
    newsDate: '',
    sourceType: item.sourceType,
  });
  const qa = qaForPublish(item, NOW, config);
  const manual = item.manual === true;
  const verdict = publishGuards({ config, state, item, qa, now: NOW, delivered, manual });
  await answer(query.id, verdict.ok ? 'در حال ارسال به کانال اصلی.' : 'ارسال نشد؛ دلیل در پیام بعدی.');
  if (!verdict.ok) {
    log(`REVIEW_PUBLISH_BLOCKED id=${item.id} reason=${verdict.reason} | ${item.title}`);
    await notify(`ارسال نشد: ${verdict.detail}\n${item.title}`);
    return null;
  }
  if (!SEND) {
    log(
      `DRY_PUBLISH id=${item.id} guard=ok category=${verdict.category} manual=${
        manual ? '1' : '0'
      } title=${item.title}`
    );
    return null;
  }

  let imagePath = '';
  let tempDir = '';
  const imageUrl = resolvedImageUrl(item);
  if (imageUrl) {
    try {
      tempDir = await mkdtemp(resolve(tmpdir(), 'qoder-publish-'));
      imagePath = (await downloadImage(imageUrl, tempDir)).file;
    } catch (imageError) {
      log(`REVIEW_PUBLISH_IMAGE_SKIPPED ${String(imageError?.message ?? imageError)}`);
      imagePath = '';
    }
  }
  let sent;
  try {
    sent = await sendTelegram(item.post, { token: TOKEN, chatId: CHAT_ID, imagePath });
  } catch (sendError) {
    if (imagePath && String(sendError?.message ?? '').startsWith('CAPTION_TOO_LONG')) {
      try {
        sent = await sendTelegram(item.post, { token: TOKEN, chatId: CHAT_ID });
        imagePath = '';
      } catch (retryError) {
        log(`REVIEW_PUBLISH_FAILED id=${item.id} ${String(retryError?.message ?? retryError)}`);
        await notify(`ارسال به کانال اصلی نشد: ${String(retryError?.message ?? retryError)}`);
        return null;
      }
    } else {
      log(`REVIEW_PUBLISH_FAILED id=${item.id} ${String(sendError?.message ?? sendError)}`);
      await notify(`ارسال به کانال اصلی نشد: ${String(sendError?.message ?? sendError)}`);
      return null;
    }
  }

  const slot = publishSlotFor(NOW);
  recordPublished(state, {
    slot,
    category: String(item.post.category ?? ''),
    title: String(item.post.title ?? item.title),
    dedupeKey: item.keys?.[0] ?? '',
    postKey: `${slot}/review/${item.id}`,
    kind: item.kind === 'offer' ? 'offer' : 'news',
    why: importanceOf(item.post.body),
    sourceId: item.source,
    sourceName: item.sourceName || item.source,
    sourceType: item.sourceType || 'telegram_channel',
    benchmark: item.benchmark === true,
    url: item.url,
    sourceTitle: item.title,
    sourceText: item.messageText,
  });
  markDecision(itemKeysOf(item), {
    decision: 'publish',
    reason: 'review_publish',
    category: String(item.post.category ?? ''),
    slot,
    title: String(item.post.title ?? item.title),
    url: item.url,
  });
  item.status = 'sent';
  item.sentAt = new Date().toISOString();
  delivered.push({
    lane: 'main',
    title: String(item.post.title ?? item.title),
    decision: 'publish',
    category: String(item.post.category ?? ''),
    slot,
    benchmark: item.benchmark === true,
    at: Date.now(),
  });
  recordReviewAction(store, {
    item,
    action: 'publish',
    actor: query.from?.username || String(query.from?.id ?? ''),
    detail: `message=${sent.messageId ?? ''} ${imagePath ? 'photo' : 'text'}`,
    at: item.sentAt,
  });
  await persist();
  await setStatusKeyboard(item.messageId, '✅ منتشر شد', item.id);
  log(
    `REVIEW_PUBLISHED id=${item.id} slot=${slot} manual=${manual ? '1' : '0'} message=${
      sent.messageId ?? ''
    } image=${imagePath ? 'yes' : 'no'} | ${item.post.title}`
  );
  await notify(`منتشر شد: ${item.post.title}\n${slot}`);
  return null;
}

async function dispatch(update) {
  const query = update?.callback_query;
  if (!query?.data) return { handled: false };
  const review = parseReviewCallback(query.data);
  if (!review) {
    await answer(query.id, 'این دکمه شناسایی نشد.');
    return { handled: false };
  }
  if (review.action === 's') {
    const item = store.items[review.id];
    const text =
      item?.status === 'sent'
        ? 'این نسخه منتشر شده است.'
        : item?.status === 'rejected'
          ? 'این نسخه رد شده است.'
          : Number(item?.rewrites) > 0
            ? 'این نسخه بازنویسی شده؛ پیام تازه را ببین.'
            : 'این نسخه بسته شده؛ پیام تازه را ببین.';
    await answer(query.id, text);
    return { handled: true };
  }
  if (review.action === 'p') await handlePublish(review, query);
  else if (review.action === 'w') await handleRewrite(review, query);
  else if (review.action === 'x') await handleReject(review, query);
  else if (review.action === 'r') await handleRejectMenu(review, query);
  else await handleBack(review, query);
  return { handled: true };
}

async function main() {
  if (SEND && !ALLOW_SLOT_WINDOW) {
    const window = slotWindowStatus(NOW, config.schedule?.slots ?? []);
    if (window.active) {
      log(`SLOT_WINDOW_SKIP slot=${window.slot} since=${window.since}`);
      return;
    }
  }
  let updates = [];
  if (UPDATES_FILE) {
    const raw = JSON.parse(await readFile(resolve(ROOT, UPDATES_FILE), 'utf8'));
    updates = Array.isArray(raw) ? raw : Array.isArray(raw?.result) ? raw.result : [];
  } else if (SEND) {
    try {
      updates = await getUpdates({
        token: TOKEN,
        offset: Number(store.offset) || 0,
        limit: MAX_ACTIONS,
        timeout: 0,
      });
    } catch (error) {
      log(`GET_UPDATES_FAILED ${String(error?.message ?? error)}`);
      process.exit(1);
    }
  } else {
    log('DRY_NO_UPDATES pass --updates <file> to preview actions');
    return;
  }

  const callbacks = updates.filter((update) => update?.callback_query).slice(0, MAX_ACTIONS);
  log(
    `REVIEW_ACTIONS updates=${updates.length} callbacks=${callbacks.length} offset=${
      Number(store.offset) || 0
    } mode=${SEND ? 'live' : 'dry'}`
  );
  let handled = 0;
  let failed = 0;
  for (const update of callbacks) {
    try {
      const result = await dispatch(update);
      if (result.handled) handled += 1;
    } catch (error) {
      failed += 1;
      log(`REVIEW_ACTION_FAILED ${String(error?.message ?? error)}`);
    }
    if (SEND) {
      store.offset = Math.max(Number(store.offset) || 0, Number(update.update_id) + 1 || 0);
      await persistStore();
    }
  }

  if (!UPDATES_FILE) {
    const maxId = updates.reduce((max, update) => Math.max(max, Number(update.update_id) || 0), 0);
    if (SEND && maxId) {
      store.offset = Math.max(Number(store.offset) || 0, maxId + 1);
      await persistStore();
    }
  }

  const pruned = pruneReviewStore(store, NOW, {
    days: Number(ACTION_SETTINGS.pending_ttl_days ?? 14) || 14,
    actionDays: Number(ACTION_SETTINGS.action_retention_days ?? 90) || 90,
    maxItems: Number(ACTION_SETTINGS.max_items ?? 200) || 200,
  });
  if (SEND) await persistStore();
  log(
    `REVIEW_ACTIONS_DONE handled=${handled} failed=${failed} pruned=${pruned} rewrites_today=${rewriteCountForDay(
      store,
      NOW
    )}`
  );
}

await main();
