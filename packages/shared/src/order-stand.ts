/**
 * «Схема стенда» по заказу — `GET /api/orders/:id/stand`.
 *
 * Read-only проекция одного заказа в виде буквы «П» (см.
 * `docs/mockups/order-stand-mockup.html` и `docs/screens.md
 * §7.7`): левая нога — офис/склад (заказ, расчёт, материал),
 * перекладина — раскрой + шаги маршрута заказа, правая нога —
 * упаковка и «готово». В центре — стеллаж (ячейки) и паспорта
 * заказа с тем, где каждый лежит сейчас.
 *
 * Все `qrPayload` — штатные форматы ADR-0008 (`equipment:{id}`,
 * `cell:{id}`, `passport:{id}`, `box:{id}`): страница предназначена
 * для скана прямо с экрана рабочими кабинетами (`/work`, `/cutter`,
 * `/qc`, `/wto`, `/packing`).
 *
 * Счётчики по шагам считаются той же `bucketOf`, что и монитор цеха
 * (`/shopfloor/display`), поэтому «12 шт сшито» здесь и там совпадают.
 */
import type { OperationCategory } from './operations';
import type { ShopfloorStage } from './shopfloor';
import type { CutReadinessStatus, CutReadinessCheckStatus } from './cut-readiness';

/** Рабочее место (оборудование), подобранное под операцию шага. */
export interface OrderStandWorkplaceDto {
  id: string;
  code: string;
  name: string;
  displayNumber: string | null;
  /** `equipment:{id}` — ADR-0008. */
  qrPayload: string;
}

/**
 * Шаг маршрута заказа (снапшот `OrderRouteStep`). `index` — позиция в
 * маршруте, ею же живёт `Passport.currentRouteStepIndex`.
 */
export interface OrderStandStepDto {
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  category: OperationCategory;
  parallelGroup: number | null;
  outsourced: boolean;
  /** Основное рабочее место под операцию (активное, с этой операцией в allowed). */
  workplace: OrderStandWorkplaceDto | null;
  /** Названия остальных подходящих рабочих мест («ещё: Оверлок 02»). */
  otherWorkplaces: string[];
  /** Паспорта на руках у исполнителей на этом шаге прямо сейчас. */
  inWork: { passportNumber: string; employeeName: string }[];
  /** Σ qtyCut паспортов «на руках» на шаге. */
  qtyInWork: number;
  /** Σ qtyCut паспортов, ждущих на этом шаге без исполнителя (стеллаж, возврат). */
  qtyWaiting: number;
  /**
   * Σ qty паспортов, для которых шаг завершён: закрыт на нём (derived
   * `*_DONE` монитора) либо паспорт ушёл дальше по маршруту / упакован.
   * Для шага категории PACKING — Σ qtyGood упакованных.
   */
  qtyDone: number;
  passportsDone: number;
}

export const ORDER_STAND_PLACES = [
  /** Выпущен, но ещё не положен в ячейку. */
  'UNPLACED',
  /** Лежит в ячейке стеллажа. */
  'IN_CELL',
  /** На руках у исполнителя. */
  'IN_WORK',
  /** Шаг закрыт, ждёт скана следующего шага (буфер `*_DONE`). */
  'STEP_DONE',
  /** Без исполнителя и без ячейки (снят мастером, возврат на доработку). */
  'WAITING',
  /** В коробке. */
  'PACKED',
  'CANCELLED',
] as const;
export type OrderStandPlace = (typeof ORDER_STAND_PLACES)[number];

export const ORDER_STAND_PLACE_LABELS: Record<OrderStandPlace, string> = {
  UNPLACED: 'выпущен, не на стеллаже',
  IN_CELL: 'на стеллаже',
  IN_WORK: 'в работе',
  STEP_DONE: 'шаг закрыт, ждёт следующего',
  WAITING: 'ждёт исполнителя',
  PACKED: 'в коробке',
  CANCELLED: 'отменён',
};

export interface OrderStandPassportDto {
  id: string;
  number: string;
  /** `passport:{id}` — ADR-0008. */
  qrPayload: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  color: string;
  qtyCut: number;
  qtyGood: number;
  qtyDefect: number;
  rollNumber: string;
  status: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
  place: OrderStandPlace;
  /** Бакет монитора цеха (`bucketOf`); `null` для отменённых. */
  stage: ShopfloorStage | null;
  /** `Passport.currentRouteStepIndex` — шаг маршрута, где паспорт сейчас. */
  stepIndex: number | null;
  operationName: string | null;
  cell: { id: string; code: string } | null;
  employee: { id: string; fullName: string } | null;
  box: { id: string; number: string; closedAt: string | null } | null;
  /** ISO — последнее движение паспорта (`updatedAt`). */
  updatedAt: string;
  /** Подсказка «кто сканирует следующим» — для стенда. */
  nextHint: string;
}

export interface OrderStandCellDto {
  id: string;
  code: string;
  /** `cell:{id}` — ADR-0008. */
  qrPayload: string;
  /** Паспортов ЭТОГО заказа в ячейке. */
  passports: number;
  qty: number;
}

export interface OrderStandBoxDto {
  id: string;
  number: string;
  /** `box:{id}` — ADR-0008. */
  qrPayload: string;
  totalQty: number;
  closedAt: string | null;
  /** Паспортов этого заказа в коробке. */
  passports: number;
}

export interface OrderStandSizeDto {
  id: string;
  code: string;
  sortOrder: number;
  qtyPlan: number;
  qtyCut: number;
  qtyPacked: number;
}

export interface OrderStandReadinessDto {
  status: CutReadinessStatus;
  ready: boolean;
  blockersCount: number;
  warningsCount: number;
  materials: {
    description: string;
    unit: string;
    targetQty: string | number;
    receivedQty: string | number;
    status: CutReadinessCheckStatus;
  }[];
}

export interface OrderStandDto {
  order: {
    id: string;
    number: string;
    status: string;
    clientName: string | null;
    patternName: string | null;
    /** Расцветки заказа (`OrderVariant.color`), пусто — без расцветок. */
    colors: string[];
    qtyPlanTotal: number;
    orderDate: string;
    dueDate: string | null;
    createdAt: string;
    inProductionAt: string | null;
    completedAt: string | null;
    routeTemplateCode: string | null;
    routeTemplateName: string | null;
    costEstimateTotalRub: string | null;
    costEstimateCompletedAt: string | null;
  };
  sizes: OrderStandSizeDto[];
  /** `null`, если проверка готовности к крою недоступна (ошибка сервиса). */
  readiness: OrderStandReadinessDto | null;
  cutting: {
    /** `CuttingTask.status` (`NEW` / `IN_PROGRESS` / `DONE`) или `null`, если задания нет. */
    taskStatus: string | null;
    passports: number;
    qtyCut: number;
    sizesCut: number;
    sizesTotal: number;
    workplace: OrderStandWorkplaceDto | null;
    otherWorkplaces: string[];
  };
  steps: OrderStandStepDto[];
  cells: OrderStandCellDto[];
  passports: OrderStandPassportDto[];
  boxes: OrderStandBoxDto[];
  totals: {
    qtyPlan: number;
    qtyCut: number;
    qtyGood: number;
    qtyDefect: number;
    /** Σ qtyGood в открытых коробках. */
    qtyPacking: number;
    /** Σ qtyGood в закрытых коробках. */
    qtyFinished: number;
  };
  updatedAt: string;
}
