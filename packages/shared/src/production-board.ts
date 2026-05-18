/**
 * Контракты «Доски движения тиража» для кабинета мастера
 * (`apps/api/src/modules/production-board/*`, вкладка «Движение тиража»
 * в `apps/web/app/master`).
 *
 * Назначение: дать `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * сводную картину «что происходит с кроем, выданным за день» —
 * по реальным операциям маршрута (источник тот же, что «Экран цеха»:
 * `REFERENCE_OPERATIONS`).
 *
 * Модель — «когорта по дате выдачи кроя»:
 *   - строка = день (`Passport.cutDate`, UTC);
 *   - первый блок = сверка `Выдано` (события `ISSUED_TO_EMPLOYEE`) vs
 *     `В работе` (паспорта с ≥1 `OPERATION_SCAN`); разница =
 *     «не взято в операцию»;
 *   - колонки = операции пошива и далее (Оверлок 1 → … → Упаковка);
 *   - финал = `Выпущено` (`PassportStatus = PACKED`).
 *
 * Штуки: для «выдано» — `qtyCut` (физически выдано в крое); для
 * «в работе» / «выпущено» — `qtyGood` (за вычетом брака). Брак —
 * `Passport.qtyDefect`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const PRODUCTION_BOARD_PERIODS = [7, 14, 30] as const;
export type ProductionBoardPeriod = (typeof PRODUCTION_BOARD_PERIODS)[number];
export const DEFAULT_PRODUCTION_BOARD_PERIOD: ProductionBoardPeriod = 14;

/**
 * Период доски в днях (включая сегодня) по `Passport.cutDate`.
 * Допустимы 7/14/30; всё прочее мягко падает в дефолт (как у дашборда).
 */
export const ProductionBoardQuerySchema = z.object({
  days: z
    .preprocess((v) => {
      if (typeof v === 'string' && v.trim().length > 0) {
        const n = Number(v);
        if (Number.isInteger(n)) return n;
      }
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      return undefined;
    }, z.union([z.literal(7), z.literal(14), z.literal(30)]).optional())
    .transform((v) => v ?? DEFAULT_PRODUCTION_BOARD_PERIOD),
});
export type ProductionBoardQuery = z.infer<typeof ProductionBoardQuerySchema>;

// ---------------------------------------------------------------------------
// Stage columns
// ---------------------------------------------------------------------------

/**
 * Колонки доски = операции маршрута с первой пошивочной операции
 * (взятие кроя = первый Оверлок) до упаковки. `code` совпадает с
 * `REFERENCE_OPERATIONS.code` (`apps/api/src/modules/bootstrap`).
 * Раскладка паспорта по колонке — по `currentOperation.code`.
 */
export const PRODUCTION_BOARD_STAGES = [
  { code: 'SEW_OVERLOCK_1', label: 'Оверлок 1' },
  { code: 'SEW_BINDING', label: 'Киперка' },
  { code: 'SEW_OVERLOCK_2', label: 'Оверлок 2' },
  { code: 'SEW_COVERSTITCH', label: 'Распошив' },
  { code: 'QC', label: 'ОТК' },
  { code: 'WTO', label: 'ВТО' },
  { code: 'PACKING', label: 'Упаковка' },
] as const;

export type ProductionBoardStageCode =
  (typeof PRODUCTION_BOARD_STAGES)[number]['code'];

/** Псевдо-стадия финального столбца «Выпущено» (статус PACKED). */
export const PRODUCTION_BOARD_RELEASED = '__released__' as const;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface ProductionBoardEmployeeDto {
  employeeId: string;
  employeeName: string;
  /** Паспортов этого сотрудника на этой операции в этой когорте. */
  passports: number;
  /** Σ `qtyGood`. */
  qty: number;
  /** Σ `qtyDefect`. */
  defects: number;
}

export interface ProductionBoardStageBucketDto {
  code: ProductionBoardStageCode;
  passports: number;
  qty: number;
  defects: number;
  /** Отсортированы по `passports` убыв.; UI берёт топ-2 + «ещё N». */
  employees: ProductionBoardEmployeeDto[];
  /** Паспорта когорты, ещё не дошедшие до этой операции по маршруту. */
  notReached: number;
}

export interface ProductionBoardCohortDto {
  /** UTC-дата `YYYY-MM-DD` (день `Passport.cutDate`). */
  cutDate: string;
  orderId: string | null;
  orderLabel: string;
  /** Паспортов выдано (есть событие `ISSUED_TO_EMPLOYEE`). */
  issuedPassports: number;
  /** Σ `qtyCut` выданных паспортов. */
  issuedQty: number;
  /** Паспортов в работе (есть ≥1 `OPERATION_SCAN`). */
  inOpsPassports: number;
  /** Σ `qtyGood` паспортов в работе. */
  inOpsQty: number;
  /** Выдано, но не взято ни в одну операцию (issued − inOps). */
  notPickedPassports: number;
  /** Паспортов выпущено (`PassportStatus = PACKED`). */
  releasedPassports: number;
  /** Σ `qtyGood` выпущенных. */
  releasedQty: number;
  /** Бакеты по операциям, в порядке `PRODUCTION_BOARD_STAGES`. */
  stages: ProductionBoardStageBucketDto[];
}

export interface ProductionBoardDto {
  /** UTC-дата `YYYY-MM-DD`. */
  from: string;
  to: string;
  stages: { code: ProductionBoardStageCode; label: string }[];
  /** Когорты по дате кроя, новые сверху. */
  cohorts: ProductionBoardCohortDto[];
}

// ---------------------------------------------------------------------------
// Drill-down (клик по ячейке стадии / по столбцу «Выпущено»)
// ---------------------------------------------------------------------------

export const ProductionBoardDrillQuerySchema = z.object({
  /** UTC-дата `YYYY-MM-DD` когорты. */
  cutDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Код операции из `PRODUCTION_BOARD_STAGES` либо `__released__`. */
  stage: z.string().min(1),
  /** Сузить до конкретного сотрудника (опц.). */
  employeeId: z.string().min(1).optional(),
});
export type ProductionBoardDrillQuery = z.infer<
  typeof ProductionBoardDrillQuerySchema
>;

export interface ProductionBoardPassportRowDto {
  passportId: string;
  number: string;
  sizeCode: string;
  /** `qtyGood` паспорта. */
  qty: number;
  /** `qtyDefect` паспорта. */
  defects: number;
  /** Текущий исполнитель (или упаковщик для «Выпущено»); `null` если нет. */
  employeeName: string | null;
}

export interface ProductionBoardDrillEmployeeGroupDto {
  employeeId: string | null;
  employeeName: string;
  passports: number;
  qty: number;
  defects: number;
  rows: ProductionBoardPassportRowDto[];
}

export interface ProductionBoardDrillDto {
  cutDate: string;
  stageLabel: string;
  totalPassports: number;
  totalQty: number;
  totalDefects: number;
  /** Сгруппировано по сотруднику (для «Выпущено» — один блок-упаковка). */
  groups: ProductionBoardDrillEmployeeGroupDto[];
}
