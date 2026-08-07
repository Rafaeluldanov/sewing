/**
 * Unit-тест `apps/api/src/common/pin-columns.ts` — единственной точки,
 * где открытый PIN превращается в то, что ложится в `Employee`.
 *
 * Почему отдельным unit-ом, а не только через integration: это
 * крипто-примитив с тремя ветками по окружению, и две из них (нет ключа
 * / кривой ключ) в integration-прогоне не воспроизводятся — там ключ
 * выставлен глобально в `tests/utils/db.ts`. Ровно тот же приём, что и
 * у `tests/unit/employee-qr-token.test.ts`.
 *
 * Гоняется без `TEST_DATABASE_URL` — БД тут не нужна.
 */
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  buildPinColumns,
  PIN_HASH_COST,
} from '../../apps/api/src/common/pin-columns';
import { decryptSecret } from '../../apps/api/src/modules/integrations/secret-box';

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');
const PIN = 'pin-4455';

let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.INTEGRATION_SECRET_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.INTEGRATION_SECRET_KEY;
  else process.env.INTEGRATION_SECRET_KEY = savedKey;
});

describe('buildPinColumns — ключ настроен', () => {
  beforeEach(() => {
    process.env.INTEGRATION_SECRET_KEY = VALID_KEY;
  });

  test('bcrypt-хеш проверяет вход, а шифротекст возвращает исходный PIN', async () => {
    const { pinHash, pinEnc } = await buildPinColumns(PIN);

    // Колонка входа.
    expect(pinHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare(PIN, pinHash)).toBe(true);
    expect(await bcrypt.compare('другой-pin', pinHash)).toBe(false);

    // Колонка показа: главное свойство — round-trip, иначе карточка
    // покажет менеджеру мусор либо чужой код.
    expect(pinEnc).not.toBeNull();
    expect(pinEnc!.startsWith('v1.')).toBe(true);
    expect(pinEnc).not.toContain(PIN);
    expect(decryptSecret(pinEnc!)).toBe(PIN);
  });

  test('каждый вызов даёт РАЗНЫЙ шифротекст (случайный IV)', async () => {
    const a = await buildPinColumns(PIN);
    const b = await buildPinColumns(PIN);
    // Одинаковый шифротекст на одинаковом входе означал бы
    // детерминированный IV: по базе стало бы видно, у кого совпадают
    // PIN-ы, без всякой расшифровки.
    expect(a.pinEnc).not.toBe(b.pinEnc);
    expect(decryptSecret(a.pinEnc!)).toBe(PIN);
    expect(decryptSecret(b.pinEnc!)).toBe(PIN);
  });

  test('cost-фактор тот же, что исторически у seed и AuthService', async () => {
    const { pinHash } = await buildPinColumns(PIN);
    expect(pinHash).toContain(`$${String(PIN_HASH_COST).padStart(2, '0')}$`);
  });
});

describe('buildPinColumns — fail-soft по окружению', () => {
  test('без ключа: хеш есть, обратимой копии нет, предупреждение выдано', async () => {
    delete process.env.INTEGRATION_SECRET_KEY;
    const warnings: string[] = [];

    const { pinHash, pinEnc } = await buildPinColumns(PIN, (m) =>
      warnings.push(m),
    );

    // Сотрудник всё равно заводится и логинится — ронять сохранение
    // из-за ненастроенного env было бы хуже, чем потерять показ.
    expect(await bcrypt.compare(PIN, pinHash)).toBe(true);
    expect(pinEnc).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('INTEGRATION_SECRET_KEY');
  });

  test('кривой ключ: тоже не роняем, а деградируем до одного хеша', async () => {
    // Опечатка в env (не 32 байта) не должна оставлять человека без
    // учётки — падение здесь ломало бы приём на работу.
    process.env.INTEGRATION_SECRET_KEY = 'слишком-короткий';
    const warnings: string[] = [];

    const { pinHash, pinEnc } = await buildPinColumns(PIN, (m) =>
      warnings.push(m),
    );

    expect(await bcrypt.compare(PIN, pinHash)).toBe(true);
    expect(pinEnc).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test('без колбэка не падает (seed/скрипты зовут без логгера)', async () => {
    delete process.env.INTEGRATION_SECRET_KEY;
    await expect(buildPinColumns(PIN)).resolves.toMatchObject({
      pinEnc: null,
    });
  });
});
