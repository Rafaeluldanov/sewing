import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

/**
 * Шифрование секретов интеграции at-rest (AES-256-GCM).
 *
 * Первый в проекте шифруемый-в-БД секрет — пароль сервисного аккаунта
 * upgifts (`IntegrationSettings.upgiftsPasswordEnc`). Раньше конвенция
 * была «плейнтекст-колонка» (`Printer.agentToken`), но пароль к чужой
 * системе так хранить нельзя.
 *
 * Ключ берётся из env `INTEGRATION_SECRET_KEY` — 32 байта в hex (64
 * симв.) или base64. Если ключ не задан — `encryptSecret`/`decryptSecret`
 * бросают {@link IntegrationSecretKeyMissingError}; сервис переводит это
 * в человекочитаемую ошибку настройки (пароль не сохраняем без ключа).
 *
 * Формат шифротекста: `v1.` + base64(iv‖tag‖ciphertext), где
 * iv = 12 байт, tag = 16 байт (GCM). Версия-префикс оставляет путь для
 * ротации схемы без гадания о формате.
 */

const ENC_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Ключ не задан в окружении — пароль нельзя ни зашифровать, ни прочитать. */
export class IntegrationSecretKeyMissingError extends Error {
  constructor() {
    super(
      'INTEGRATION_SECRET_KEY не задан: невозможно безопасно хранить пароль ' +
        'интеграции. Сгенерируйте 32-байтный ключ (hex/base64) и добавьте в .env.',
    );
    this.name = 'IntegrationSecretKeyMissingError';
  }
}

/** Шифротекст повреждён / не тем ключом / не тот формат. */
export class IntegrationSecretDecryptError extends Error {
  constructor(cause?: unknown) {
    super('Не удалось расшифровать секрет интеграции (ключ/формат).');
    this.name = 'IntegrationSecretDecryptError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // 64 hex-символа → hex; иначе пробуем base64.
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `INTEGRATION_SECRET_KEY должен декодироваться в ${KEY_BYTES} байт ` +
        `(получено ${key.length}); задайте 32 байта в hex или base64.`,
    );
  }
  return key;
}

function loadKey(): Buffer {
  const raw = process.env.INTEGRATION_SECRET_KEY;
  if (!raw || raw.trim() === '') {
    throw new IntegrationSecretKeyMissingError();
  }
  return parseKey(raw);
}

/** Задан ли ключ шифрования (без попытки его распарсить). */
export function isSecretKeyConfigured(): boolean {
  const raw = process.env.INTEGRATION_SECRET_KEY;
  return Boolean(raw && raw.trim() !== '');
}

/** Зашифровать секрет. Бросает {@link IntegrationSecretKeyMissingError}. */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}.${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

/**
 * Расшифровать секрет, ранее полученный из {@link encryptSecret}.
 * Бросает {@link IntegrationSecretKeyMissingError} (нет ключа) или
 * {@link IntegrationSecretDecryptError} (битый формат/чужой ключ).
 */
export function decryptSecret(token: string): string {
  const key = loadKey();
  const dot = token.indexOf('.');
  if (dot < 0 || token.slice(0, dot) !== ENC_VERSION) {
    throw new IntegrationSecretDecryptError('unknown version prefix');
  }
  let blob: Buffer;
  try {
    blob = Buffer.from(token.slice(dot + 1), 'base64');
  } catch (e) {
    throw new IntegrationSecretDecryptError(e);
  }
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new IntegrationSecretDecryptError('ciphertext too short');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      'utf8',
    );
  } catch (e) {
    throw new IntegrationSecretDecryptError(e);
  }
}
