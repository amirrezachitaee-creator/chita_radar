import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  answerCallbackQuery,
  captionLength,
  deleteMessage,
  editMessageCaption,
  editMessageReplyMarkup,
  editMessageText,
  formatTitle,
  getUpdates,
  sendPhotoUrl,
  sendTelegram,
  sendText,
  postText,
  postHtml,
} from './telegram.mjs';

function startMock() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        url: req.url,
        type: req.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 42 + requests.length, chat: { id: 7 } } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, baseUrl, requests });
    });
  });
}

test('post text is title plus body without extra blank lines', () => {
  assert.equal(postText({ title: 'عنوان', body: 'متن' }), 'عنوان\n\nمتن');
  assert.equal(postText({ title: 'عنوان', body: '' }), 'عنوان');
  assert.equal(postText({ title: 'عنوان', body: 'متن', quote: 'جزئیات' }), 'عنوان\n\nمتن\n\nجزئیات');
});

test('a persian number stays attached to the latin name before it', () => {
  assert.equal(
    formatTitle('OpenAI ۱۱ میلیارد دلار سرمایه جذب کرد'),
    'OpenAI\u200F ۱۱ میلیارد دلار سرمایه جذب کرد'
  );
  assert.equal(formatTitle('Gemini ۳.۵ عرضه شد'), 'Gemini\u200F ۳.۵ عرضه شد');
  assert.equal(formatTitle('مدل GPT-5 عرضه شد'), 'مدل GPT-5 عرضه شد');
  assert.equal(formatTitle('\u200FOpenAI ۱۱ میلیارد'), 'OpenAI\u200F ۱۱ میلیارد');
  assert.equal(formatTitle('۱۱ میلیارد دلار سرمایه'), '۱۱ میلیارد دلار سرمایه');
});

test('the sent html renders the title number on the right side of the latin name', () => {
  const html = postHtml({
    title: 'OpenAI ۱۱ میلیارد دلار سرمایه جذب کرد',
    body: 'متن',
  });
  assert.ok(html.startsWith('<b>\u200FOpenAI\u200F ۱۱ میلیارد دلار سرمایه جذب کرد</b>'));
});

test('an inline command is isolated in a code tag so the caption keeps it intact', () => {
  const command = 'dsh plugin --profile web add @ebony-vinyl/dsh-our-free-model@2.8.5';
  const html = postHtml({
    title: 'پلاگین تازه',
    body: `نصبش ساده است؛ کافیه این دستور رو توی ترمینال بزنی: \`${command}\` و بعد ری‌استارت کنی.`,
  });
  assert.ok(html.includes(`<code>\u2066${command}\u2069</code>`));
  assert.equal(html.includes('`'), false);
  const fenced = postHtml({ title: 'دستور', body: '```\nnpm install x\n```' });
  assert.ok(fenced.includes('<pre>\u2066npm install x\u2069</pre>'));
  assert.equal(captionLength({ title: '', body: 'متن `abc`' }), 'متن abc'.length);
});

test('a quote sits above the source line', () => {
  const post = {
    title: 'عنوان',
    body: 'متن اصلی\n\nمنبع: [منبع](https://example.com/a)',
    quote: 'جزئیات',
  };
  assert.equal(
    postText(post),
    'عنوان\n\nمتن اصلی\n\nجزئیات\n\nمنبع: [منبع](https://example.com/a)'
  );
  const html = postHtml(post);
  const quoteAt = html.indexOf('<blockquote');
  const sourceAt = html.indexOf('منبع:');
  assert.ok(quoteAt > 0);
  assert.ok(quoteAt < sourceAt);
});

test('a usage-link tail stays last with the quote and conclusion above it', () => {
  const post = {
    title: 'ابزار تازه',
    body: 'لید ابزار\n\nنتیجه و اهمیت\n\nلینک استفاده: [gemini.google.com](https://gemini.google.com/)',
    quote: 'جزئیات تکمیلی',
  };
  assert.equal(
    postText(post),
    'ابزار تازه\n\nلید ابزار\n\nجزئیات تکمیلی\n\nنتیجه و اهمیت\n\nلینک استفاده: [gemini.google.com](https://gemini.google.com/)'
  );
  const html = postHtml(post);
  const quoteAt = html.indexOf('<blockquote');
  const conclusionAt = html.indexOf('نتیجه و اهمیت');
  const usageAt = html.lastIndexOf('لینک استفاده:');
  assert.ok(quoteAt > 0);
  assert.ok(conclusionAt > quoteAt);
  assert.ok(usageAt > conclusionAt);
});

