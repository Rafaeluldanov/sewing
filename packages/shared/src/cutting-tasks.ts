/**
 * Контракты модуля «Кабинет раскройщика» (роль `CUTTER`).
 *
 * См.:
 *   - `prisma/schema.prisma::CuttingTask` / `CuttingTaskSizeRow` /
 *     `CuttingTaskRoll`;
 *   - `apps/api/src/modules/cutting-tasks/*`;
 *   - `apps/web/app/cutter/*`.
 *
 * Поток:
 *   1. Менеджер запускает заказ в производство (`OrdersService.start`)
 *      → автоматически создаётся `CuttingTask` (status `NEW`) со
 *      строками-заданием по размерам (план из `OrderItem`).
 *   2. Раскройщик в кабинете видит общую очередь, берёт задачу в работу
 *      (`start` → `IN_PROGRESS`).
 *   3. Вводит «количество размера на настиле» (`perLayerQty`) и
 *      настилает рулоны (`rolls`: номер + слои). Итоги считаются на лету.
 *   4. Когда итог приблизился к плану — жмёт «Раскрой завершён»
 *      (`complete` → `DONE`).
 *
 * Zod-схемы здесь — источник истины для валидации: backend
 * (`CuttingTasksController`) и web (server action) валидируют ими обе
 * стороны.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Статусы задачи
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл задачи на раскрой. В БД хранится как `String` (без
 * Prisma enum) — расширение без миграции.
 *
 *   NEW ──start──▶ IN_PROGRESS ──complete──▶ DONE
 *                        │
 *                        └────(заказ отменён)────▶ CANCELLED
 */
export const CUTTING_TASK_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'DONE',
  'CANCELLED',
] as const;

export const CuttingTaskStatusSchema = z.enum(CUTTING_TASK_STATUSES);
export type CuttingTaskStatus = z.infer<typeof CuttingTaskStatusSchema>;

export const CUTTING_TASK_STATUS_LABELS: Record<CuttingTaskStatus, string> = {
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  DONE: 'Завершена',
  CANCELLED: 'Отменена',
};

/**
 * Тон бейджа статуса (совпадает с тонами `AdminStatusBadge`:
 * success/info/warning/danger/muted).
 */
export const CUTTING_TASK_STATUS_TONE: Record<
  CuttingTaskStatus,
  'success' | 'info' | 'warning' | 'danger' | 'muted'
> = {
  NEW: 'warning',
  IN_PROGRESS: 'info',
  DONE: 'success',
  CANCELLED: 'muted',
};

// ---------------------------------------------------------------------------
// Лимиты
// ---------------------------------------------------------------------------

/** Максимум строк-размеров в одной задаче (с запасом). */
export const CUTTING_TASK_MAX_SIZE_ROWS = 64;
/** Максимум рулонов в одной задаче. */
export const CUTTING_TASK_MAX_ROLLS = 500;
/** Верхняя граница «штук размера на настиле» (защита от опечаток). */
export const CUTTING_TASK_MAX_PER_LAYER_QTY = 1000;
/** Верхняя граница «слоёв в рулоне». */
export const CUTTING_TASK_MAX_LAYERS = 100000;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** Неотрицательное целое из строки/числа; пустое → 0. */
function nonNegativeIntField(max: number, label: string) {
  return z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v, ctx): number => {
      if (v == null || v === '') return 0;
      const raw = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: допускаются только целые числа ≥ 0`,
        });
        return z.NEVER;
      }
      if (raw > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: значение не может превышать ${max}`,
        });
        return z.NEVER;
      }
      return raw;
    });
}

/**
 * Строка ввода «размер → количество на настиле». `qtyPlan` НЕ
 * принимаем от клиента — план фиксируется при создании задачи и
 * read-only для раскройщика.
 */
export const CuttingTaskSizeRowInputSchema = z.object({
  sizeId: z.string().min(1, 'Размер обязателен'),
  perLayerQty: nonNegativeIntField(
    CUTTING_TASK_MAX_PER_LAYER_QTY,
    'Количество на настиле',
  ),
});
export type CuttingTaskSizeRowInputDto = z.infer<
  typeof CuttingTaskSizeRowInputSchema
>;

