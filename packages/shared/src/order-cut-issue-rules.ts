/**
 * Контракты модуля «Очередь выдачи кроя по размерам» (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `apps/web/components/orders/order-cut-issue-rules-card.tsx`,
 * `prisma/schema.prisma::OrderCutIssueRule`,
 * `docs/domain.md §«Очередь выдачи кроя»`).
 *
 * Назначение: позволить менеджеру заказа (`SHOP_MANAGER` /
 * `SHOPFLOOR_MASTER` / `ADMIN`) задать «первую очередь выдачи кроя
 * по размерам». Пока хотя бы одна активная строка очереди не
 * выполнена, бэкенд режет `PassportsService.issueToEmployee` для
 * паспортов «не очередных» размеров адресной 409
 * `ORDER_CUT_ISSUE_RULE_VIOLATION`. После выполнения всех строк
 * выдача снова свободная (никаких ручных «снять очередь» не
 * требуется — правило гасит само себя по `issuedQty`).
 *
 * Дизайн ТЗ:
 *   - применяется только на ПЕРВОЙ операции маршрута
 *     (`Passport.currentRouteStepIndex === 0`) или операциях
 *     категории `CUTTING` — точно так же, как `CutReleasePolicy`;
 *   - порядок проверок в `issueToEmployee`:
 *     `OrderCutIssueRule` → `CutReleasePolicy`. Если очередь
 *     блокирует, до политики проверка не доходит;
 *   - bulk save = source of truth формы: строки, не пришедшие в
 *     bulk-payload, переводятся в `isActive = false`. Полное
 *     отключение очереди — `POST /api/orders/:id/cut-issue-rules/disable-all`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const CUID_LIKE = z
  .string()
  .trim()
  .min(1, 'Не указан размер')
  .max(64, 'Некорректный sizeId');

/**
 * Одна строка очереди (используется в bulk-upsert и в одиночных
 * create/update формах).
 *
 * `requiredQty > 0` (нулевая строка бессмысленна — она ничего не
 * блокирует, см. ТЗ §«Validation»). Верхний предел `1_000_000` —
 * страховка от опечаток / бесконечных значений; в реальной
 * партии этого с лихвой хватает.
 *
 * `sortOrder >= 0` — менеджерский порядок строк в UI. Бэкенд
 * стабильно достраивает второй уровень сортировки по
 * `Size.sortOrder` / `Size.code`, поэтому повторяющиеся `0`
 * корректны.
 */
const RuleRowFields = {
  sizeId: CUID_LIKE,
  requiredQty: z
    .number()
    .int('Количество — целое число')
    .min(1, 'Количество должно быть не меньше 1')
    .max(1_000_000, 'Слишком большое количество'),
  sortOrder: z
    .number()
    .int('Порядок — целое число')
    .min(0, 'Порядок не может быть отрицательным')
    .max(10_000, 'Слишком большой порядок')
    .optional(),
} as const;

/**
 * `POST /api/orders/:id/cut-issue-rules` — bulk upsert одной формы
 * (источник истины формы карточки заказа). Передаётся весь набор
 * активных строк; всё, чего нет в `rows`, бэкенд переводит в
 * `isActive = false`.
 *
 * Уникальность по `sizeId` валидируется на уровне Zod-схемы
 * (`refine` ниже): UI и API защищены от дублей размеров в одной
 * форме. Это упрощает atomic upsert на сервисе — мы можем зайти
 * в одну транзакцию и быть уверены, что одной строкой не «затрём»
 * другую с тем же размером в той же форме.
 */
export const CreateOrderCutIssueRuleSchema = z.object({
  ...RuleRowFields,
});
export type CreateOrderCutIssueRuleDto = z.infer<
  typeof CreateOrderCutIssueRuleSchema
>;

export const UpdateOrderCutIssueRuleSchema = z
  .object({
    requiredQty: RuleRowFields.requiredQty.optional(),
    sortOrder: RuleRowFields.sortOrder,
    isActive: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.requiredQty !== undefined ||
      v.sortOrder !== undefined ||
      v.isActive !== undefined,
    { message: 'Не передано ни одного поля для обновления' },
  );
export type UpdateOrderCutIssueRuleDto = z.infer<
  typeof UpdateOrderCutIssueRuleSchema
>;

export const BulkUpsertOrderCutIssueRulesSchema = z
  .object({
    rows: z
      .array(
        z.object({
          ...RuleRowFields,
        }),
      )
      .max(64, 'Слишком много строк очереди (максимум 64)'),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    value.rows.forEach((row, index) => {
      const prev = seen.get(row.sizeId);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', index, 'sizeId'],
          message: `Размер уже добавлен в очередь (строка ${prev + 1})`,
        });
      }
      seen.set(row.sizeId, index);
    });
  });
