import { OrderStatus } from '@prisma/client';

import { OrderMaterialCorrectionStatusException } from './errors.js';

/**
 * Этап «Корректировка материалов после просчёта» + фича «Правка
 * потребности на любой стадии».
 *
 * Статусы заказа, в которых разрешено вести материалы и расходы заказа:
 * добавлять/править/гасить строки потребности (`WorkshopNeed` — теперь
 * ЛЮБЫЕ, а не только `isManual`) и прочие расходы (`OrderExtraCost`):
 *
 *   - `CALCULATION`      — заказ на просчёте, закупщик ещё ведёт работу;
 *   - `CALCULATION_DONE` — себестоимость зафиксирована, но её можно
 *                          пересчитать (`recalculateCostEstimate`);
 *   - `IN_PRODUCTION`    — непредвиденный расход уже в ходе производства;
 *   - `DONE`             — заказ выпущен, но ошибку в расчёте всё ещё
 *                          можно исправить постфактум: себестоимость
 *                          выпущенного заказа обязана сойтись с тем, что
 *                          реально ушло в изделие. Пересчёт сметы после
 *                          такой правки тоже разрешён (см.
 *                          `OrderCostEstimatesService.recalculateCostEstimate`).
 *
 * В `DRAFT` состав ведётся обычным редактированием заказа (потребности
 * ещё не рассчитаны); в `CANCELLED` заказ закрыт — правки бессмысленны.
 */
export const ORDER_MATERIAL_CORRECTION_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.CALCULATION,
  OrderStatus.CALCULATION_DONE,
  OrderStatus.IN_PRODUCTION,
  OrderStatus.DONE,
]);

const STATUS_LABELS: Record<string, string> = {
  [OrderStatus.DRAFT]: 'Черновик',
  [OrderStatus.CALCULATION]: 'Просчёт',
  [OrderStatus.CALCULATION_DONE]: 'Просчёт завершён',
  [OrderStatus.IN_PRODUCTION]: 'В производстве',
  [OrderStatus.DONE]: 'Выпущен',
  [OrderStatus.CANCELLED]: 'Отменён',
};

/**
 * Бросает `OrderMaterialCorrectionStatusException`, если в текущем
 * статусе заказа корректировка материалов/расходов не разрешена.
 */
export function assertOrderMaterialCorrectionAllowed(status: string): void {
  if (ORDER_MATERIAL_CORRECTION_STATUSES.has(status)) return;
  const label = STATUS_LABELS[status] ?? status;
  throw new OrderMaterialCorrectionStatusException(
    status === OrderStatus.DRAFT
      ? 'В черновике материалы ведутся редактированием самого заказа — потребность появится после отправки на просчёт.'
      : `Корректировать материалы и расходы можно на любой стадии до «Выпущен» включительно. Текущий статус заказа: «${label}».`,
  );
}
