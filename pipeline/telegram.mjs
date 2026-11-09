import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
const RLM = '\u200F';

const RETRYABLE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ETIMEDOUT',
]);

function networkCode(error) {
  const seen = new Set();
  const queue = [error, error?.cause];
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === 'string' && current.code) return current.code;
    if (Array.isArray(current.errors)) queue.push(...current.errors);
    if (current.cause) queue.push(current.cause);
  }
  return '';
}

function telegramRequestError(error) {
  if (error?.name === 'AbortError') return new Error('TELEGRAM_TIMEOUT');
  const wrapped = new Error('TELEGRAM_REQUEST_FAILED');
  wrapped.retryable = RETRYABLE_NETWORK_CODES.has(networkCode(error));
  return wrapped;
}

function splitSource(body) {
  const text = String(body ?? '').trimEnd();
  if (!text) return { body: '', source: '', separator: '\n\n' };
  const lines = text.split('\n');
  const lastIndex = lines.findLastIndex((line) => line.trim());
  if (lastIndex < 0 || !/^(?:منبع|لینک استفاده)\s*[:：]/u.test(lines[lastIndex].trim())) {
    return { body: text, source: '', separator: '\n\n' };
  }
  const before = lines.slice(0, lastIndex).join('\n').trimEnd();
  const separator = !before || !lines[lastIndex - 1]?.trim() ? '\n\n' : '\n';
  return {
    body: before,
    source: lines[lastIndex].trim(),
    separator,
  };
}

function splitConclusion(body, hasQuote) {
  if (!hasQuote) return { lead: body, conclusion: '' };
  const parts = String(body ?? '').split(/\n{2,}/);
  if (parts.length < 2) return { lead: body, conclusion: '' };
  return { lead: parts.slice(0, -1).join('\n\n'), conclusion: parts.at(-1) };
}

export function postText(post) {
  const head = [formatTitle(post?.title), post?.news_date].filter(Boolean).join('\n\n');
  const { body, source, separator } = splitSource(post?.body);
  const quote = String(post?.quote ?? '').trim();
  const { lead, conclusion } = splitConclusion(body, Boolean(quote));
  const main = [head, lead, quote, conclusion].filter(Boolean).join('\n\n');
  return source ? `${main}${separator}${source}` : main;
}

export function captionLength(post) {
  return String(postText(post))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u200F/g, '')
    .length;
}

const PERSIAN_DIGITS = /[\u06F0-\u06F9\u0660-\u0669]/;

