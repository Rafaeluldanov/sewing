/**
 * ПОЛИТИКА МАТЕРИАЛА — когда цех списывает материал и что считает затратой заказа.
 *
 * Две оси, и это не педантизм: план и факт различаются ДВУМЯ признаками — количеством и ценой.
 * Заказ поставщику делает настоящей цену, но не расход: рулон берут на 60 м, когда нужно 47, и
 * остаток принадлежит складу, а не тиражу. Свести оси в один переключатель — значит зашить в
 * отчёт перерасход, которого не было.
 *
 * Граница мест: момент списания и источники — свойство ПРОЦЕССА (настройки компании), признание
 * — управленческое решение по конкретному тиражу (переопределение на заказе рядом с
 * `materialsAndHardwareCostPolicy`).
 */

/** Откуда берётся КОЛИЧЕСТВО материала в себестоимости. */
export const MATERIAL_QTY_SOURCES = [
  'ISSUED_OR_CALCULATED',
  'ISSUED',
  'CALCULATED',
  'ORDERED',
  'RECEIVED',
] as const;
export type MaterialQtySourceValue = (typeof MATERIAL_QTY_SOURCES)[number];

export const MATERIAL_QTY_SOURCE_LABELS: Record<MaterialQtySourceValue, string> = {
  ISSUED_OR_CALCULATED: 'Списано, иначе расчёт по норме',
  ISSUED: 'Только списанное',
  CALCULATED: 'Только расчёт по норме',
  ORDERED: 'Заказано поставщику под этот заказ',
  RECEIVED: 'Принято по этому заказу',
};

/** Откуда берётся ЦЕНА материала. */
export const MATERIAL_PRICE_SOURCES = ['PURCHASE', 'PLANNED', 'RECEIPT'] as const;
export type MaterialPriceSourceValue = (typeof MATERIAL_PRICE_SOURCES)[number];

export const MATERIAL_PRICE_SOURCE_LABELS: Record<MaterialPriceSourceValue, string> = {
  PURCHASE: 'Подтверждённая закупка, иначе заказ поставщику, иначе плановая',
  PLANNED: 'Плановая котировка закупщика',
  RECEIPT: 'Цена приёмки, иначе плановая',
};

/** Что считать затратой материала ПО ЗАКАЗУ. */
export const ORDER_MATERIAL_RECOGNITIONS = ['BY_CONSUMPTION', 'ALL_PURCHASED'] as const;
export type OrderMaterialRecognitionValue =
  (typeof ORDER_MATERIAL_RECOGNITIONS)[number];

export const ORDER_MATERIAL_RECOGNITION_LABELS: Record<
  OrderMaterialRecognitionValue,
  string
> = {
  BY_CONSUMPTION: 'По расходу',
  ALL_PURCHASED: 'Весь закупленный под заказ',
};

export const ORDER_MATERIAL_RECOGNITION_HINTS: Record<
  OrderMaterialRecognitionValue,
  string
> = {
  BY_CONSUMPTION:
    'Затрата — то, что ушло в производство. Остаток рулона остаётся складу и достанется следующему заказу.',
  ALL_PURCHASED:
    'Затрата — вся закупка под этот заказ, включая остаток. Для эксклюзивной ткани, которую больше некуда деть.',
};

/**
 * СТУПЕНЬ, с которой взята цифра строки материала. Показывается человеку рядом с числом:
 * три настройки без подписи превращают сумму в загадку — одна и та же строка может значить
 * разное, и оценку от факта надо отличать не открывая отчёт.
 */
export const MATERIAL_FACT_STEPS = [
  'ISSUED',
  'RECEIVED',
  'ORDERED',
  'CALCULATED',
  'ERP',
] as const;
export type MaterialFactStep = (typeof MATERIAL_FACT_STEPS)[number];

export const MATERIAL_FACT_STEP_LABELS: Record<MaterialFactStep, string> = {
  ISSUED: 'списано',
  RECEIVED: 'принято',
  ORDERED: 'заказано',
  CALCULATED: 'расчёт по норме',
  ERP: 'списано ERP',
};

/** Ступень цены — тот же принцип: видно, подтверждена ли цифра деньгами. */
export const MATERIAL_PRICE_STEPS = [
  'PURCHASE_CONFIRMED',
  'PURCHASE_ORDERED',
  'RECEIPT',
  'PLANNED',
  'ERP',
  'NONE',
] as const;
export type MaterialPriceStep = (typeof MATERIAL_PRICE_STEPS)[number];

export const MATERIAL_PRICE_STEP_LABELS: Record<MaterialPriceStep, string> = {
  PURCHASE_CONFIRMED: 'подтверждённая закупка',
  PURCHASE_ORDERED: 'заказ поставщику',
  RECEIPT: 'цена приёмки',
  PLANNED: 'плановая котировка',
  ERP: 'цена партии ERP',
  NONE: 'цены нет',
};

/** Оценка (а не факт) — по этим ступеням строка подсвечивается предупреждающим тоном. */
export function isEstimatedStep(step: MaterialFactStep | MaterialPriceStep): boolean {
  return step === 'CALCULATED' || step === 'PLANNED' || step === 'NONE';
}

/** Строка материала в документе выпуска: сколько, почём и откуда каждая цифра. */
export interface ProductionMaterialLineDto {
  workshopNeedId: string | null;
  description: string;
  unit: string | null;
  qty: number;
  qtyStep: MaterialFactStep;
  unitPriceRub: number | null;
  priceStep: MaterialPriceStep;
  totalRub: number;
}