/** Строка ввода рулона «номер → слои». */
export const CuttingTaskRollInputSchema = z.object({
  ordinal: z
    .number({ invalid_type_error: 'Номер рулона должен быть числом' })
    .int('Номер рулона — целое')
    .min(1, 'Номер рулона начинается с 1')
    .max(CUTTING_TASK_MAX_ROLLS, `Номер рулона не больше ${CUTTING_TASK_MAX_ROLLS}`),
  layers: nonNegativeIntField(CUTTING_TASK_MAX_LAYERS, 'Слоёв в рулоне'),
});
export type CuttingTaskRollInputDto = z.infer<typeof CuttingTaskRollInputSchema>;

/**
 * Payload для `PATCH /api/cutting-tasks/:id` (автосохранение прогресса)
 * и `POST /api/cutting-tasks/:id/complete` (финальное сохранение +
 * перевод в DONE). Полностью перезаписывает `perLayerQty` строк и набор
 * рулонов задачи (replace, не diff).
 *
 * `sizeRows` опционален: на ранних автосейвах раскройщик мог ещё не
 * трогать таблицу размеров. `rolls` тоже опционален (пустой настил).
 */
export const SaveCuttingTaskProgressSchema = z.object({
  sizeRows: z
    .array(CuttingTaskSizeRowInputSchema)
    .max(CUTTING_TASK_MAX_SIZE_ROWS, 'Слишком много строк размеров')
    .default([])
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i += 1) {
        const sid = rows[i]!.sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер повторяется — дубликаты не допускаются',
          });
        }
        seen.add(sid);
      }
    }),
  rolls: z
    .array(CuttingTaskRollInputSchema)
    .max(CUTTING_TASK_MAX_ROLLS, 'Слишком много рулонов')
    .default([])
    .superRefine((rolls, ctx) => {
      const seen = new Set<number>();
      for (let i = 0; i < rolls.length; i += 1) {
        const ord = rolls[i]!.ordinal;
        if (seen.has(ord)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'ordinal'],
            message: `Рулон №${ord} повторяется`,
          });
        }
        seen.add(ord);
      }
    }),
});
export type SaveCuttingTaskProgressDto = z.infer<
  typeof SaveCuttingTaskProgressSchema
>;

// ---------------------------------------------------------------------------
// Output DTOs
// ---------------------------------------------------------------------------

export interface CuttingTaskSizeRowDto {
  id: string;
  sortOrder: number;
  sizeId: string | null;
  sizeCodeSnapshot: string;
  /** Плановое количество штук этого размера (read-only). */
  qtyPlan: number;
  /** Введённое раскройщиком «количество размера на настиле». */
  perLayerQty: number;
}

export interface CuttingTaskRollDto {
  id: string;
  ordinal: number;
  layers: number;
}

export interface CuttingTaskSummaryDto {
  id: string;
  orderId: string;
  orderNumber: string;
  /** Цвет заказа (для подписи карточки), если задан. */
  orderColor: string | null;
  status: CuttingTaskStatus;
  assignedToName: string | null;
  sizeRowsCount: number;
  rollsCount: number;
  /** Σ слоёв по всем рулонам — удобно показать прямо в списке. */
  totalLayers: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CuttingTaskDetailDto extends CuttingTaskSummaryDto {
  /** Свободный текст клиента/комментарий заказа — справочно. */
  orderCustomer: string | null;
  sizeRows: CuttingTaskSizeRowDto[];
  rolls: CuttingTaskRollDto[];
}

// ---------------------------------------------------------------------------
// Helpers — расчёт итогов (используют и сервер-мапперы, и клиент)
// ---------------------------------------------------------------------------

export interface CuttingTaskTotals {
  /** Σ слоёв по всем рулонам. */
  totalLayers: number;
  /** Итог по каждому размеру: `sizeId → totalLayers × perLayerQty`. */
  perSizeTotal: Record<string, number>;
}

/**
 * Считает «всего слоёв» и «итог по размеру». Чистая функция — одинаково
 * работает на сервере (мапперы summary/detail) и на клиенте (живой
 * пересчёт в форме раскроя).
 */
export function computeCuttingTotals(
  sizeRows: Array<{ sizeId: string | null; perLayerQty: number }>,
  rolls: Array<{ layers: number }>,
): CuttingTaskTotals {
  const totalLayers = rolls.reduce(
    (sum, r) => sum + (Number.isFinite(r.layers) ? r.layers : 0),
    0,
  );
  const perSizeTotal: Record<string, number> = {};
  for (const row of sizeRows) {
    if (!row.sizeId) continue;
    perSizeTotal[row.sizeId] = totalLayers * (row.perLayerQty ?? 0);
  }
  return { totalLayers, perSizeTotal };
}
