/**
 * `OrderSignalSampleTab` — вкладка «Сигнальный образец» в карточке
 * `/admin/orders/[id]?tab=signalSample`.
 *
 * Серверный компонент. Подгружает список образцов
 * (`listOrderSamples`) и шаблоны маршрутов (`listRouteTemplates`),
 * передаёт их в клиентский `OrderSamplesCard`.
 *
 * Размеры для модалки берутся из `order.items` — у нас гарантировано
 * есть `sizeId / sizeCode / qtyPlan`; `productId` определяется
 * backend-ом из уникальной (orderId, sizeId) пары `OrderItem`.
 */

import type { OrderDetailDto } from '@sewing/shared/orders';
import { listOrderSamples } from '@/lib/order-samples-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { OrderSamplesCard } from '@/components/orders/samples/order-samples-card';
import type {
  StartOrderSampleRouteOption,
  StartOrderSampleSizeOption,
} from '@/components/orders/samples/start-order-sample-modal';

export interface OrderSignalSampleTabProps {
  order: OrderDetailDto;
  canManage: boolean;
}

export async function OrderSignalSampleTab({
  order,
  canManage,
}: OrderSignalSampleTabProps): Promise<React.ReactElement> {
  let samples: Awaited<ReturnType<typeof listOrderSamples>> = [];
  try {
    samples = await listOrderSamples(order.id);
  } catch {
    samples = [];
  }

  let routes: StartOrderSampleRouteOption[] = [];
  try {
    const list = await listRouteTemplates({ isActive: true });
    routes = list.map((r) => ({ id: r.id, code: r.code, name: r.name }));
  } catch {
    routes = [];
  }

  const sizes: StartOrderSampleSizeOption[] = order.items.map((it) => ({
    sizeId: it.sizeId,
    sizeCode: it.sizeCode,
    qtyPlan: it.qtyPlan,
  }));

  return (
    <OrderSamplesCard
      orderId={order.id}
      samples={samples}
      sizes={sizes}
      routeTemplates={routes}
      canManage={canManage}
    />
  );
}
