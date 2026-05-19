/**
 * Контракты «Доски движения тиража» для кабинета мастера
 * (`apps/api/src/modules/production-board/*`, вкладка «Движение тиража»
 * в `apps/web/app/master`).
 *
 * Назначение: дать `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * сводную картину «что происходит с кроем, ВЫДАННЫМ В РАБОТУ за день» —
 * по реальным операциям маршрута (источник тот же, что «Экран цеха»:
 * `REFERENCE_OPERATIONS`).
 *
 * Модель — «когорта по дате выдачи кроя швеям»:
 *   - строка = UTC-день ПЕРВОГО события `ISSUED_TO_EMPLOYEE` паспорта
 *     (день, когда крой выдали в работу). НЕ `Passport.cutDate` —
 *     крой, раскроенный 05.05 и выданный швеям 18.05, должен быть в
 *     строке 18.05, иначе мастер «не видит вчерашнюю выдачу»;
 *   - окно периода тоже по дате выдачи: паспорт попадает на доску,
 *     если его `ISSUED_TO_EMPLOYEE` есть в окне последних N дней;
 *   - первый блок = сверка `Выдано` (все паспорта когорты) vs
 *     `В работе` (есть ≥1 `OPERATION_SCAN`/`STARTED`/`FINISHED`);
 *     разница = «не взято в операцию»;
 *   - колонки = РЕАЛЬНЫЕ операции маршрута заказов когорты
 *     (`OrderRouteStep` snapshot, дедуп по операции, сорт по
 *     `Operation.sortOrder`) — тот же источник и тот же резолвер
 *     текущей операции паспорта, что у «Экрана цеха»
 *     (`/api/shopfloor/display`). Сколько оверлоков реально в
 *     маршруте — столько и колонок;
 *   - финал = `Выпущено` (`PassportStatus = PACKED`).
 *
 * Штуки: «выдано» / «в работе» / ячейки операций — `qtyCut`
 * (физический объём кроя, как на «Экране цеха»); «выпущено» —
 * `qtyGood` (за вычетом брака, как KPI display). Брак —
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
 * Период доски в днях (включая сегодня) по ДАТЕ ВЫДАЧИ кроя швеям
 * (`ISSUED_TO_EMPLOYEE`), не по `Passport.cutDate`.
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
 * Колонки доски — НЕ статический список. Они вычисляются на бэке из
 * `OrderRouteStep` snapshot'ов заказов, чьи паспорта попали в окно
 * когорты: каждая уникальная операция маршрута → одна колонка,
 * порядок — по `Operation.sortOrder`. Это тот же источник операций,
 * что у «Экрана цеха» (`buildSewingRoute` в `ShopfloorService`):
 * сколько оверлоков / какие операции реально в маршруте — столько и
 * таких колонок, без фантомных.
 *
 * `code` = `Operation.code` (совпадает с `REFERENCE_OPERATIONS.code`,
 * `apps/api/src/modules/bootstrap`). Раскладка паспорта по колонке —
 * через резолвер текущей операции (см.
 * `ProductionBoardService.resolveCurrentOpId`), а не по сырому
 * `currentOperation.code`. Поэтому тип кода стадии — открытый `string`.
 */
export type ProductionBoardStageCode = string;

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
  /** UTC-дата `YYYY-MM-DD` — день выдачи кроя швеям (первый
   * `ISSUED_TO_EMPLOYEE` паспортов когорты). */
  issueDate: string;
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
  /** Бакеты по операциям маршрута, в порядке `Operation.sortOrder`. */
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
  /** UTC-дата `YYYY-MM-DD` когорты (день выдачи кроя швеям). */
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** `Operation.code` одной из колонок доски либо `__released__`. */
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
  issueDate: string;
  stageLabel: string;
  totalPassports: number;
  totalQty: number;
  totalDefects: number;
  /** Сгруппировано по сотруднику (для «Выпущено» — один блок-упаковка). */
  groups: ProductionBoardDrillEmployeeGroupDto[];
}