export type BulkUpsertOrderCutIssueRulesDto = z.infer<
  typeof BulkUpsertOrderCutIssueRulesSchema
>;

/**
 * `POST /api/orders/:id/cut-issue-rules/disable-all` — пустой body,
 * но отдельный schema нужен для единообразия с
 * `ZodValidationPipe`-проверкой пустых тел (см. NestJS pipes — мы
 * не пускаем `undefined` в pipe без явной схемы).
 */
export const DisableOrderCutIssueRulesSchema = z.object({}).strict();
export type DisableOrderCutIssueRulesDto = z.infer<
  typeof DisableOrderCutIssueRulesSchema
>;

// ---------------------------------------------------------------------------
// Response DTO
// ---------------------------------------------------------------------------

/**
 * Снимок одной строки очереди для UI/смежных контуров.
 *
 * `sizeCode` / `sizeLabel` дублируются денормализованно, чтобы UI
 * мог отрисовать карточку без второго запроса в справочник
 * размеров (то же решение, что у `OrderSizeBreakdownRow`). На MVP
 * `sizeLabel === sizeCode` — отдельная человекочитаемая строка
 * пока не вводилась.
 *
 * `remainingQty` и `progressPct` — derived-поля, считаются на
 * сервере одинаково с `formatOrderCutIssueRuleViolationMessage`,
 * чтобы UI и сообщения backend-а никогда не разъезжались.
 */
export interface OrderCutIssueRuleDto {
  id: string;
  orderId: string;
  sizeId: string;
  sizeCode: string;
  sizeLabel: string;
  requiredQty: number;
  issuedQty: number;
  /** `max(requiredQty - issuedQty, 0)`. */
  remainingQty: number;
  /**
   * Прогресс выдачи, целое от 0 до 100. Если `requiredQty === 0`
   * (теоретически невозможно — Zod не пускает; страховка для
   * исторических данных), считаем `100`.
   */
  progressPct: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Сводка очереди по заказу: статус + строки. Хорошая точка для
 * UI, где сразу нужны и заголовок («Очередь выполнена»), и
 * таблица. Поле `status` рассчитывается так же, как сообщение
 * блокировки (см. `formatOrderCutIssueRuleViolationMessage`):
 *
 *   - `OFF` — нет ни одной активной строки;
 *   - `IN_PROGRESS` — есть активные строки, и хотя бы у одной
 *     `issuedQty < requiredQty`;
 *   - `DONE` — есть активные строки, и у всех `issuedQty >= requiredQty`.
 *
 * В состоянии `DONE` правило бэкенд тоже считает «не блокирующим»
 * (см. `OrderCutIssueRulesService.evaluateForIssue`): выдача
 * остальных размеров становится свободной.
 */
export type OrderCutIssueRuleStatus = 'OFF' | 'IN_PROGRESS' | 'DONE';

export interface OrderCutIssueRulesSummaryDto {
  orderId: string;
  status: OrderCutIssueRuleStatus;
  rules: OrderCutIssueRuleDto[];
}

// ---------------------------------------------------------------------------
// Inline-message
// ---------------------------------------------------------------------------

/**
 * Точный текст inline-сообщения, который backend бросает в
 * `OrderCutIssueRuleViolationException`, а frontend показывает «как
 * есть» (без префикса `[ORDER_CUT_ISSUE_RULE_VIOLATION] ` от UI —
 * см. `apps/web/app/work/actions.ts::RAW_API_ERROR_CODES`).
 *
 * Формат сообщения зафиксирован ТЗ:
 *   «Сначала нужно выдать: S — осталось 20 шт, M — осталось 10 шт,
 *    4XL — осталось 50 шт»
 *
 * Хелпер живёт в shared, чтобы `apps/api` (для `throw`) и `apps/web`
 * (для smoke-теста и UI-подсказок) собирали один и тот же текст из
 * одной функции — никакого дрейфа.
 */
export interface OrderCutIssueRuleViolationRow {
  /** Человекочитаемый код размера, как видит его пользователь. */
  sizeCode: string;
  /** Сколько ещё нужно выдать (`requiredQty - issuedQty > 0`). */
  remainingQty: number;
}

export function formatOrderCutIssueRuleViolationMessage(
  rows: ReadonlyArray<OrderCutIssueRuleViolationRow>,
): string {
  if (rows.length === 0) {
    // Сюда мы вообще не должны попадать (если строк нет, очередь
    // не блокирует), но защищаемся от пустого массива явно — иначе
    // получим текст «Сначала нужно выдать: » с висящим двоеточием.
    return 'Сначала нужно выдать паспорта по очереди заказа.';
  }
  const parts = rows.map((r) => `${r.sizeCode} — осталось ${r.remainingQty} шт`);
  return `Сначала нужно выдать: ${parts.join(', ')}`;
}
