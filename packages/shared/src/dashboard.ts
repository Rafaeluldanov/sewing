/**
 * Контракты управленческого дашборда «Дашборд начальника производства»
 * (`/admin/production-dashboard`, `GET /api/dashboard/production`).
 *
 * Read-only management screen, который собирает в одном ответе всё, что
 * раньше было размазано по `/shopfloor`, `/production-cost`, `/admin/overview`,
 * `/earnings` и `/admin/employees`. Источник истины — backend; UI строит
 * только разметку.
 *
 * Источники данных (без новых таблиц/событий):
 *   - `Passport` / `Order` — pipeline-buckets и WIP (см. ADR-0013);
 *   - `PassportEvent.PACKED` — выпуск сегодня и за период;
 *   - `OperationEntry` (APPROVED) + `SalaryEntry` + `PassportDurationsService`
 *     — себестоимость, простой, загрузка по дням и по ролям (см. §17);
 *   - `Employee.compensationType` + `salaryPerShift` — стоимость минуты.
 *
 * Период (`days`) применяется к серии графика и к расчёту role load
 * по дню «to». KPI «сегодня» считаются всегда по UTC-сегодня независимо
 * от `days` — это часть управленческого контракта (см. `screens.md §18`).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Допустимые длины периода для графика и сводок «по периоду».
 * Закрытый список вместо произвольного числа — управленческий выбор:
 * экран отвечает на «как изменилось за неделю / две / месяц», без
 * произвольных интервалов (drill-down — за рамками).
 */
export const PRODUCTION_DASHBOARD_PERIODS = [7, 14, 30] as const;
export type ProductionDashboardPeriod =
  (typeof PRODUCTION_DASHBOARD_PERIODS)[number];

/**
 * Дефолтный период — 7 дней, потому что начальник производства открывает
 * дашборд чаще «по горячим следам последней недели», чем за месяц.
 */
export const DEFAULT_PRODUCTION_DASHBOARD_PERIOD: ProductionDashboardPeriod = 7;

/**
 * Стадии pipeline-блока. Полностью совпадают со списком этапов
 * `/shopfloor` (см. `@sewing/shared/shopfloor` `SHOPFLOOR_STAGES`),
 * чтобы у дашборда и доски «Цех» был один словарь.
 */
export const PRODUCTION_DASHBOARD_STAGES = [
  'CUT',
  'SEWING',
  'QC',
  'QC_DONE',
  'WTO',
  'WTO_DONE',
  'PACKING',
  'FINISHED',
] as const;
export type ProductionDashboardStage =
  (typeof PRODUCTION_DASHBOARD_STAGES)[number];

/**
 * Роли, по которым считается load-summary. Берём только окладные
 * терминальные роли pipeline (ОТК / ВТО / упаковка): сдельщина (швея,
 * раскройщик) считается отдельно через `OperationEntry` и в простой не
 * входит. Рабочие шли бы строкой «всегда 0% простоя» — это шум.
 */
export const PRODUCTION_DASHBOARD_ROLES = [
  'QC',
  'IRONING',
  'PACKING',
] as const;
export type ProductionDashboardRole =
  (typeof PRODUCTION_DASHBOARD_ROLES)[number];

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const ProductionDashboardQuerySchema = z.object({
  /**
   * Длина периода в днях (включая сегодня). Допустимы 7/14/30; всё, что
   * не из этого набора, отсекается на уровне `coerce` → `default`.
   */
  days: z
    .preprocess((v) => {
      if (typeof v === 'string' && v.trim().length > 0) {
        const n = Number(v);
        if (Number.isInteger(n)) return n;
      }
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      return undefined;
    }, z.union([z.literal(7), z.literal(14), z.literal(30)]))
    .optional()
    .default(DEFAULT_PRODUCTION_DASHBOARD_PERIOD),
});
export type ProductionDashboardQuery = z.infer<
  typeof ProductionDashboardQuerySchema
>;

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * KPI-карточки в шапке экрана. Все «сегодня»-метрики считаются по
 * UTC-сегодня; это часть контракта — backend всегда возвращает один
 * день для KPI и `days` дней для графика/period summary, чтобы UI не
 * перемешивал цифры.
 */
export interface ProductionDashboardKpiDto {
  /** Σ `Passport.qtyGood` по PACKED-событиям за UTC-сегодня. */
  producedToday: number;
  /** Σ `Passport.qtyGood` по PACKED-событиям за весь период. */
  producedPeriod: number;
  /** Σ `qtyCut` по живым паспортам (`status ∈ {CREATED, IN_PROGRESS}`). */
  wipUnits: number;
  /** Кол-во паспортов в работе (`status ∈ {CREATED, IN_PROGRESS}`). */
  wipPassports: number;
  /** Кол-во заказов со статусом `IN_PRODUCTION`. */
  ordersInProduction: number;
  /** Себестоимость / шт за UTC-сегодня (0, если выпуска нет). */
  avgCostPerUnitToday: number;
  /** Стоимость простоя за UTC-сегодня. */
  idleCostToday: number;
  /**
   * Загруженность цеха = `tracked / (tracked + idle)` за UTC-сегодня
   * по окладным ролям, в процентах от 0 до 100. Если не было ни смен,
   * ни выпуска — 0.
   */
  utilizationToday: number;
  /** Стоимость простоя за весь период. */
  idleCostPeriod: number;
  /** Себестоимость выпуска за период (`pieceworkCost + salaryCost`). */
  totalCostPeriod: number;
}

