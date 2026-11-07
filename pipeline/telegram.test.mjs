import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captionLength,
  deleteMessage,
  editMessageCaption,
  formatTitle,
  sendPhotoUrl,
  sendTelegram,
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

test('a connection-phase network error is marked retryable', async () => {
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
});

test('an ambiguous network error or a timeout is not retried', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  await assert.rejects(
    sendTelegram(
      { title: 'عنوان', body: 'متن' },
      { token: 'TEST', chatId: '1', fetchImpl: async () => { throw reset; } }
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