export function formatTitle(value) {
  return String(value ?? '')
    .replace(/^\u200F+/, '')
    .trim()
    .replace(/([A-Za-z][A-Za-z0-9.+#&'’-]*)(\s*)(?=[\u06F0-\u06F9\u0660-\u0669])/gu, '$1\u200F$2');
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatBodyHtml(body) {
  const html = escapeHtml(String(body ?? ''))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^[ \t]*[-–•][ \t]+/gm, '• ')
    .trim();
  return html
    .split('\n')
    .map((line) => (line.trim() ? `${RLM}${line.replace(/^\u200F+/, '')}` : line))
    .join('\n');
}

export function postHtml(post) {
  const title = formatTitle(post?.title);
  const date = String(post?.news_date ?? '').trim();
  const { body, source, separator } = splitSource(post?.body);
  const quote = String(post?.quote ?? '').trim();
  const { lead, conclusion } = splitConclusion(body, Boolean(quote));
  const bodyHtml = formatBodyHtml(lead);
  const conclusionHtml = formatBodyHtml(conclusion);
  const sourceHtml = formatBodyHtml(source);
  const head = [
    title ? `<b>${RLM}${escapeHtml(title)}</b>` : '',
    date ? `${RLM}${escapeHtml(date)}` : '',
  ].filter(Boolean).join('\n\n');
  const quoteHtml = quote ? `<blockquote expandable>${formatBodyHtml(quote)}</blockquote>` : '';
  const main = [head, bodyHtml, quoteHtml, conclusionHtml].filter(Boolean).join('\n\n');
  return sourceHtml ? `${main}${separator}${sourceHtml}` : main;
}

function mimeFor(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}

async function readResult(response, method) {
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    const error = new Error(`TELEGRAM_${response.status}_${String(json?.description ?? '').slice(0, 120)}`.trim());
    if (response.status === 429 || response.status >= 500) {
      error.retryable = true;
      error.retryAfter = Number(json?.parameters?.retry_after) || 0;
    }
    throw error;
  }
  return {
    method,
    messageId: json.result?.message_id ?? null,
    chatId: json.result?.chat?.id ?? null,
  };
}

export async function sendText(text, {
  token,
  chatId,
  baseUrl = 'https://api.telegram.org',
  timeoutMs = 30000,
  fetchImpl = fetch,
  parseMode = '',
  replyTo = 0,
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID_MISSING');
  if (!String(text ?? '').trim()) throw new Error('EMPTY_POST');

  const payload = { chat_id: chatId, text, disable_web_page_preview: false };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };

  const url = `${baseUrl.replace(/\/$/, '')}/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await readResult(response, 'sendMessage');
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_') || error?.message === 'EMPTY_POST') throw error;
    throw telegramRequestError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function editMessageCaption(caption, {
  token,
  chatId,
  messageId,
  baseUrl = 'https://api.telegram.org',
  timeoutMs = 30000,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID_MISSING');
  if (!messageId) throw new Error('TELEGRAM_MESSAGE_ID_MISSING');
  if (!String(caption ?? '').trim()) throw new Error('EMPTY_POST');

  const url = `${baseUrl.replace(/\/$/, '')}/bot${token}/editMessageCaption`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        caption,
        parse_mode: 'HTML',
      }),
      signal: controller.signal,
    });
    return await readResult(response, 'editMessageCaption');
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_') || error?.message === 'EMPTY_POST') throw error;
    throw telegramRequestError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteMessage(messageId, {
  token,
  chatId,
  baseUrl = 'https://api.telegram.org',
  timeoutMs = 30000,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID_MISSING');
  if (!messageId) throw new Error('TELEGRAM_MESSAGE_ID_MISSING');

  const url = `${baseUrl.replace(/\/$/, '')}/bot${token}/deleteMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.ok) {
      throw new Error(`TELEGRAM_${response.status}_${String(json?.description ?? '').slice(0, 120)}`.trim());
    }
    return { method: 'deleteMessage', messageId: Number(messageId) };
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_')) throw error;
    throw telegramRequestError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendPhotoUrl(caption, photoUrl, {
  token,
  chatId,
  baseUrl = 'https://api.telegram.org',
  timeoutMs = 30000,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID_MISSING');
  if (!String(photoUrl ?? '').trim()) throw new Error('EMPTY_PHOTO');
  if (!String(caption ?? '').trim()) throw new Error('EMPTY_POST');
  if (String(caption).length > TELEGRAM_CAPTION_LIMIT) throw new Error('CAPTION_TOO_LONG');

  const url = `${baseUrl.replace(/\/$/, '')}/bot${token}/sendPhoto`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: String(photoUrl),
        caption: String(caption),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    return await readResult(response, 'sendPhoto');
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_') || error?.message === 'EMPTY_POST' || error?.message === 'EMPTY_PHOTO') {
      throw error;
    }
    throw telegramRequestError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTelegram(post, {
  token,
  chatId,
  imagePath = '',
  baseUrl = 'https://api.telegram.org',
  timeoutMs = 30000,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  if (!chatId) throw new Error('TELEGRAM_CHAT_ID_MISSING');
  const text = postHtml(post);
  if (!text.trim()) throw new Error('EMPTY_POST');

  if (!imagePath) {
    if (captionLength(post) > TELEGRAM_MESSAGE_LIMIT) throw new Error('MESSAGE_TOO_LONG');
    return sendText(text, { token, chatId, baseUrl, timeoutMs, fetchImpl, parseMode: 'HTML' });
  }

  if (captionLength(post) > TELEGRAM_CAPTION_LIMIT) throw new Error('CAPTION_TOO_LONG');
  const url = `${baseUrl.replace(/\/$/, '')}/bot${token}/sendPhoto`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const buffer = await readFile(imagePath);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', text);
    form.set('parse_mode', 'HTML');
    form.set('photo', new Blob([buffer], { type: mimeFor(imagePath) }), basename(imagePath));
    const response = await fetchImpl(url, { method: 'POST', body: form, signal: controller.signal });
    return await readResult(response, 'sendPhoto');
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_')) throw error;
    throw telegramRequestError(error);
  } finally {
    clearTimeout(timer);
  }
}