test('the clean rewrite preview keeps no review chrome and ends with the usage tail', () => {
  const post = {
    title: 'ابزار تازه',
    body: 'لید ابزار\n\nنتیجه و اهمیت\n\nلینک استفاده: [ابزار](https://example.com/tool)',
  };
  const text = postText(post);
  const html = postHtml(post);
  for (const chrome of [
    'نیازمند بررسی و انتشار در کانال اصلی',
    'این نسخه پیش‌نویس است',
    'دلیل:',
    'چک‌لیست قبل از ارسال',
    'از دکمه‌های زیر پیام',
    'لینک منبع',
    'پست تلگرام',
  ]) {
    assert.equal(text.includes(chrome), false, chrome);
    assert.equal(html.includes(chrome), false, chrome);
  }
  assert.ok(text.endsWith('لینک استفاده: [ابزار](https://example.com/tool)'));
  assert.ok(html.includes('لینک استفاده: <a href="https://example.com/tool">ابزار</a>'));
});

test('with a quote, the conclusion paragraph sits after the quote and before the source', () => {
  const post = {
    title: 'عنوان',
    body: 'لید و روایت اصلی\n\nجزئیات بدنه\n\nنتیجه و اهمیت',
    quote: 'جزئیات تکمیلی',
  };
  assert.equal(
    postText(post),
    'عنوان\n\nلید و روایت اصلی\n\nجزئیات بدنه\n\nجزئیات تکمیلی\n\nنتیجه و اهمیت'
  );
  const withSource = {
    ...post,
    body: `${post.body}\n\nمنبع: [منبع](https://example.com/a)`,
  };
  assert.equal(
    postText(withSource),
    'عنوان\n\nلید و روایت اصلی\n\nجزئیات بدنه\n\nجزئیات تکمیلی\n\nنتیجه و اهمیت\n\nمنبع: [منبع](https://example.com/a)'
  );
  const html = postHtml(withSource);
  const quoteAt = html.indexOf('<blockquote');
  const conclusionAt = html.indexOf('نتیجه و اهمیت');
  const sourceAt = html.indexOf('منبع:');
  assert.ok(quoteAt > 0);
  assert.ok(conclusionAt > quoteAt);
  assert.ok(sourceAt > conclusionAt);
});

test('without a quote the body keeps its paragraph order', () => {
  const post = {
    title: 'عنوان',
    body: 'لید و روایت اصلی\n\nجزئیات بدنه\n\nنتیجه و اهمیت\n\nمنبع: [منبع](https://example.com/a)',
  };
  assert.equal(
    postText(post),
    'عنوان\n\nلید و روایت اصلی\n\nجزئیات بدنه\n\nنتیجه و اهمیت\n\nمنبع: [منبع](https://example.com/a)'
  );
});

test('a single-paragraph body stays above the quote', () => {
  const post = {
    title: 'عنوان',
    body: 'متن اصلی\n\nمنبع: [منبع](https://example.com/a)',
    quote: 'جزئیات',
  };
  assert.equal(
    postText(post),
    'عنوان\n\nمتن اصلی\n\nجزئیات\n\nمنبع: [منبع](https://example.com/a)'
  );
});

test('post html bolds the title, keeps links clickable, and cleans bullets', () => {
  const html = postHtml({
    title: 'عنوان <تست>',
    body: '- یک مورد\nمنبع: [TechCrunch](https://example.com/a?x=1&y=2)',
  });
  assert.equal(
    html,
    '<b>\u200Fعنوان &lt;تست&gt;</b>\n\n\u200F• یک مورد\n\u200Fمنبع: <a href="https://example.com/a?x=1&amp;y=2">TechCrunch</a>'
  );
});

test('visible caption length ignores the link target and html tags', () => {
  const post = { title: 'عنوان', body: 'منبع: [TechCrunch](https://example.com/very/long/path)' };
  assert.equal(captionLength(post), 'عنوان\n\nمنبع: TechCrunch'.length);
});

