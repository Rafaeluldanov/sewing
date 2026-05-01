/**
 * Контракты справочника `Size`.
 *
 * Расширение «Создание пользовательского размера» (см. ТЗ
 * «Создание размера в номенклатуре»):
 *
 *   - источник истины — единая модель `Size` в `prisma/schema.prisma`;
 *     дополнительной таблицы под «пользовательский размер» НЕ вводим;
 *   - DTO размера тот же, что и раньше — `SizeDto` (`id`, `code`,
 *     `sortOrder`). Для backward-compat алиас оставлен в
 *     `@sewing/shared/orders` и теперь экспортируется и здесь;
 *   - схема создания (`CreateSizeSchema`) принимает «человеческий»
 *     ввод и приводит его к каноничному виду через
 *     `normalizeSizeCode` (см. ниже). Это позволяет менеджеру
 *     набивать «200*300*10» / «200x300x10» — backend всегда
 *     сохранит «200×300×10» и сопоставит с уже существующим
 *     размером (idempotent create).
 *
 * Schema контракт:
 *   POST /api/sizes — body соответствует `CreateSizeSchema`,
 *   ответ — `SizeDto`. Если такой `code` уже существует в БД,
 *   backend возвращает существующую запись (200/201 — на усмотрение
 *   контроллера, контракт UI к коду статуса не привязан) и НЕ
 *   создаёт дубль. См. `apps/api/src/modules/sizes/sizes.service.ts`.
 */

import { z } from 'zod';

/**
 * DTO размера. Источник истины — `@sewing/shared/orders` (исторически
 * `SizeDto` ввели туда вместе с `OrderItemDto`). Здесь делаем re-export,
 * чтобы новый код мог импортировать всё про размеры из одного модуля
 * (`@sewing/shared/sizes`). Поля совпадают:
 *   - `id`, `code`, `sortOrder`.
 */
export type { SizeDto } from './orders';

/**
 * Максимальная длина `Size.code` в БД не ограничена явно
 * (`String @unique`), но ради целостности API ограничиваем 64 —
 * этого достаточно для «сумка 200×300×10», «полотенце 70×140» и
 * подобных пользовательских размеров.
 */
export const SIZE_CODE_MAX_LENGTH = 64;

/**
 * Минимальная длина `Size.code` после `normalizeSizeCode` —
 * пустые / только-пробельные значения отбиваются здесь же.
 */
export const SIZE_CODE_MIN_LENGTH = 1;

/**
 * Привести «пользовательский ввод» размера к каноничной форме.
 *
 * Шаги:
 *   1. `trim` + collapse повторяющихся пробелов;
 *   2. между двумя цифрами (с произвольными пробелами вокруг)
 *      разделитель `*` / `x` / `X` / кириллический `х`/`Х` →
 *      U+00D7 «×» (повторяем, пока есть совпадения, чтобы покрыть
 *      «200*300*10» цепочкой);
 *   3. если результат содержит только ASCII-буквы/цифры/`-`/`_`/`/`/
 *      пробелы и символ `×` — поднять регистр (это превратит «6xl» →
 *      «6XL» и «shopper-200×300×10» → «SHOPPER-200×300×10»).
 *      Если в строке есть кириллица — оставить регистр пользователя:
 *      «сумка 200×300×10» НЕ должно превращаться в «СУМКА …».
 *
 * Примеры (зафиксированы тестом):
 *   - «  6xl »                  → «6XL»
 *   - «200*300*10»              → «200×300×10»
 *   - «200x300x10»              → «200×300×10»
 *   - «200×300×10»              → «200×300×10»
 *   - «shopper-200x300x10»      → «SHOPPER-200×300×10»
 *   - «сумка 200x300x10»        → «сумка 200×300×10»
 *   - «  XS »                   → «XS»
 *   - «104»                     → «104»
 */
export function normalizeSizeCode(input: string): string {
  let s = input.replace(/\s+/g, ' ').trim();
  // Заменяем разделители «между цифрами» на ×. Используем lookahead +
  // capture, чтобы корректно обработать «200*300*10» (overlapping
  // matches: после первой замены вторая пара 300/10 становится валидной
  // — поэтому крутим в цикле, пока есть совпадения).
  const SEP_RE = /(\d)\s*[xXхХ*×]\s*(?=\d)/g;
  let prev: string;
  do {
    prev = s;
    s = s.replace(SEP_RE, '$1×');
  } while (s !== prev);

  const HAS_CYRILLIC = /[\u0400-\u04FF]/.test(s);
  if (!HAS_CYRILLIC) {
    s = s.toUpperCase();
  }
  return s;
}

/**
 * Zod-схема тела `POST /api/sizes`. Источник истины валидации
 * для backend и server actions на web.
 *
 * Семантика полей:
 *   - `code`     — строка размера; нормализуется до каноничной формы
 *                  (`normalizeSizeCode`); после нормализации длина
 *                  должна быть в диапазоне `[1, 64]`. Допустимые
 *                  символы — латиница / кириллица / цифры / `-`/
 *                  `_`/`/`/пробел/`×` (последнее — результат
 *                  нормализации).
 *   - `sortOrder` — опциональный целочисленный приоритет сортировки.
 *                  Не передан / `null` → backend подставит
 *                  `max(sortOrder) + 10`, чтобы новый размер ушёл в
 *                  конец списка справочника (см. ТЗ §8). Передан явно —
 *                  backend сохранит как есть, без сдвигов соседей.
 */
export const CreateSizeSchema = z.object({
  code: z
    .string({ required_error: 'Размер обязателен', invalid_type_error: 'Размер должен быть строкой' })
    .transform((raw, ctx) => {
      if (typeof raw !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Размер должен быть строкой',
        });
        return z.NEVER;
      }
      const normalized = normalizeSizeCode(raw);
      if (normalized.length < SIZE_CODE_MIN_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Размер не может быть пустым',
        });
        return z.NEVER;
      }
      if (normalized.length > SIZE_CODE_MAX_LENGTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Размер: не длиннее ${SIZE_CODE_MAX_LENGTH} символов`,
        });
        return z.NEVER;
      }
      // Whitelist символов: буквы (Unicode), цифры, пробел, дефис,
      // подчёркивание, слеш, точка, запятая, скобки и `×` (вывод
      // нормализации). Регулярка опирается на Unicode property escapes
      // — Node 16+ их поддерживает, и shared собирается под тот же
      // tsconfig, что api/web (см. `packages/shared/tsconfig.json`).
      if (!/^[\p{L}\p{N} \-_/.,()×]+$/u.test(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Размер может содержать только буквы, цифры, пробел, ×, -, _, /, точку и запятую',
        });
        return z.NEVER;
      }
      return normalized;
    }),
  sortOrder: z
    .number({ invalid_type_error: 'sortOrder должен быть числом' })
    .int('sortOrder должен быть целым')
    .nullable()
    .optional(),
});
export type CreateSizeDto = z.infer<typeof CreateSizeSchema>;
