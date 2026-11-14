import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function normalizeOcrText(value, maxChars = 1200) {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return maxChars > 0 ? text.slice(0, maxChars).trim() : text;
}

export function ocrTextQuality(value, { minChars = 40, minLetters = 20, minWords = 3 } = {}) {
  const text = normalizeOcrText(value, 0);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const words = text.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length;
  return text.length >= minChars && letters >= minLetters && words >= minWords;
}

export function runTesseract(file, {
  langs = 'eng+fas',
  psm = '3',
  timeoutMs = 45000,
  exec = execFile,
} = {}) {
  return new Promise((resolve, reject) => {
    exec(
      'tesseract',
      [file, 'stdout', '-l', langs, '--psm', String(psm)],
      { timeout: Math.max(1000, Number(timeoutMs) || 45000), maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout ?? ''));
      }
    );
  });
}

export async function ocrImageBuffer(buffer, { maxChars = 1200, ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ocr-'));
  try {
    const file = join(dir, 'image');
    await writeFile(file, buffer);
    const text = await runTesseract(file, options);
    return normalizeOcrText(text, maxChars);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function ocrImageUrl(url, {
  fetchImpl = fetch,
  timeoutMs = 45000,
  maxBytes = MAX_IMAGE_BYTES,
  ...options
} = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: 'image/*' },
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 45000)),
  });
  if (!response.ok) throw new Error(`OCR_IMAGE_HTTP_${response.status}`);
  const type = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`OCR_IMAGE_TYPE_${type || 'unknown'}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('OCR_IMAGE_EMPTY');
  if (bytes.length > maxBytes) throw new Error('OCR_IMAGE_TOO_LARGE');
  return ocrImageBuffer(bytes, { ...options, timeoutMs });
}
