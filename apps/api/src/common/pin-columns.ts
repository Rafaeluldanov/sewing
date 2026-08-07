import bcrypt from 'bcryptjs';
import {
  encryptSecret,
  isSecretKeyConfigured,
} from '../modules/integrations/secret-box.js';

/**
 * Вычисление пары колонок PIN'а сотрудника — ЕДИНСТВЕННАЯ точка в
 * проекте, где открытый PIN превращается в то, что ложится в БД.
 *
 * `Employee` хранит PIN дважды и эти колонки обязаны меняться ВМЕСТЕ:
 *   - `pinHash` — bcrypt, cost 10. Вход проверяется ТОЛЬКО по ней
 *     (`AuthService.login`), колонка обязательная;
 *   - `pinEnc`  — AES-256-GCM (`v1.<base64>`, ключ из env
 *     `INTEGRATION_SECRET_KEY`). Из неё карточка `/admin/employees/[id]`
 *     ПОКАЗЫВАЕТ пароль менеджеру (`EmployeesService.revealPin`).
 *
 * Почему модуль общий, а не приватный метод сервиса: `Employee` пишут
 * четыре независимых места — `EmployeesService`, `DisplayScreensService`
 * (заводит и правит DISPLAY-учётку напрямую), `prisma/seed.ts` и
 * `scripts/tenants/create-tenant.ts`. Стоит одному из них записать
 * `pinHash`, не тронув `pinEnc`, — и карточка начнёт уверенно показывать
 * ПРЕЖНИЙ, уже недействительный код. Это худший баг фичи: он не выглядит
 * как ошибка ни в логах, ни на экране. Общая функция делает инвариант
 * тем, что трудно обойти по невнимательности.
 *
 * Тот же cost-factor (10), что исторически в `prisma/seed.ts` и
 * `AuthService`, — чтобы у сотрудника, заведённого любым путём, вход
 * работал одинаково.
 */
export const PIN_HASH_COST = 10;

export interface PinColumns {
  pinHash: string;
  /**
   * `null` — обратимой копии нет, «Показать пароль» для этой карточки
   * не сработает (`hasStoredPin = false`). Так бывает, когда не настроен
   * `INTEGRATION_SECRET_KEY`.
   *
   * ВАЖНО: при смене PIN'а это значение нужно записывать в колонку ДАЖЕ
   * когда оно `null` — то есть затирать прежнее. Иначе останется
   * шифротекст от старого кода, и показ соврёт.
   */
  pinEnc: string | null;
}

/**
 * @param pin     Открытый PIN/пароль.
 * @param onWarn  Куда написать предупреждение, если обратимую копию
 *                сделать не удалось. Nest-сервисы передают свой
 *                `Logger.warn`,
 *                seed/скрипты — `console.warn`. Не бросаем: отсутствие
 *                ключа шифрования не должно мешать завести сотрудника
 *                или сменить ему PIN — деградирует только показ.
 */
export async function buildPinColumns(
  pin: string,
  onWarn?: (message: string) => void,
): Promise<PinColumns> {
  const pinHash = await bcrypt.hash(pin, PIN_HASH_COST);

  if (!isSecretKeyConfigured()) {
    onWarn?.(
      'INTEGRATION_SECRET_KEY не задан — PIN сохранён только хешем, ' +
        '«Показать пароль» для этой карточки работать не будет.',
    );
    return { pinHash, pinEnc: null };
  }

  try {
    return { pinHash, pinEnc: encryptSecret(pin) };
  } catch (e) {
    // Ключ задан, но кривой (не 32 байта / не hex и не base64). Ронять
    // сохранение нельзя: человек остался бы без учётки из-за опечатки
    // в env. Предупреждаем и продолжаем без обратимой копии.
    onWarn?.(
      `Не удалось зашифровать PIN (${(e as Error).message}) — ` +
        'сохраняем только bcrypt-хеш.',
    );
    return { pinHash, pinEnc: null };
  }
}