test('text post uses sendMessage with HTML parse mode', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await sendTelegram(
      { title: 'عنوان تست', body: 'متن تست' },
      { token: 'TEST', chatId: '1', baseUrl }
    );
    assert.equal(result.method, 'sendMessage');
    assert.equal(result.messageId, 43);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/botTEST/sendMessage');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '1');
    assert.equal(payload.parse_mode, 'HTML');
    assert.equal(payload.text, '<b>\u200Fعنوان تست</b>\n\n\u200Fمتن تست');
  } finally {
    server.close();
  }
});

test('image post uses sendPhoto with HTML caption and parse mode', async () => {
  const { server, baseUrl, requests } = await startMock();
  const dir = await mkdtemp(join(tmpdir(), 'qoder-photo-'));
  const imagePath = join(dir, 'image.png');
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const result = await sendTelegram(
      { title: 'عنوان', body: 'متن همراه تصویر' },
      { token: 'TEST', chatId: '1', baseUrl, imagePath }
    );
    assert.equal(result.method, 'sendPhoto');
    assert.equal(requests[0].url, '/botTEST/sendPhoto');
    assert.match(requests[0].type, /^multipart\/form-data; boundary=/);
    const body = requests[0].body.toString('utf8');
    assert.ok(body.includes('name="chat_id"'));
    assert.ok(body.includes('name="caption"'));
    assert.ok(body.includes('name="parse_mode"'));
    assert.ok(body.includes('HTML'));
    assert.ok(body.includes('<b>\u200Fعنوان</b>'));
    assert.ok(body.includes('\u200Fمتن همراه تصویر'));
    assert.ok(body.includes('name="photo"'));
    assert.ok(body.includes('filename="image.png"'));
  } finally {
    server.close();
  }
});

test('extra detail stays inside the same text post', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await sendTelegram(
      { title: 'عنوان', body: 'متن اصلی', quote: 'توضیح مفصل‌تر در کتیشن' },
      { token: 'TEST', chatId: '1', baseUrl }
    );
    assert.equal(result.method, 'sendMessage');
    assert.equal(requests.length, 1);
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.parse_mode, 'HTML');
    assert.ok(payload.text.includes('<blockquote expandable>'));
    assert.ok(payload.text.includes('توضیح مفصل‌تر در کتیشن'));
    assert.equal('reply_parameters' in payload, false);
  } finally {
    server.close();
  }
});

test('extra detail stays inside the image caption', async () => {
  const { server, baseUrl, requests } = await startMock();
  const dir = await mkdtemp(join(tmpdir(), 'qoder-photo-quote-'));
  const imagePath = join(dir, 'image.png');
  await writeFile(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
  try {
    const result = await sendTelegram(
      { title: 'عنوان', body: 'متن اصلی', quote: 'توضیح کوتاه' },
      { token: 'TEST', chatId: '1', baseUrl, imagePath }
    );
    assert.equal(result.method, 'sendPhoto');
    assert.equal(requests.length, 1);
    const body = requests[0].body.toString('utf8');
    assert.ok(body.includes('<blockquote expandable>'));
    assert.ok(body.includes('توضیح کوتاه'));
    assert.equal(body.includes('reply_parameters'), false);
  } finally {
    server.close();
  }
});

test('editing a caption uses editMessageCaption with HTML parse mode', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await editMessageCaption('<b>عنوان</b>\n\nمتن', {
      token: 'TEST',
      chatId: '1',
      messageId: 2,
      baseUrl,
    });
    assert.equal(result.method, 'editMessageCaption');
    assert.equal(requests[0].url, '/botTEST/editMessageCaption');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '1');
    assert.equal(payload.message_id, 2);
    assert.equal(payload.parse_mode, 'HTML');
    assert.equal(payload.caption, '<b>عنوان</b>\n\nمتن');
  } finally {
    server.close();
  }
});

test('editing text can replace the card and remove its keyboard', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await editMessageText('<b>✅ منتشر شد</b>\n\nمتن', {
      token: 'TEST',
      chatId: '1',
      messageId: 4,
      baseUrl,
      parseMode: 'HTML',
      replyMarkup: { inline_keyboard: [] },
    });
    assert.equal(result.method, 'editMessageText');
    assert.equal(result.messageId, 43);
    assert.equal(requests[0].url, '/botTEST/editMessageText');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '1');
    assert.equal(payload.message_id, 4);
    assert.equal(payload.parse_mode, 'HTML');
    assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
    assert.equal(payload.text, '<b>✅ منتشر شد</b>\n\nمتن');
  } finally {
    server.close();
  }
});

