/**
 * Контракты модуля «Ограничение выдачи кроя» (Stage 3 «Мастер цеха»,
 * см. `apps/api/src/modules/cut-release-policy/*`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `apps/web/app/master/cut-release-policy-card.tsx`).
 *
 * Назначение: позволить `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * задать одно правило выдачи кроя — фильтр по цвету и/или размеру и
 * лимит по штукам (`Σ passport.qtyCut`). Backend проверяет это правило
 * только при выдаче кроя из ячейки на ПЕРВОЙ операции маршрута (или
 * операциях категории `CUTTING`) — движение паспорта по маршруту дальше
 * (`scan`/`complete-operation`) сознательно не блокируется.
 *
 * MVP-инвариант: одновременно активна максимум одна политика
 * (`isActive = true`). Enforce — на сервисе
 * (`CutReleasePolicyService.create` сначала деактивирует предыдущую).
 * Это shared-контракт для UI/API; сама БД допускает несколько записей,
 * чтобы исторические (деактивированные) политики оставались для аудита
 * и для ответа на вопрос «сколько штук успели выдать в её рамках».
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Поля фильтра — `color` (строка вроде «Чёрный») и `sizeId` (FK на
 * `Size.id`, без жёсткого FK в БД — справочник может меняться).
 *
 * Оба поля опциональны: `null`/`undefined` = «не ограничивать по этому
 * полю». Минимальная длина строки `1` после trim — пустая строка не
 * считается валидным фильтром (UI должен передавать `null` или просто
 * не передавать поле). На MVP не валидируем «хотя бы одно из color/size
 * + limitQty» — мастер может задать «лимит 50 шт. без фильтра» как
 * сознательный стоп всей выдачи.
 */
const PolicyFilterFields = {
  color: z
    .string()
    .trim()
    .min(1, 'Цвет не может быть пустой строкой')
    .max(64, 'Слишком длинное название цвета')
    .nullish(),
  sizeId: z
    .string()
    .trim()
    .min(1, 'Не указан размер')
    .max(64, 'Некорректный sizeId')
    .nullish(),
} as const;

/**
 * `POST /api/cut-release-policy`.
 *
 * Создание новой активной политики. Старая активная (если есть)
 * автоматически деактивируется в той же транзакции
 * (см. `CutReleasePolicyService.create`). `consumedQty` всегда
 * стартует с 0 — даже если в БД уже была запись с тем же фильтром,
 * накопленный лимит к новой политике не «переносится».
 */
export const CreateCutReleasePolicySchema = z.object({
  ...PolicyFilterFields,
  /**
   * Лимит штук (`Σ passport.qtyCut`). На MVP принимаем `>= 1` —
   * лимит 0 (сознательная пауза «никому не выдавать») мастер может
   * получить через `disable`/новую политику с лимитом 1, не нужно
   * усложнять контракт.
   */
  limitQty: z
    .number()
    .int('Лимит — целое число')
    .min(1, 'Лимит должен быть не меньше 1')
    .max(1_000_000, 'Слишком большой лимит'),
});
export type CreateCutReleasePolicyDto = z.infer<
  typeof CreateCutReleasePolicySchema
>;

/**
 * `PATCH /api/cut-release-policy/:id`.
 *
 * Точечное обновление существующей политики. На MVP редко нужно —
 * мастер обычно создаёт новую. Поддерживаем для админских корректировок
 * (увеличить лимит на лету, поменять активность вручную). Все поля
 * опциональны.
 */
export const UpdateCutReleasePolicySchema = z
  .object({
    ...PolicyFilterFields,
    limitQty: z
      .number()
      .int('Лимит — целое число')
      .min(0, 'Лимит не может быть отрицательным')
      .max(1_000_000, 'Слишком большой лимит')
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.color !== undefined ||
      v.sizeId !== undefined ||
      v.limitQty !== undefined ||
      v.isActive !== undefined,
    { message: 'Не передано ни одного поля для обновления' },
  );
export type UpdateCutReleasePolicyDto = z.infer<
  typeof UpdateCutReleasePolicySchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Снимок политики, который отдают `GET /api/cut-release-policy` и
 * `POST /api/cut-release-policy[...]`. Денормализованное поле
 * `sizeLabel` нужно UI на `/master`, чтобы карточка показывала
 * человекочитаемый размер без отдельного запроса в справочник.
 *
 * `sizeLabel` равен `null` если фильтра по размеру нет
 * (`sizeId === null`) — НЕ если справочник не нашёл такой размер.
 * Несуществующий sizeId здесь невозможен: при `create`/`update`
 * сервис валидирует существование размера и иначе бросает 400.
 */
export interface CutReleasePolicyDto {
  id: string;
  isActive: boolean;
  color: string | null;
  sizeId: string | null;
  sizeLabel: string | null;
  limitQty: number;
  consumedQty: number;
  createdById: string;
  /** ISO-8601, как и во всех остальных API-ответах. */
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Inline-message
// ---------------------------------------------------------------------------

/**
 * Точный текст inline-сообщения, который backend бросает в
 * `CutReleasePolicyViolationException`, а frontend показывает как есть
 * (без префикса `[CUT_RELEASE_POLICY_VIOLATION] `, см.
 * `apps/web/app/work/actions.ts::explainApiError`).
 *
 * Формат сообщения зафиксирован ТЗ Stage 3:
 *   «Сейчас разрешена выдача только: <Цвет> <Размер>, лимит N шт.»
 *
 * Если фильтр по полю отсутствует — этот компонент опускается (см.
 * smoke-тест на «exact string»). Хелпер живёт в shared, чтобы
 * `apps/api` и `apps/web` (для smoke-теста) собирали один и тот же
 * текст из одной и той же функции — никакого дрейфа.
 */
export interface CutReleasePolicyMessageInput {
  color: string | null;
  sizeLabel: string | null;
  limitQty: number;
}

export function formatCutReleasePolicyMessage(
  policy: CutReleasePolicyMessageInput,
): string {
  const filterParts: string[] = [];
  if (policy.color) filterParts.push(policy.color);
  if (policy.sizeLabel) filterParts.push(policy.sizeLabel);
  const filterText = filterParts.length > 0 ? filterParts.join(' ') : 'весь крой';
  return `Сейчас разрешена выдача только: ${filterText}, лимит ${policy.limitQty} шт.`;
}
