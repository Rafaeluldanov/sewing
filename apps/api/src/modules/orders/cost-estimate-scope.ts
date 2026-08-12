import type { Prisma } from '@prisma/client';

/**
 * Канонический where-фрагмент «смета АКТИВНОГО варианта просчёта»
 * (фича FEATURE_ORDER_CALCULATIONS, см. JSDoc
 * `prisma/schema.prisma::OrderCostEstimate.orderCalculationId`).
 *
 * Расчёт завершают ПО КАЖДОМУ варианту, поэтому `COMPLETED`-смет у
 * одного заказа может быть несколько — по одной на рассчитанный
 * вариант. «Смета заказа» = смета активного варианта: любой читатель
 * денег (`{ orderId, status: 'COMPLETED' }` + `version desc`) обязан
 * подмешать этот фрагмент, иначе после переключения вкладки покажет
 * деньги ЧУЖОГО варианта.
 *
 * `orderCalculationId: null` включён сознательно — это legacy-сметы до
 * бэкфилла миграции `20261017100000_order_cost_estimate_per_calculation`.
 * Осиротевших строк здесь не бывает: удаление варианта переводит его
 * сметы в `REVOKED` (`OrderCalculationsService.remove`).
 *
 * ВАЖНО: подмешивать через `AND: [ACTIVE_CALCULATION_ESTIMATE_WHERE]`, а
 * не спредом — у фрагмента свой `OR`, спред затёр бы чужой `OR`.
 *
 * Полный аналог `ACTIVE_CALCULATION_NEED_WHERE` для `WorkshopNeed`
 * (`apps/api/src/modules/workshop-needs/workshop-need-scope.ts`).
 */
export const ACTIVE_CALCULATION_ESTIMATE_WHERE: Prisma.OrderCostEstimateWhereInput =
  {
    OR: [{ orderCalculationId: null }, { orderCalculation: { isActive: true } }],
  };
