import type { Prisma } from '@prisma/client';

/**
 * Канонический where-фрагмент «потребности АКТИВНОГО варианта просчёта»
 * (фича FEATURE_ORDER_CALCULATIONS, см. JSDoc
 * `prisma/schema.prisma::WorkshopNeed.orderCalculationId`).
 *
 * Потребности СОСУЩЕСТВУЮТ для нескольких вариантов одного заказа.
 * Производственно-финансовые читатели (смета, cut-readiness, авто-
 * списание кроя, план→факт, web-таблицы «Материалы»/«Сводно», выдачи)
 * обязаны видеть только строки активного варианта — иначе двойной счёт
 * денег и материалов. Закупочные экраны показывают все варианты с
 * меткой и этот фрагмент НЕ используют.
 *
 * `orderCalculationId: null` включён сознательно: это строки вне
 * контура вариантов — sample-строки (`orderSampleId != null`) и
 * legacy до бэкфилла; их видимость не меняется.
 *
 * ВАЖНО: подмешивать через `AND: [ACTIVE_CALCULATION_NEED_WHERE]`, а не
 * спредом — у фрагмента свой `OR`, спред затёр бы `OR` поиска/фильтров.
 */
export const ACTIVE_CALCULATION_NEED_WHERE: Prisma.WorkshopNeedWhereInput = {
  OR: [
    { orderCalculationId: null },
    { orderCalculation: { isActive: true } },
  ],
};
