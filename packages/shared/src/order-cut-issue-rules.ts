/**
 * Контракты модуля «Очередь выдачи кроя по размерам» (см.
 * `apps/api/src/modules/order-cut-issue-rules/*`,
 * `apps/api/src/modules/passports/passports.service.ts`,
 * `apps/web/components/orders/order-cut-issue-rules-card.tsx`,
 * `prisma/schema.prisma::OrderCutIssueRule`,
 * `docs/domain.md §«Очередь выдачи кроя»`).
 *
 * Назначение: позволить менеджеру заказа (`SHOP_MANAGER` /
 * `SHOPFLOOR_MASTER` / `ADMIN`) задать последовательность очередей
 * выдачи кроя по размерам. В каждой очереди — свой набор размеров и
 * количеств. Пока в «текущей» очереди (минимальный `queueIndex` с
 * незавершёнными строками) есть незакрытые размеры — бэкенд режет
 * `PassportsService.issueToEmployee` для паспортов «не очередных»
 * размеров адресной 409 `ORDER_CUT_ISSUE_RULE_VIOLATION`. После
 * полного закрытия текущей очереди следующая (с большим
 * `queueIndex`) автоматически становится «текущей»; если очередей
 * больше нет — выдача снова свободная.
 *
 * Дизайн ТЗ:
 *   - применяется только на ПЕРВОЙ операции маршрута
 *     (`Passport.currentRouteStepIndex === 0`) или операциях
 *     категории `CUTTING` — точно так же, как `CutReleasePolicy`;
 *   - порядок проверок в `issueToEmployee`:
 *     `OrderCutIssueRule` → `CutReleasePolicy`. Если очередь
 *     блокирует, до политики проверка не доходит;
 *   - bulk save применяется в рамках КОНКРЕТНОЙ очереди (`queueIndex`):
 *     строки той же очереди, не пришедшие в bulk-payload, переводятся
 *     в `isActive = false`. Другие очереди bulk не трогает. Полное
 *     отключение очереди заказа целиком —
 *     `POST /api/orders/:id/cut-issue-rules/disable-all`.
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

const QueueIndexSchema = z
  .number()
  .int('Индекс очереди — целое число')
  .min(1, 'Индекс очереди не может быть меньше 1')
  .max(64, 'Слишком большой индекс очереди');

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

/**
 * `POST /api/orders/:id/cut-issue-rules` — bulk upsert одной формы
 * (источник истины формы карточки заказа в рамках одной очереди).
 * Передаётся весь набор активных строк очереди + её `queueIndex`;
 * всё, чего нет в `rows`, бэкенд переводит в `isActive = false` —
 * но только в рамках указанной очереди. Другие очереди этого заказа
 * не трогаются.
 *
 * Уникальность по `sizeId` валидируется на уровне Zod-схемы
 * (`refine` ниже): UI и API защищены от дублей размеров в одной
 * форме одной очереди. Между разными очередями один и тот же
 * размер допустим (в этом и смысл многоочередной выдачи).
 */
export const BulkUpsertOrderCutIssueRulesSchema = z
  .object({
    queueIndex: QueueIndexSchema,
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

/**
 * `DELETE /api/orders/:id/cut-issue-rules/queues/:queueIndex` —
 * удаление пустой очереди (только последней, и только если в ней
 * `Σ issuedQty = 0`). Body не нужен; параметр пути приходит как
 * route-param и валидируется на сервисе.
 */
export const DeleteOrderCutIssueQueueSchema = z.object({}).strict();
export type DeleteOrderCutIssueQueueDto = z.infer<
  typeof DeleteOrderCutIssueQueueSchema
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
  queueIndex: number;
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
 * Статус строки/очереди:
 *   - `OFF` — нет ни одной активной строки;
 *   - `IN_PROGRESS` — есть активные строки, и хотя бы у одной
 *     `issuedQty < requiredQty`;
 *   - `DONE` — есть активные строки, и у всех `issuedQty >= requiredQty`.
 */
export type OrderCutIssueRuleStatus = 'OFF' | 'IN_PROGRESS' | 'DONE';

/**
 * Снимок одной очереди (одной «партии» выдачи) для UI карточки
 * заказа. `isCurrent = true` у той единственной очереди, которая
 * сейчас «активная» (минимальный `queueIndex`, у которого есть
 * незакрытые строки) — на UI её можно подсветить, и именно её
 * смотрит `evaluateForIssue` при выдаче кроя.
 */
export interface OrderCutIssueQueueDto {
  queueIndex: number;
  status: OrderCutIssueRuleStatus;
  isCurrent: boolean;
  rules: OrderCutIssueRuleDto[];
}

/**
 * Сводка очереди выдачи кроя по заказу: статус заказа в целом +
 * список всех очередей.
 *
 *   - `status = 'OFF'` — нет активных строк ни в одной очереди;
 *   - `status = 'IN_PROGRESS'` — есть хоть одна активная незакрытая
 *     строка в любой очереди;
 *   - `status = 'DONE'` — есть активные строки, и все они закрыты.
 *
 * `queues` отсортированы по возрастанию `queueIndex`. Поле `rules`
 * (плоский список без группировки) сохранено как deprecated для
 * обратной совместимости со старыми клиентами; на новых UI
 * используем `queues`.
 */
export interface OrderCutIssueRulesSummaryDto {
  orderId: string;
  status: OrderCutIssueRuleStatus;
  queues: OrderCutIssueQueueDto[];
  /**
   * @deprecated Используйте `queues` — плоский список оставлен для
   * обратной совместимости и упрощения миграции UI.
   */
  rules: OrderCutIssueRuleDto[];
}

// ---------------------------------------------------------------------------
// Active banner (для /work «Сейчас сканируйте: размер X, ячейки Y»)
// ---------------------------------------------------------------------------

export interface OrderCutIssueRuleBannerCellDto {
  cellId: string;
  cellCode: string;
  /** Сколько паспортов нужного размера в этой ячейке. */
  passportsCount: number;
}

/**
 * Карточка одного заказа в баннере «Очередь выдачи кроя» на /work.
 * Показывает первый незакрытый размер в ТЕКУЩЕЙ очереди заказа
 * (минимальный `queueIndex` с незакрытыми строками).
 */
export interface OrderCutIssueRuleBannerOrderDto {
  orderId: string;
  orderNumber: string;
  /** Краткое название изделия для шапки карточки баннера (опционально). */
  productLabel: string | null;
  /** Индекс текущей очереди заказа (1-based). */
  queueIndex: number;
  /** ID и код текущего (незакрытого) размера очереди. */
  currentSizeId: string;
  currentSizeCode: string;
  /** Сколько ещё нужно выдать по этому размеру (`required - issued`). */
  remainingQty: number;
  requiredQty: number;
  issuedQty: number;
  /** Список ячеек с паспортами текущего размера (может быть пустым). */
  cells: OrderCutIssueRuleBannerCellDto[];
}

export interface OrderCutIssueRuleBannerDto {
  applicable: boolean;
  orders: OrderCutIssueRuleBannerOrderDto[];
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
    return 'Сначала нужно выдать паспорта по очереди заказа.';
  }
  const parts = rows.map((r) => `${r.sizeCode} — осталось ${r.remainingQty} шт`);
  return `Сначала нужно выдать: ${parts.join(', ')}`;
}
