import path from 'node:path';
import { isSensitiveProjectPath } from './artifact-policy.js';

export const SECRET_FILE_REDACTION = '[REDACTED: secrets file]';

const VALUE_REDACTION = '[REDACTED]';
const PRIVATE_KEY_REDACTION = '[REDACTED: private key]';

const SENSITIVE_JSON_KEY_PATTERN =
  /^(?:private[_-]?key|secret|api[_-]?key|password|client_secret|refresh_token|access_token|id_token|auth_provider_x509_cert_url)$/i;

const PEM_BLOCK_PATTERN =
  /-----BEGIN [^-]*(?:PRIVATE KEY|SECRET KEY|OPENSSH PRIVATE KEY)[\s\S]*?-----END [^-]*(?:PRIVATE KEY|SECRET KEY|OPENSSH PRIVATE KEY)-----/gi;

const PEM_SECRET_PATH_PATTERN = /\.(?:pem|key)$/i;

// Password embedded in a connection-string URL, e.g.
// `postgresql://user:PASS@host`. Redacted from shell output so secrets in
// commands like `cat .env` do not leak into history or telemetry.
const URL_CREDENTIALS_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi;

/** Redact only userinfo passwords in connection-string URLs (zero false positives). */
export function redactConnectionStringCredentials(text: string): string {
  return text.replace(
    URL_CREDENTIALS_PATTERN,
    (_match, prefix: string, _password: string, at: string) =>
      `${prefix}${VALUE_REDACTION}${at}`,
  );
}

function isSensitiveJsonKey(key: string): boolean {
  return SENSITIVE_JSON_KEY_PATTERN.test(key);
}

function previewJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    PEM_BLOCK_PATTERN.lastIndex = 0;
    if (PEM_BLOCK_PATTERN.test(value)) return PRIVATE_KEY_REDACTION;
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
        ? previewJsonValue(entry)
        : '[REDACTED: nested value]',
    );
  }
  if (value && typeof value === 'object') {
    return '[REDACTED: nested object]';
  }
  return value;
}

export function isCredentialJsonContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    const type = String(record.type ?? '').toLowerCase();
    if (
      type === 'service_account' ||
      type === 'authorized_user' ||
      type === 'external_account'
    ) {
      return true;
    }
    return Object.keys(record).some((key) => isSensitiveJsonKey(key));
  } catch {
    return false;
  }
}

export function shouldUseSecretFilePreview(
  filePath: string,
  content: string,
): boolean {
  const normalized = String(filePath ?? '')
    .replace(/\\/g, '/')
    .trim();
  return (
    isSensitiveProjectPath(normalized) ||
    isSensitiveProjectPath(path.posix.basename(normalized)) ||
    isCredentialJsonContent(content)
  );
}

const DOTENV_BASENAME_PATTERN = /^\.env(?:\..+)?$/i;
const DOTENV_ASSIGNMENT_PATTERN =
  /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/;

export function isDotenvLikePath(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  const base = path.posix.basename(text.replace(/\\/g, '/'));
  return DOTENV_BASENAME_PATTERN.test(base);
}

/**
 * True only for a clean dotenv file we can safely show with keys visible and
 * values tokenized: no PEM block, not JSON, and every non-blank/non-comment line
 * is a `KEY=VALUE` assignment. Anything ambiguous (a stray line that might be a
 * raw secret) returns false so the caller keeps the opaque blackout instead.
 */
export function looksLikeEditableDotenv(content: string): boolean {
  PEM_BLOCK_PATTERN.lastIndex = 0;
  if (PEM_BLOCK_PATTERN.test(content)) return false;
  if (content.trimStart().startsWith('{')) return false;
  let sawAssignment = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (!DOTENV_ASSIGNMENT_PATTERN.test(line)) return false;
    sawAssignment = true;
  }
  return sawAssignment;
}

export function buildSecretFilePreview(
  filePath: string,
  content: string,
): Record<string, unknown> {
  PEM_BLOCK_PATTERN.lastIndex = 0;
  if (
    !content.trimStart().startsWith('{') &&
    (PEM_BLOCK_PATTERN.test(content) || PEM_SECRET_PATH_PATTERN.test(filePath))
  ) {
    return {
      kind: 'pem',
      filePath,
      redacted: true,
      keys: ['private_key_block'],
      preview: { private_key_block: PRIVATE_KEY_REDACTION },
    };
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const keys = Object.keys(record);
      const preview: Record<string, unknown> = {};
      for (const key of keys) {
        preview[key] = isSensitiveJsonKey(key)
          ? VALUE_REDACTION
          : previewJsonValue(record[key]);
      }
      return {
        kind: 'json-credentials',
        filePath,
        redacted: true,
        keys,
        preview,
      };
    }
  } catch {}
  return {
    kind: 'opaque-secret-file',
    filePath,
    redacted: true,
    output: SECRET_FILE_REDACTION,
  };
}
