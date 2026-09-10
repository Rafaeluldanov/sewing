/**
 * Контракт «Документ производства по заказу» — план → факт по одному
 * заказу, построчно (Себестоимость, провал из вкладки «По заказам»
 * отчёта `/admin/production-cost`).
 *
 * Read-модель поверх существующих данных (новых таблиц нет). Разворачивает
 * агрегатный отчёт «Материалы: план → факт» (`order-actual-materials`) в
 * подробный документ по одному заказу: строки материалов и строки операций,
 * у каждой — план / факт / расхождение, с проваливанием в разбивку по
 * размерам/цветам.
 *
 * Источники (см. `apps/api/src/modules/costs/order-production-document.service.ts`):
 *   - ПЛАН материалов — активный `OrderCostEstimate` (деньги, по
 *     `workshopNeedId`), количество — `WorkshopNeed.calculatedQty`;
 *   - ФАКТ материалов — ДВА разных факта рядом:
 *       • «списано» — POSTED `MaterialIssueLine` (нетто за вычетом
 *         `MaterialIssueReturn`) — реальный расход в производство;
 *       • «принято» — POSTED `PurchaseReceiptLine` — приёмка на заказ;
 *   - ПЛАН операций — маршрут-снимок `OrderRouteStep` (+ переопределения)
 *     × `OrderItem.qtyPlan`, по той же формуле, что `OrderOperationPlanService`;
 *   - ФАКТ операций — `OperationEntry` «на текущий момент» (все, кроме
 *     CANCELLED/REVERSED — включая ещё не подтверждённые PENDING_RELEASE),
 *     плюс отдельно подсвечивается подтверждённая (APPROVED) часть.
 *
 * Себестоимость ПОТРЕБЛЯЕТ факт (расход, приёмки, выработка) — проводок не
 * пишет.
 */

/** Источник плановой стоимости материала строки. */
export const PRODUCTION_DOC_MATERIAL_PLAN_SOURCES = [
  'COST_ESTIMATE',
  'WORKSHOP_NEED',
  'NONE',
] as const;
export type ProductionDocMaterialPlanSource =
  (typeof PRODUCTION_DOC_MATERIAL_PLAN_SOURCES)[number];
export const PRODUCTION_DOC_MATERIAL_PLAN_SOURCE_LABELS: Record<
  ProductionDocMaterialPlanSource,
  string
> = {
  COST_ESTIMATE: 'Расчёт себестоимости',
  WORKSHOP_NEED: 'Потребность цеха',
  NONE: 'Нет плана',
};

/** Коды предупреждений по документу/строке. */
export const PRODUCTION_DOC_WARNING_LABELS: Record<string, string> = {
  USD_NO_RATE: 'Есть приёмки в USD без курса — не учтены в факте',
  NO_PRICE: 'Есть приёмки без цены — не учтены в факте',
  PLAN_USD_SKIPPED: 'План по потребности: USD-строки без курса не учтены',
  ISSUE_NOT_LINKED: 'Есть списания без привязки к плановой потребности',
  RECEIPT_NOT_LINKED: 'Есть приёмки без привязки к плановой потребности',
  OP_PLAN_INCOMPLETE: 'План операций неполный (нет ставки/нормы на часть операций)',
  NO_ROUTE: 'У заказа нет маршрута — план операций не рассчитан',
  SUBSTITUTE_FOLDED:
    'Факт закрыт на замещающей операции; план замещённых шагов свёрнут в эту строку',
  WORK_OUTSIDE_ROUTE:
    'Работа закрыта на операции, которой НЕТ в маршруте заказа: на гейте перед ОТК она не засчитается',
  NO_PLAN_QTY: 'Не заполнен план по размерам',
};

/**
 * Разбивка строки по размеру/цвету (провал). Для материалов `factQty` —
 * нетто-списание по размеру; для операций `factQty` — штук выполнено.
 * `planQty` для операций — план по (размер × цвет): у мультирасцветочных
 * заказов берётся из `OrderVariantSize` конкретной расцветки, иначе —
 * размерный агрегат. Для материалов обычно `null` (норма не поразмерная).
 */
export interface OrderProductionBreakdownDto {
  sizeCode: string | null;
  color: string | null;
  /** Плановое количество единиц по этому (размер × цвет) (или `null`). */
  planQty: number | null;
  /** Фактическое количество (Decimal-строка): списано / выполнено. */
  factQty: string;
  /** Фактическая сумма по размеру, ₽ (Decimal-строка). */
  factRub: string;
}

