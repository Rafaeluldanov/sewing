/**
 * Контракты модуля «Себестоимость выпуска» (Production Cost).
 *
 * Управленческий read-only модуль (ADR-0021 family). Источник истины —
 * backend (`/api/costs/production`), бизнес-правила — `docs/domain.md
 * §17` («Себестоимость выпуска»).
 *
 * Скоуп MVP сознательно ограничен:
 *   - агрегируем по дню упаковки паспорта (`PACKED` event date);
 *   - себестоимость = piecework + окладная доля, распределённая по
 *     длительности обработки `QC` / `WTO` / `PACKING`;
 *   - длительность одной стадии по одному паспорту cap-аем сверху
 *     `MAX_STAGE_MINUTES_PER_PASSPORT` (защита от «забыл закрыть»);
 *   - неучтённое время = `SHIFT_MINUTES − Σ tracked` для окладного
 *     сотрудника, у которого в этот день была хотя бы одна смена;
 *   - простой НЕ распределяется на изделия (см. ТЗ §11).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Длительность смены в минутах. Управленческая константа MVP — мы не
 * считаем фактический график «start/stop» (см. ADR-0021): смена либо
 * была (есть `ShiftSession`), либо нет.
 */
export const SHIFT_MINUTES = 480;

/**
 * Максимальная длительность одной стадии (`QC` / `WTO` / `PACKING`)
 * по одному паспорту, в минутах. Предотвращает аномалию «сотрудник
 * принял паспорт и забыл закрыть» — без cap такая запись съела бы
 * весь оклад смены и положила бы метрики простоя в минус.
 *
 * Значение — управленческое: 60 минут на стадию по одной партии
 * сильно больше реалистичного потолка (по факту ~1–10 минут), но
 * безопасно дальше от типичной нормы.
 */
export const MAX_STAGE_MINUTES_PER_PASSPORT = 60;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DateOnlySchema = z
  .string()
  .min(1)
  .refine(
    (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    'Дата в формате YYYY-MM-DD',
  );

/**
 * Query `GET /api/costs/production`.
 *
 * Период необязателен: без него возвращаем «последние 14 календарных
 * дней по UTC». Это защищает экран от пустых state на первом открытии.
 */
export const ProductionCostQuerySchema = z.object({
  dateFrom: DateOnlySchema.optional(),
  dateTo: DateOnlySchema.optional(),
});
export type ProductionCostQuery = z.infer<typeof ProductionCostQuerySchema>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Один день в выборке `/api/costs/production`. Все суммы — в рублях,
 * с двумя знаками после запятой; время — в минутах целочисленно.
 */
export interface ProductionCostDayDto {
  /** ISO-дата без времени, `YYYY-MM-DD`. */
  date: string;
  /** Сумма `qtyGood` по паспортам, упакованным в этот день. */
  producedUnits: number;
  /** `pieceworkCost + salaryCost + materialCost` (только распределённая на изделия часть). */
  totalCost: number;
  /** Σ сдельных начислений (`OperationEntry.amount`, статус APPROVED). */
  pieceworkCost: number;
  /** Σ окладной доли, распределённой по упакованным паспортам. */
  salaryCost: number;
  /**
   * Σ `MaterialIssue.totalCost` по POSTED-документам, у которых
   * `passportId` входит в множество паспортов, упакованных в этот день
   * (см. `docs/domain.md §17`, `docs/api.md §35`). DRAFT / CANCELLED
   * и order-level документы (без `passportId`) сюда не попадают —
   * без `passportId` нельзя разнести расход по дню выпуска.
   */
  materialCost: number;
  /** Σ учтённых минут (`QC + WTO + PACKING`, с cap). */
  trackedMinutes: number;
  /** Σ неучтённых минут окладных сотрудников за день. */
  idleMinutes: number;
  /** `idleMinutes × minuteRate` суммарно по сотрудникам. */
  idleCost: number;
}

export interface ProductionCostSummaryDto {
  /** Σ `producedUnits` по всему периоду. */
  producedUnits: number;
  /** Σ `totalCost` (`pieceworkCost + salaryCost + materialCost`). */
  totalCost: number;
  /** Σ `pieceworkCost`. */
  pieceworkCost: number;
  /** Σ `salaryCost`. */
  salaryCost: number;
  /** Σ `materialCost` по периоду (см. `ProductionCostDayDto.materialCost`). */
  materialCost: number;
  /** Σ `idleCost`. */
  idleCost: number;
  /** Σ `trackedMinutes`. */
  trackedMinutes: number;
  /** Σ `idleMinutes`. */
  idleMinutes: number;
  /** `totalCost / producedUnits` (или 0, если выпуск 0). */
  avgCostPerUnit: number;
}

export interface ProductionCostResponseDto {
  dateFrom: string;
  dateTo: string;
  days: ProductionCostDayDto[];
  summary: ProductionCostSummaryDto;
}
