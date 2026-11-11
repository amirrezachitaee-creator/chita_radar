import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const TOKEN_PATTERNS = [
  /\d{8,10}:[A-Za-z0-9_-]{30,}/g,
  /\b(?:sk|gsk|hf|AIza)[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
];

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function loadSecrets(envPath = resolve(ROOT, '.env')) {
  let text = '';
  try {
    text = await readFile(envPath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i))
    .filter((match) => match && SECRET_NAME.test(match[1]) && match[2].length >= 8)
    .map((match) => match[2]);
}

export function maskLine(line, secrets = []) {
  let masked = String(line);
  for (const secret of secrets) masked = masked.split(secret).join('***');
  for (const pattern of TOKEN_PATTERNS) masked = masked.replace(pattern, '***');
  return masked;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const secrets = await loadSecrets();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => process.stdout.write(`${maskLine(line, secrets)}\n`));
}