/** Строка материала документа. */
export interface OrderProductionMaterialRowDto {
  /** `workshopNeedId` либо синтетический ключ для непривязанных строк. */
  key: string;
  name: string;
  unit: string;
  materialRole: string | null;

  // --- ПЛАН ---
  /** Плановое количество (Decimal-строка) — `WorkshopNeed.calculatedQty`. */
  planQty: string | null;
  /** Плановая стоимость, ₽ (Decimal-строка). */
  planRub: string | null;
  planSource: ProductionDocMaterialPlanSource;

  // --- ФАКТ «списано» (расход в производство) ---
  /** Нетто-списание, кол-во (Decimal-строка). */
  issuedQty: string;
  /** Нетто-списание, ₽ (Decimal-строка). */
  issuedRub: string;

  // --- ФАКТ «принято» (приёмка на заказ) ---
  /** Принято, кол-во (Decimal-строка). */
  receivedQty: string;
  /** Принято, ₽ (Decimal-строка). */
  receivedRub: string;

  /** `issued − plan` по деньгам (Decimal-строка; «+» = перерасход). `null` — плана нет. */
  varianceRub: string | null;
  warnings: string[];
  /** Провал: списание по размерам/цветам (может быть пустым). */
  breakdown: OrderProductionBreakdownDto[];
}

/** Строка операции документа. */
export interface OrderProductionOperationRowDto {
  /** `operationId`. */
  key: string;
  index: number;
  operationCode: string;
  operationName: string;

  // --- ПЛАН ---
  /** Плановое количество единиц через операцию (Σ `qtyPlan`). */
  planQty: number | null;
  /** Плановое время, сек (целое). */
  planTimeSec: number | null;
  /** Плановая стоимость, ₽ (Decimal-строка). */
  planRub: string | null;

  // --- ФАКТ (на текущий момент) ---
  /** Штук выполнено — Σ `OperationEntry.qty` (не CANCELLED/REVERSED). */
  factQty: number;
  /** Фактическая стоимость, ₽ — Σ `OperationEntry.amount`. */
  factRub: string;
  /** Из них подтверждено (APPROVED), ₽. */
  factApprovedRub: string;

  /**
   * СТОРОННИЕ УСЛУГИ: операцию (частью или целиком) делает подрядчик
   * (`OrderRouteStep.outsourced`). В `planRub` по отданному объёму стоит
   * стоимость размещения, а не своя расценка; факта по этому объёму не
   * будет — его никто не сканирует, и это НОРМА, а не расхождение.
   *
   * Отдельным полем, а не кодом в `warnings`: warnings в UI читаются как
   * проблема (иконка ⚠/🚫), а подряд — плановое решение менеджера.
   */
  outsourced: boolean;
  /**
   * Сколько из `planRub` — стоимость стороннего размещения (Decimal-строка).
   * `null` — подряда по строке нет. Для сравнения план/факт: разница
   * `planRub − outsourcePlanRub` — это то, что цех действительно делает сам.
   */
  outsourcePlanRub: string | null;

  /**
   * `факт − план ПО СВОЕЙ РАБОТЕ`, то есть `factRub − (planRub −
   * outsourcePlanRub)` (Decimal-строка). `null` — плана нет.
   *
   * Размещение из базы исключено намеренно: по отданному подрядчику
   * объёму скана не будет никогда, и включать его в отклонение значило бы
   * вечно показывать «экономию» на сумму подряда. У операции, отданной
   * целиком, отклонение считается от нуля — то есть равно факту, который
   * там обычно и есть ноль.
   */
  varianceRub: string | null;
  /**
   * Пометки строки. Значения:
   *   - `SUBSTITUTE_FOLDED` — факт закрыт на замещающей операции, план
   *     замещённых шагов свёрнут в эту строку (это НОРМА, см. PF3);
   *   - `WORK_OUTSIDE_ROUTE` — факт есть, а планового шага нет и
   *     легальной замены тоже нет. То есть работу закрыли на операции,
   *     которой в маршруте заказа НЕТ. Такая работа не засчитается на
   *     гейте перед ОТК: партия встанет. Раньше такая строка молча
   *     уезжала в конец документа (`index: 9000`) неотличимо от
   *     свёрнутых замен, и по документу нельзя было понять, что заказ
   *     идёт не по плану, — инцидент 28.07.2026 (70 паспортов, 8
   *     заказов, лаг обнаружения 27 дней).
   */
  warnings: string[];
  /** Провал: выработка по размерам/цветам. */
  breakdown: OrderProductionBreakdownDto[];
}