test('deleting a message uses deleteMessage with chat and message ids', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await deleteMessage(3, { token: 'TEST', chatId: '1', baseUrl });
    assert.equal(result.method, 'deleteMessage');
    assert.equal(requests[0].url, '/botTEST/deleteMessage');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '1');
    assert.equal(payload.message_id, 3);
  } finally {
    server.close();
  }
});

test('a caption above the Telegram limit is rejected before sending', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    await assert.rejects(
      sendTelegram(
        { title: 'عنوان', body: 'x'.repeat(1100) },
        { token: 'TEST', chatId: '1', baseUrl, imagePath: 'does-not-matter.png' }
      ),
      /CAPTION_TOO_LONG/
    );
    assert.equal(requests.length, 0);
  } finally {
    server.close();
  }
});

test('missing credentials fail before any network call', async () => {
  await assert.rejects(sendTelegram({ title: 'a', body: 'b' }, { token: '', chatId: '1' }), /TOKEN_MISSING/);
  await assert.rejects(sendTelegram({ title: 'a', body: 'b' }, { token: 'x', chatId: '' }), /CHAT_ID_MISSING/);
});

test('photo by URL sends the caption as JSON without a download', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await sendPhotoUrl('متن آموزش', 'https://example.com/a.jpg', {
      token: 'TEST',
      chatId: '1',
      baseUrl,
    });
    assert.equal(result.method, 'sendPhoto');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/botTEST/sendPhoto');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '1');
    assert.equal(payload.photo, 'https://example.com/a.jpg');
    assert.equal(payload.caption, 'متن آموزش');
    assert.equal(payload.disable_web_page_preview, true);
    assert.equal('parse_mode' in payload, false);
    assert.equal('reply_markup' in payload, false);
  } finally {
    server.close();
  }
});

test('photo by URL can carry a delete keyboard', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    await sendPhotoUrl('متن آموزش', 'https://example.com/a.jpg', {
      token: 'TEST',
      chatId: '1',
      baseUrl,
      replyMarkup: { inline_keyboard: [] },
    });
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
  } finally {
    server.close();
  }
});

test('photo by URL rejects an empty address or an oversized caption', async () => {
  await assert.rejects(
    sendPhotoUrl('متن', '', { token: 'TEST', chatId: '1' }),
    /EMPTY_PHOTO/
  );
  await assert.rejects(
    sendPhotoUrl('x'.repeat(1025), 'https://example.com/a.jpg', { token: 'TEST', chatId: '1' }),
    /CAPTION_TOO_LONG/
  );
});

test('a reset or connection-phase network error is marked retryable', async () => {
  const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const fetchImpl = async () => {
    throw failure;
  };
  await assert.rejects(
    sendTelegram({ title: 'عنوان', body: 'متن' }, { token: 'TEST', chatId: '1', fetchImpl }),
    (error) => error.message === 'TELEGRAM_REQUEST_FAILED' && error.retryable === true
  );

  const nested = Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([{ code: 'ECONNREFUSED' }], 'connect'),
  });
  await assert.rejects(
    sendTelegram(
      { title: 'عنوان', body: 'متن' },
      { token: 'TEST', chatId: '1', fetchImpl: async () => { throw nested; } }
    ),
    (error) => error.message === 'TELEGRAM_REQUEST_FAILED' && error.retryable === true
  );

  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  await assert.rejects(
    sendTelegram(
      { title: 'عنوان', body: 'متن' },
      { token: 'TEST', chatId: '1', fetchImpl: async () => { throw reset; } }
    ),
    (error) => error.message === 'TELEGRAM_REQUEST_FAILED' && error.retryable === true
  );
});

test('an ambiguous network error or a timeout is not retried', async () => {
  const denied = Object.assign(new TypeError('fetch failed'), { cause: { code: 'EACCES' } });
  await assert.rejects(
    sendTelegram(
      { title: 'عنوان', body: 'متن' },
      { token: 'TEST', chatId: '1', fetchImpl: async () => { throw denied; } }
    ),
    (error) => error.message === 'TELEGRAM_REQUEST_FAILED' && error.retryable === false
  );

  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  await assert.rejects(
    sendTelegram(
      { title: 'عنوان', body: 'متن' },
      { token: 'TEST', chatId: '1', fetchImpl: async () => { throw aborted; } }
    ),
    (error) => error.message === 'TELEGRAM_TIMEOUT' && error.retryable !== true
  );
});

