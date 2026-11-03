import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captionLength, deleteMessage, editMessageCaption, sendTelegram, postText, postHtml } from './telegram.mjs';

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
