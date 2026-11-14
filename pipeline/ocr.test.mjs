import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import {
  normalizeOcrText,
  ocrTextQuality,
  runTesseract,
  ocrImageBuffer,
  ocrImageUrl,
} from './ocr.mjs';

test('ocr text is normalized and capped', () => {
  assert.equal(
    normalizeOcrText('  OpenAI\r\n\r\n\r\n  GPT-5\tصدر جدول\r\n'),
    'OpenAI\n\nGPT-5 صدر جدول'
  );
  assert.equal(normalizeOcrText('abcdef', 4), 'abcd');
  assert.equal(normalizeOcrText(null), '');
});

test('quality gate rejects symbols and short noise but keeps real chart text', () => {
  assert.equal(ocrTextQuality('!!! 12345 --- ???'), false);
  assert.equal(ocrTextQuality('مدل تازه'), false);
  assert.equal(
    ocrTextQuality('دیپ‌سیک مدل تازه‌ای منتشر کرد که در جدول امتیازهای بنچمارک بالا آمد'),
    true
  );
});

test('tesseract runs with the configured languages and page segmentation', async () => {
  let seen;
  const exec = (file, args, options, callback) => {
    seen = { file, args, options };
    callback(null, 'متن آزمایشی\n');
  };
  const text = await runTesseract('/tmp/image.png', {
    langs: 'eng+fas',
    psm: 6,
    timeoutMs: 5000,
    exec,
  });
  assert.equal(text, 'متن آزمایشی\n');
  assert.equal(seen.file, 'tesseract');
  assert.deepEqual(seen.args, ['/tmp/image.png', 'stdout', '-l', 'eng+fas', '--psm', '6']);
  assert.equal(seen.options.timeout, 5000);
});

test('a missing engine surfaces ENOENT for the caller to classify', async () => {
  const exec = (file, args, options, callback) => {
    const error = new Error('spawn tesseract ENOENT');
    error.code = 'ENOENT';
    callback(error);
  };
  await assert.rejects(() => runTesseract('/tmp/image.png', { exec }), /ENOENT/);
});

test('image buffers are written to a temp file, read once and removed', async () => {
  let tempFile = '';
  let written = '';
  const exec = (command, args, options, callback) => {
    tempFile = args[0];
    readFile(args[0])
      .then((buffer) => {
        written = buffer.toString();
        callback(null, 'OpenAI GPT-5 صدر جدول شد');
      })
      .catch(callback);
  };
  const text = await ocrImageBuffer(Buffer.from('fake-image'), { exec, maxChars: 12 });
  assert.equal(text, 'OpenAI GPT-5');
  assert.equal(written, 'fake-image');
  await assert.rejects(() => access(tempFile), /ENOENT/);
});

test('image urls are fetched with an image content type and passed to OCR', async () => {
  const urls = [];
  const fetchImpl = async (url, options) => {
    urls.push({ url, accept: options?.headers?.accept });
    return new Response(Buffer.from('fake-image'), {
      status: 200,
      headers: { 'content-type': 'image/jpeg; charset=binary' },
    });
  };
  let written = '';
  const exec = (command, args, options, callback) => {
    readFile(args[0])
      .then((buffer) => {
        written = buffer.toString();
        callback(null, 'خبر تازه مدل هوش مصنوعی در جدول امتیازها');
      })
      .catch(callback);
  };
  const text = await ocrImageUrl('https://cdn.example.com/chart.jpg', { fetchImpl, exec });
  assert.equal(text, 'خبر تازه مدل هوش مصنوعی در جدول امتیازها');
  assert.equal(written, 'fake-image');
  assert.deepEqual(urls, [{ url: 'https://cdn.example.com/chart.jpg', accept: 'image/*' }]);
});

test('non-image responses and oversized buffers are rejected before OCR', async () => {
  const html = async () =>
    new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(
    () => ocrImageUrl('https://cdn.example.com/page', { fetchImpl: html }),
    /OCR_IMAGE_TYPE_text\/html/
  );

  const missing = async () => new Response('', { status: 404 });
  await assert.rejects(
    () => ocrImageUrl('https://cdn.example.com/missing.jpg', { fetchImpl: missing }),
    /OCR_IMAGE_HTTP_404/
  );

  const big = async () =>
    new Response(Buffer.alloc(8), { status: 200, headers: { 'content-type': 'image/png' } });
  await assert.rejects(
    () => ocrImageUrl('https://cdn.example.com/big.png', { fetchImpl: big, maxBytes: 4 }),
    /OCR_IMAGE_TOO_LARGE/
  );
});