/**
 * Один stage в pipeline-блоке. `qty` — количество единиц (`qtyCut` для
 * живых стадий, `qtyGood` для PACKING/FINISHED), `passports` —
 * количество живых паспортов в этой стадии. Пара даёт менеджеру и
 * «сколько в шт.», и «сколько паспортов в очереди».
 */
export interface ProductionDashboardPipelineStageDto {
  stage: ProductionDashboardStage;
  qty: number;
  passports: number;
}

export interface ProductionDashboardPipelineDto {
  stages: ProductionDashboardPipelineStageDto[];
  /** Суммарный брак (`Σ Passport.qtyDefect` по не-CANCELLED). */
  defectQty: number;
  /**
   * Стадия-«узкое место»: та, у которой `qty` максимальный среди живых
   * (`CUT..PACKING`), исключая `FINISHED`. `null`, если pipeline пустой.
   */
  bottleneckStage: ProductionDashboardStage | null;
  /** Кол-во единиц в бутылочном горлышке (для подписи). */
  bottleneckQty: number;
}

/**
 * Один день для графика динамики. Подмножество
 * `ProductionCostDayDto` — заданное здесь, чтобы UI дашборда не зависел
 * от структуры production-cost-страницы и можно было дешевле эволюировать.
 */
export interface ProductionDashboardTrendDayDto {
  /** UTC-дата `YYYY-MM-DD`. */
  date: string;
  producedUnits: number;
  totalCost: number;
  idleCost: number;
}

/**
 * Загрузка по одной роли за день «to» периода. Считается так же, как
 * на `/production-cost`, но сгруппировано по `Employee.role`:
 *   - `paidMinutes`   = `count(SALARY_employees with SalaryEntry today)`
 *                       × `SHIFT_MINUTES`;
 *   - `trackedMinutes`= Σ stage.durationMinutes этих сотрудников за день;
 *   - `idleMinutes`   = max(0, paid − tracked);
 *   - `idleCost`      = Σ idle_per_employee × employee.minuteRate;
 *   - `utilization`   = round(tracked / paid × 100), 0 если paid = 0.
 */
export interface ProductionDashboardRoleLoadDto {
  role: ProductionDashboardRole;
  /** Кол-во сотрудников этой роли с `SalaryEntry` за день «to». */
  employees: number;
  paidMinutes: number;
  trackedMinutes: number;
  idleMinutes: number;
  idleCost: number;
  /** 0..100. */
  utilization: number;
}

/**
 * Один alert в блоке «Требует внимания». Тип сужает причину — UI
 * отрисовывает каждый тип своей иконкой/цветом, не парся `message`.
 */
export type ProductionDashboardAlertType =
  | 'PIPELINE_BOTTLENECK'
  | 'ROLE_IDLE'
  | 'EMPLOYEE_IDLE'
  | 'PEAK_IDLE_DAY'
  | 'CAPPED_PASSPORTS';

export type ProductionDashboardAlertSeverity = 'INFO' | 'WARN' | 'CRIT';

export interface ProductionDashboardAlertDto {
  type: ProductionDashboardAlertType;
  severity: ProductionDashboardAlertSeverity;
  /** Готовая русскоязычная подпись для UI. */
  message: string;
  /** Опциональное численное значение «сколько именно» — для подписи справа. */
  value?: number;
  /** Опциональная единица измерения для `value` (₽, шт, мин, %). */
  unit?: '₽' | 'шт' | 'мин' | '%';
  /** Опциональная ссылка для drill-down (например, на `/shopfloor`). */
  href?: string;
}

/**
 * Полный ответ `GET /api/dashboard/production`.
 */
export interface ProductionDashboardDto {
  /** Когда сервер сформировал ответ (ISO). */
  generatedAt: string;
  /** Календарная UTC-дата «сегодня», которая использовалась в KPI. */
  today: string;
  /** Длина периода в днях (включая сегодня). */
  periodDays: ProductionDashboardPeriod;
  /** UTC-дата начала периода (включительно), `YYYY-MM-DD`. */
  dateFrom: string;
  /** UTC-дата конца периода (включительно), `YYYY-MM-DD`. */
  dateTo: string;

  kpi: ProductionDashboardKpiDto;
  pipeline: ProductionDashboardPipelineDto;
  trend: ProductionDashboardTrendDayDto[];
  roleLoad: ProductionDashboardRoleLoadDto[];
  alerts: ProductionDashboardAlertDto[];
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

export const PRODUCTION_DASHBOARD_STAGE_LABELS: Record<
  ProductionDashboardStage,
  string
> = {
  CUT: 'Крой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  QC_DONE: 'Проверено ОТК',
  WTO: 'ВТО',
  WTO_DONE: 'ВТО завершено',
  PACKING: 'Упаковка',
  FINISHED: 'Выпущено',
};

export const PRODUCTION_DASHBOARD_ROLE_LABELS: Record<
  ProductionDashboardRole,
  string
> = {
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};
