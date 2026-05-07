/**
 * `OrderMaterialsTab` — вкладка «Материалы» в карточке заказа
 * `/admin/orders/[id]`.
 *
 * После рефакторинга «единый рабочий экран закупщика» вкладка
 * рендерит ровно две вещи:
 *
 *   1. `OrderMaterialsUnifiedTable` — компактная таблица всех
 *      строк потребности заказа с обогащением из CutReadiness,
 *      PurchaseOrders и PurchaseReceipts.
 *   2. `ManualMaterialArrivalActions` — кнопка ручной разблокировки
 *      кроя + список активных overrides.
 *
 * Что НЕ рендерим (требование ТЗ):
 *   - отдельную карточку «Потребность цеха»
 *     (`WorkshopNeedsCard` — данные внутри таблицы);
 *   - отдельную карточку «Себестоимость»
 *     (`OrderCostEstimateCard` — она живёт в вкладке «Сводно»);
 *   - отдельную карточку «Готовность к крою»
 *     (`CutReadinessCard` — данные внутри таблицы и блока ручной
 *     разблокировки).
 *
 * Backend / Prisma не менялись.
 */
import type {
  OrderMaterialsAndHardwareCostPolicy,
  OrderStatus,
} from '@sewing/shared/orders';
import { ManualMaterialArrivalActions } from '@/components/orders/materials/manual-material-arrival-actions';
import { OrderMaterialsUnifiedTable } from '@/components/orders/materials/order-materials-unified-table';

interface Props {
  orderId: string;
  orderStatus?: OrderStatus;
  /**
   * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
   * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`).
   * Default — `INCLUDE` (старая логика).
   */
  materialsAndHardwareCostPolicy?: OrderMaterialsAndHardwareCostPolicy;
}

export function OrderMaterialsTab({
  orderId,
  orderStatus,
  materialsAndHardwareCostPolicy,
}: Props) {
  return (
    <>
      <OrderMaterialsUnifiedTable
        orderId={orderId}
        materialsAndHardwareCostPolicy={materialsAndHardwareCostPolicy}
      />
      <ManualMaterialArrivalActions
        orderId={orderId}
        orderStatus={orderStatus}
      />
    </>
  );
}
