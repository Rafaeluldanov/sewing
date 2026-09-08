/**
 * Контракт «ДОКУМЕНТ ВЫПУСКА ПО ЗАКАЗУ» (`ProductionDocument`).
 *
 * ⛔ Не путать с `order-production-document.ts` — там read-модель «план → факт» отчёта
 * себестоимости, которая ничего не хранит. Здесь — настоящий документ: он рождается закрытием
 * заказа, собирается САМ из фактов производства и хранит снимок себестоимости.
 *
 * Состояний ровно два, и оба наступают без человека:
 *   `FORMING` — факты ещё идут: открыта коробка, начисления не подтверждены;
 *   `READY`   — лёг последний факт, себестоимость записана снимком.
 *
 * Кнопки «провести» нет и не будет: выпуск — это то, что цех уже сделал, а не то, что кто-то
 * подтвердил. По той же причине нет и согласования со стороны ERP: она читает готовые документы.
 */

/** Состояние документа выпуска. */
export const PRODUCTION_DOCUMENT_STATUSES = ['FORMING', 'READY'] as const;
export type ProductionDocumentStatus =
  (typeof PRODUCTION_DOCUMENT_STATUSES)[number];

export const PRODUCTION_DOCUMENT_STATUS_LABELS: Record<
  ProductionDocumentStatus,
  string
> = {
  FORMING: 'Формируется',
  READY: 'Сформирован',
};

/**
 * Чем документ закрылся — «последний факт» в списке. Это не статус, а причина фиксации:
 * менеджеру важно видеть, что именно ждали.
 */
export const PRODUCTION_DOCUMENT_FACT_KINDS = [
  'BOX_CLOSED',
  'EARNINGS_APPROVED',
  'ORDER_CLOSED',
] as const;
export type ProductionDocumentFactKind =
  (typeof PRODUCTION_DOCUMENT_FACT_KINDS)[number];

export const PRODUCTION_DOCUMENT_FACT_KIND_LABELS: Record<
  ProductionDocumentFactKind,
  string
> = {
  BOX_CLOSED: 'закрыта коробка',
  EARNINGS_APPROVED: 'подтверждены начисления',
  ORDER_CLOSED: 'закрыт заказ',
};

/** Почему документ ещё формируется — человеческим текстом, а не кодом состояния. */
export interface ProductionDocumentPendingReasonDto {
  /** `OPEN_BOX` — коробка не закрыта; `PENDING_EARNINGS` — начисления не подтверждены. */
  code: 'OPEN_BOX' | 'PENDING_EARNINGS';
  text: string;
  /** Номера коробок / сумма ожидающих начислений — то, что видно человеку. */
  detail?: string;
}

/** Строка выпуска: расцветка + размер + количество, собранная из упакованных паспортов. */
export interface ProductionDocumentLineDto {
  id: string;
  orderVariantId: string | null;
  color: string | null;
  sizeId: string;
  sizeCode: string | null;
  qtyGood: number;
  qtyCut: number;
  qtyDefect: number;
  isSample: boolean;
  /** Основание строки — номера паспортов (раскрытие строки в карточке). */
  passportNumbers: string[];
}

/**
 * Себестоимость выпуска — КОМПОНЕНТАМИ и все сразу. Что из них считать себестоимостью заказа,
 * решает владелец, и решать надо на живых числах.
 *
 * ⛔ `pieceworkPendingRub` в `totalRub` НЕ входит: незакрытая коробка — обещание, а не трата.
 */
export interface ProductionDocumentCostDto {
  materialsOwnRub: number;
  materialsErpRub: number;
  pieceworkRub: number;
  pieceworkPendingRub: number;
  recutRub: number;
  salaryRub: number;
  otherRub: number;
  totalRub: number;
  perUnitRub: number;
  planTotalRub: number | null;
  planPerUnitRub: number | null;
  /** `NO_MATERIAL_FACT`, `PIECEWORK_PENDING`, `EXTRA_COSTS_NON_RUB_SKIPPED`, … */
  warnings: string[];
}

/** Строка списка документов выпуска. */
export interface ProductionDocumentListItemDto {
  id: string;
  number: string;
  status: ProductionDocumentStatus;
  orderId: string;
  orderNumber: string;
  customer: string | null;
  patternName: string | null;
  qtyGood: number;
  qtyPlan: number;
  totalRub: number;
  perUnitRub: number;
  closedAt: string;
  readyAt: string | null;
  lastFactAt: string | null;
  lastFactKind: ProductionDocumentFactKind | null;
  recalculatedAt: string | null;
}

/** Карточка документа выпуска. */
export interface ProductionDocumentDto extends ProductionDocumentListItemDto {
  erpCustomerOrderId: string | null;
  erpCustomerOrderNumber: string | null;
  qtyCut: number;
  qtyDefect: number;
  cost: ProductionDocumentCostDto;
  lines: ProductionDocumentLineDto[];
  /** Пусто, когда документ сформирован. */
  pendingReasons: ProductionDocumentPendingReasonDto[];
  recalcReason: string | null;
  /**
   * Документ ДОСТРОЕН вручную по уже закрытому заказу, а не рождён закрытием (заказы, закрытые
   * до появления раздела). Номер у него от даты закрытия, а строка появилась позже — показывать
   * это обязательно, иначе выпуск читается как оформленный задним числом.
   */
  backfilledAt: string | null;
}

export interface ProductionDocumentListDto {
  items: ProductionDocumentListItemDto[];
  total: number;
  page: number;
  pageSize: number;
  /** Счётчик вкладки «Формируются» — он же напоминание, что факты ещё идут. */
  formingCount: number;
}
