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
 * legacy до бэкфилла.
 *
 * Читателям ДЕНЕГ и МАТЕРИАЛОВ тиража нужен не этот фрагмент, а
 * `TIRAGE_NEED_WHERE` ниже: он дополнительно отсекает образец.
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

/**
 * Потребности ТИРАЖА: активный вариант просчёта И не сигнальный образец.
 *
 * `ACTIVE_CALCULATION_NEED_WHERE` пропускает `orderCalculationId: null`,
 * а пустым это поле бывает у трёх разных вещей: legacy-строк до
 * бэкфилла, строк сигнального образца (`orderSampleId != null` —
 * `calculateForSampleInTx` калькуляцию не штампует) и — до фикса
 * удаления варианта — осиротевших строк (`onDelete: SetNull`). Первое
 * видеть надо, второе и третье — нет.
 *
 * Деньги и материалы тиража обязаны считаться без образца: образец шьют
 * отдельно и в стоимость тиража он не входит. Мало того, его строки
 * приходят без цены — и роняли автопересчёт сметы целиком, требуя
 * заполнить цену по материалу, которого закупщик тиража не заказывал.
 *
 * Закупочные экраны (`WorkshopNeedsService.list`) этот фрагмент НЕ
 * используют: закупщик обязан видеть и материал образца, чтобы его
 * купить.
 *
 * ВАЖНО: подмешивать через `AND: [TIRAGE_NEED_WHERE]` — см. выше.
 */
export const TIRAGE_NEED_WHERE: Prisma.WorkshopNeedWhereInput = {
  orderSampleId: null,
  OR: ACTIVE_CALCULATION_NEED_WHERE.OR,
};
