/**
 * Контракты модуля «Себестоимость выпуска» (Production Cost).
 *
 * Управленческий read-only модуль (ADR-0021 family). Источник истины —
 * backend (`/api/costs/production`), бизнес-правила — `docs/domain.md
 * §17` («Себестоимость выпуска»).
 *
 * Скоуп MVP сознательно ограничен:
 *   - агрегируем по дню упаковки паспорта (`PACKED` event date);
 *   - себестоимость = piecework + окладная доля по ФАКТУ ВЫПОЛНЕННЫХ
 *     РАБОТ (решение владельца 14.09.2026): операции со своим accept —
 *     хронометраж `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` в рамке смены
 *     сотрудника; терминалы без accept (`QC` / `WTO` / `PACKING`) — норма
 *     времени операции × объём паспорта (см.
 *     `apps/api/src/modules/costs/passport-real-cost.service.ts`);
 *   - неучтённое время = `оплачено − Σ tracked` для окладного сотрудника,
 *     бывшего на смене в этот день (`SalaryEntry.workedSeconds` у
 *     почасовика, закрытые `ShiftSession` у месячника; `SHIFT_MINUTES` —
 *     фолбэк для legacy-строк без `workedSeconds`; аудит движка расчёта
 *     13.09.2026, F1-1 / F1-2);
 *   - простой НЕ распределяется на изделия (см. ТЗ §11).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Длительность смены в минутах. Управленческая константа MVP времён
 * плоской ставки за смену (ADR-0021 до ревизии 2026-06). После перехода
 * на почасовую оплату «оплачено» берётся из `SalaryEntry.workedSeconds` /
 * длительности закрытых смен, а константа — фолбэк для legacy-строк без
 * `workedSeconds` и «оплачено» в дашборде (аудит движка расчёта
 * 13.09.2026, F1-2).
 */
export const SHIFT_MINUTES = 480;

/**
 * Максимальная длительность одной стадии (`QC` / `WTO` / `PACKING`)
 * по одному паспорту, в минутах — потолок для ДЛИТЕЛЬНОСТЕЙ СТАДИЙ
 * дашборда (`PassportDurationsService`: воронка, аномальные паспорта).
 *
 * В себестоимости с 14.09.2026 не используется: хронометраж режется
 * рамкой смены сотрудника, а не константой, терминалы без accept
 * считаются по норме × объём (решение владельца).
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
  /**
   * Предупреждения расчёта (аудит движка расчёта 13.09.2026, F1-3, ревью):
   * сейчас — «окно разноса оклада выпущенных паспортов ограничено N дн.
   * назад» (оклад ретро-паспорта учтён не полностью). Отсутствует/пуст,
   * когда сказать нечего.
   */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Себестоимость одного паспорта (факт) — `GET /api/costs/passport/:id`
// ---------------------------------------------------------------------------

/**
 * Основание минут в строке оклада (решение владельца 14.09.2026):
 *   - `TIMED`  — хронометраж «взял → сдал» в рамке смены, нахлёсты
 *                поделены между одновременно удерживаемыми паспортами;
 *   - `NORMED` — норма времени операции × количество по отметке
 *                (терминалы ОТК/ВТО/упаковки, у которых accept-а нет).
 */
export type PassportCostSalaryBasis = 'TIMED' | 'NORMED';

/**
 * Одна строка распределённого оклада в себестоимости паспорта: сколько
 * времени конкретный окладной сотрудник потратил на этот паспорт в
 * рамках одной операции (по хронометражу или по норме — `basis`), и во
 * что это обошлось (`minutes × ставка/мин`).
 */
export interface PassportCostSalaryLineDto {
  operationId: string | null;
  operationCode: string | null;
  operationName: string | null;
  employeeId: string;
  employeeName: string;
  /** Разнесённые минуты (округлены до 1 знака). */
  minutes: number;
  /** `minutes × minuteRate` (округлено до копеек). */
  rub: number;
  /** Откуда минуты — хронометраж или норма. */
  basis: PassportCostSalaryBasis;
  /** Для `NORMED` — количество изделий по отметке; для `TIMED` — `null`. */
  qty: number | null;
}

/**
 * Фактическая себестоимость одного паспорта (см. `docs/domain.md §17`).
 *
 *   total = material(нетто) + piecework(APPROVED) + salary(разнесённый оклад)
 *   perUnit = total / qtyGood
 *
 * Окладная часть — факт выполненных работ (решение владельца
 * 14.09.2026): хронометраж `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` в
 * рамке смены с разносом нахлёстов, а для терминалов ОТК/ВТО/упаковки —
 * норма времени операции × объём (см. `PassportCostSalaryBasis`).
 * Простой на единицу НЕ распределяется.
 */
export interface PassportCostDto {
  passportId: string;
  passportNumber: string;
  productName: string | null;
  sizeCode: string | null;
  qtyGood: number;
  /** Σ `MaterialIssue.totalCost` − возвраты (POSTED), 0 если политика EXCLUDE. */
  materialCost: number;
  /** Σ `OperationEntry.amount` (APPROVED). */
  pieceworkCost: number;
  /** Σ разнесённого оклада по всем окладным сотрудникам/операциям. */
  salaryCost: number;
  /** `materialCost + pieceworkCost + salaryCost`. */
  totalCost: number;
  /** `totalCost / qtyGood` (или 0 при нулевом выпуске). */
  perUnitCost: number;
  /** Детализация окладной части. */
  salaryLines: PassportCostSalaryLineDto[];
  /**
   * `true`, если суммы взяты из финализированного снимка
   * (`PassportCostSnapshot.status = FINAL`) — стабильное аудируемое
   * значение. `false` — live-расчёт (день упаковщика ещё может
   * дополняться, разнос оклада предварительный).
   */
  isFinal: boolean;
  /** Когда снимок финализирован (ISO), или `null` для live-расчёта. */
  finalizedAt: string | null;
}

/** Результат финализации дня (`POST /api/costs/snapshots/finalize`). */
export interface FinalizeDayResultDto {
  /** UTC-дата, за которую финализированы снимки (`YYYY-MM-DD`). */
  date: string;
  /** Сколько паспортов получили `FINAL`-снимок. */
  finalized: number;
}