/** Шапка документа. */
export interface OrderProductionDocumentHeaderDto {
  orderId: string;
  orderNumber: string;
  /** `OrderStatus` строкой (DRAFT/IN_PRODUCTION/…). */
  status: string;
  clientName: string | null;
  nomenclatureName: string | null;
  nomenclatureArticle: string | null;
  color: string | null;
  /** Σ `OrderItem.qtyPlan`. */
  qtyPlanTotal: number;
  /** Σ `Passport.qtyCut` по заказу. */
  qtyCutTotal: number;
  /** Σ `Passport.qtyGood` по УПАКОВАННЫМ (PACKED) паспортам. */
  qtyGoodPackedTotal: number;
  /** Σ `Passport.qtyGood` по всем паспортам (частичный выпуск). */
  qtyGoodTotal: number;
  /** Σ `Passport.qtyDefect` по заказу. */
  qtyDefectTotal: number;
  /** Готовность = `qtyGoodPacked / qtyPlan × 100`, округл. до целых. */
  readinessPct: number;
  /** Выручка = `customerUnitPrice × qtyPlan` (только RUB; иначе `null`). */
  revenueRub: string | null;
  revenueCurrency: string | null;
  /**
   * Плановая прямая себестоимость за единицу = прямая с/с (план) ÷
   * плановое количество. `null`, если `qtyPlan = 0`.
   */
  planUnitCostRub: string | null;
  /**
   * Фактическая прямая себестоимость за единицу = прямая с/с (факт,
   * списание + операции) ÷ фактически выпущено годного (Σ qtyGood).
   * `null`, если годного пока нет (нечего делить). На незавершённом
   * заказе значение частичное.
   */
  factUnitCostRub: string | null;
  /** `factUnit − planUnit` (Decimal-строка; «+» = дороже плана). `null`, если нет одной из частей. */
  unitCostVarianceRub: string | null;
}

/** Итоги документа. */
export interface OrderProductionDocumentTotalsDto {
  planMaterialsRub: string;
  issuedMaterialsRub: string;
  receivedMaterialsRub: string;
  /** `issued − plan` по материалам. */
  varianceMaterialsRub: string;

  /** План операций ЦЕЛИКОМ: своя работа + стоимость стороннего размещения. */
  planOperationsRub: string;
  /**
   * Факт операций — только СВОЯ работа (Σ `OperationEntry.amount`). По
   * объёму, отданному подрядчику, скана в цеху не будет никогда, поэтому
   * сюда он не попадает; в прямой себестоимости он признаётся по плану
   * (см. `factDirectRub`).
   */
  factOperationsRub: string;
  /**
   * СТОРОННИЕ УСЛУГИ: сколько из `planOperationsRub` — размещение у
   * подрядчика (Σ `outsourcePlanRub` строк). Расшифровка «в том числе»,
   * складывать с планом нельзя.
   */
  planOutsourceRub: string;
  /**
   * `факт − план ПО СВОЕЙ РАБОТЕ` = `factOperations − (planOperations −
   * planOutsource)`. Размещение из базы отклонения исключено намеренно:
   * иначе отданная подрядчику операция вечно показывала бы «экономию» на
   * всю сумму подряда — работу, которую цех не делал и делать не должен.
   */
  varianceOperationsRub: string;

  /** Прямая с/с план = материалы(план) + операции(план, вместе с размещением). */
  planDirectRub: string;
  /**
   * Прямая с/с факт = материалы(списано) + операции(факт своей работы) +
   * стороннее размещение ПО ПЛАНУ. Подряд признаётся плановой суммой —
   * своего факта у него в цехе нет (акт подрядчика живёт документом в
   * ERP, `docs/kb/sewing.md §6`). Не включать его сюда значило бы
   * занизить себестоимость и завысить маржу ровно на деньги подрядчика.
   */
  factDirectRub: string;
  varianceDirectRub: string;

  revenueRub: string | null;
  /** Маржа = выручка − прямая с/с факт (только если выручка в RUB). */
  marginRub: string | null;
}

export interface OrderProductionDocumentDto {
  header: OrderProductionDocumentHeaderDto;
  materials: OrderProductionMaterialRowDto[];
  operations: OrderProductionOperationRowDto[];
  totals: OrderProductionDocumentTotalsDto;
  /** Сводные предупреждения по документу (см. `PRODUCTION_DOC_WARNING_LABELS`). */
  warnings: string[];
}
