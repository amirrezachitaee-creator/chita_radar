import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
const RLM = '\u200F';

export function postText(post) {
  const head = [post?.title, post?.news_date].filter(Boolean).join('\n');
  return [head, post?.body].filter(Boolean).join('\n\n');
}

export function captionLength(post) {
  return String(postText(post))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\u200F/g, '')
    .length;
}

function escapeHtml(value) {
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
  const title = String(post?.title ?? '').trim();
  const date = String(post?.news_date ?? '').trim();
  const body = formatBodyHtml(post?.body ?? '');
  const head = [
    title ? `<b>${RLM}${escapeHtml(title)}</b>` : '',
    date ? `${RLM}${escapeHtml(date)}` : '',
  ].filter(Boolean).join('\n');
  return [head, body].filter(Boolean).join('\n\n');
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
    throw new Error(`TELEGRAM_${response.status}_${String(json?.description ?? '').slice(0, 120)}`.trim());
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
    throw new Error(error?.name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_REQUEST_FAILED');
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
    throw new Error(error?.name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_REQUEST_FAILED');
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
    throw new Error(error?.name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

async function attachQuote(result, quote, options) {  if (!quote) return result;
  try {
    const html = `<blockquote expandable>${formatBodyHtml(quote)}</blockquote>`;
    const sent = await sendText(html, {
      ...options,
      parseMode: 'HTML',
      replyTo: result.messageId,
    });
    return { ...result, quoteMessageId: sent.messageId };
  } catch (error) {
    return { ...result, quoteError: String(error?.message ?? error) };
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
  const quote = String(post?.quote ?? '').trim();
  const options = { token, chatId, baseUrl, timeoutMs, fetchImpl };

  if (!imagePath) {
    if (captionLength(post) > TELEGRAM_MESSAGE_LIMIT) throw new Error('MESSAGE_TOO_LONG');
    const sent = await sendText(text, { ...options, parseMode: 'HTML' });
    return attachQuote(sent, quote, options);
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
    const sent = await readResult(response, 'sendPhoto');
    return attachQuote(sent, quote, options);
  } catch (error) {
    if (error?.message?.startsWith('TELEGRAM_')) throw error;
    throw new Error(error?.name === 'AbortError' ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_REQUEST_FAILED');
  } finally {
    clearTimeout(timer);
  }
}