test('a server error from Telegram is retryable', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    sendTelegram({ title: 'عنوان', body: 'متن' }, { token: 'TEST', chatId: '1', fetchImpl }),
    (error) => error.message.startsWith('TELEGRAM_502') && error.retryable === true
  );
});

test('a rate limit carries the server wait time and is retryable', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } }
    );
  await assert.rejects(
    sendTelegram({ title: 'عنوان', body: 'متن' }, { token: 'TEST', chatId: '1', fetchImpl }),
    (error) =>
      error.message.startsWith('TELEGRAM_429') &&
      error.retryable === true &&
      error.retryAfter === 7
  );
});

test('review text can carry an inline keyboard', async () => {
  const { server, baseUrl, requests } = await startMock();
  const keyboard = {
    inline_keyboard: [
      [
        { text: 'رد', callback_data: 'rv1|r|a1b2c3d4e5' },
        { text: 'بازنویسی', callback_data: 'rv1|w|a1b2c3d4e5' },
      ],
    ],
  };
  try {
    await sendText('متن بازبینی', {
      token: 'TEST',
      chatId: '1',
      baseUrl,
      parseMode: 'HTML',
      replyMarkup: keyboard,
    });
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(payload.reply_markup, keyboard);
    assert.equal(payload.parse_mode, 'HTML');
  } finally {
    server.close();
  }
});

test('getUpdates reads only callback queries with the stored offset', async () => {
  let requested = '';
  const fetchImpl = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({
      ok: true,
      result: [{ update_id: 13, callback_query: { id: 'cb' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const updates = await getUpdates({
    token: 'TEST',
    offset: 12,
    limit: 10,
    timeout: 0,
    fetchImpl,
  });
  const parsed = new URL(requested);
  assert.equal(parsed.pathname, '/botTEST/getUpdates');
  assert.equal(parsed.searchParams.get('offset'), '12');
  assert.equal(parsed.searchParams.get('limit'), '10');
  assert.equal(parsed.searchParams.get('timeout'), '0');
  assert.equal(parsed.searchParams.get('allowed_updates'), '["callback_query"]');
  assert.deepEqual(updates, [{ update_id: 13, callback_query: { id: 'cb' } }]);
});

test('a getUpdates conflict is not retried', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    getUpdates({ token: 'TEST', fetchImpl }),
    (error) => error.message.startsWith('TELEGRAM_409') && error.retryable !== true
  );
});

test('answering a callback query truncates the toast and flags alerts', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await answerCallbackQuery('cb-1', {
      token: 'TEST',
      text: 'x'.repeat(250),
      showAlert: true,
      baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(requests[0].url, '/botTEST/answerCallbackQuery');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.callback_query_id, 'cb-1');
    assert.equal(payload.text.length, 200);
    assert.equal(payload.show_alert, true);
  } finally {
    server.close();
  }
  await assert.rejects(answerCallbackQuery('', { token: 'TEST' }), /CALLBACK_ID_MISSING/);
});

test('removing the review keyboard sends an empty inline keyboard', async () => {
  const { server, baseUrl, requests } = await startMock();
  try {
    const result = await editMessageReplyMarkup({
      token: 'TEST',
      chatId: '-1001',
      messageId: 9,
      baseUrl,
    });
    assert.equal(result.method, 'editMessageReplyMarkup');
    assert.equal(requests[0].url, '/botTEST/editMessageReplyMarkup');
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.equal(payload.chat_id, '-1001');
    assert.equal(payload.message_id, 9);
    assert.deepEqual(payload.reply_markup, { inline_keyboard: [] });
  } finally {
    server.close();
  }
});

test('a replacement review keyboard keeps the item callback ids', async () => {
  const { server, baseUrl, requests } = await startMock();
  const keyboard = {
    inline_keyboard: [[{ text: 'ارسال به کانال اصلی', callback_data: 'rv1|p|a1b2c3d4e5' }]],
  };
  try {
    await editMessageReplyMarkup({
      token: 'TEST',
      chatId: '-1001',
      messageId: 9,
      baseUrl,
      replyMarkup: keyboard,
    });
    const payload = JSON.parse(requests[0].body.toString('utf8'));
    assert.deepEqual(payload.reply_markup, keyboard);
  } finally {
    server.close();
  }
});
