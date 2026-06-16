import { OrderStatus } from '@prisma/client';

import { OrderMaterialCorrectionStatusException } from './errors.js';

/**
 * Этап «Корректировка материалов после просчёта».
 *
 * Статусы заказа, в которых разрешено добавлять/править/удалять ручные
 * строки потребности (`WorkshopNeed.isManual`) и прочие расходы
 * (`OrderExtraCost`):
 *
 *   - `CALCULATION`      — заказ на просчёте, закупщик ещё ведёт работу;
 *   - `CALCULATION_DONE` — себестоимость зафиксирована, но её можно
 *                          пересчитать (`recalculateCostEstimate`);
 *   - `IN_PRODUCTION`    — непредвиденный расход уже в ходе производства.
 *
 * В `DRAFT` состав ведётся обычным редактированием заказа; в
 * `DONE`/`CANCELLED` заказ закрыт.
 */
export const ORDER_MATERIAL_CORRECTION_STATUSES: ReadonlySet<string> = new Set([
  OrderStatus.CALCULATION,
  OrderStatus.CALCULATION_DONE,
  OrderStatus.IN_PRODUCTION,
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
    `Корректировать материалы и расходы можно только на просчёте или в производстве. Текущий статус заказа: «${label}».`,
  );
}
