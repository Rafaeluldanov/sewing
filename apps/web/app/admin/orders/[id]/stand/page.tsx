import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Compass } from 'lucide-react';
import type { OrderStandDto } from '@sewing/shared/order-stand';
import { ApiRequestError } from '@/lib/api';
import { getOrderStand } from '@/lib/order-stand-api';
import { AdminPageShell } from '@/components/admin';
import { OrderStandBoard } from './order-stand-board';

/**
 * `/admin/orders/[id]/stand` — «Схема стенда» по заказу.
 *
 * Буква «П» из реального маршрута заказа (см.
 * `docs/mockups/order-stand-mockup.html`, `docs/screens.md §7.7`):
 * левая нога — заказ / расчёт / материал, перекладина — раскрой и
 * шаги маршрута с QR рабочих мест, правая нога — упаковка и «готово»,
 * в центре — стеллаж (ячейки с QR) и паспорта заказа с текущим
 * положением. Все QR штатные (ADR-0008): со страницы сканируют
 * рабочими кабинетами прямо с экрана.
 *
 * Серверный компонент только грузит первый срез; живёт страница в
 * клиентской `OrderStandBoard` (поллинг `GET /api/orders/:id/stand`
 * каждые 5 с, как монитор цеха). Доступ — общий guard `/admin`
 * (`canSeeAdmin`), как у карточки заказа.
 */
export default async function OrderStandPage({
  params,
}: {
  params: { id: string };
}) {
  let initial: OrderStandDto;
  try {
    initial = await getOrderStand(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  return (
    <AdminPageShell
      icon={<Compass size={22} strokeWidth={1.6} aria-hidden />}
      title={`Схема стенда · ${initial.order.number}`}
      subtitle="Маршрут заказа, стеллаж и паспорта — QR настоящие, сканируйте с экрана"
      actions={
        <Link
          href={`/admin/orders/${encodeURIComponent(params.id)}`}
          className="admin-btn admin-btn--ghost"
        >
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К заказу
        </Link>
      }
    >
      <OrderStandBoard orderId={params.id} initial={initial} />
    </AdminPageShell>
  );
}
