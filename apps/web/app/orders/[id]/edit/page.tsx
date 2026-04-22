import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getOrder, listProducts, listSizes } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { listTechCards, getTechCard } from '@/lib/tech-cards-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { EditOrderForm } from './edit-order-form';

export const dynamic = 'force-dynamic';

export default async function EditOrderPage({
  params,
}: {
  params: { id: string };
}) {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') redirect(`/orders/${params.id}`);
  let order;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }
  if (order.status !== 'DRAFT') {
    return (
      <div>
        <div className="page-header">
          <h1>Заказ {order.number}</h1>
        </div>
        <div className="error-box">
          Редактировать можно только заказы в статусе «Черновик». Текущий
          статус: <strong>{order.status}</strong>.
        </div>
        <Link className="btn" href={`/orders/${order.id}`}>
          ← Вернуться к заказу
        </Link>
      </div>
    );
  }

  const [sizes, products] = await Promise.all([listSizes(), listProducts()]);
  // Маршруты/техкарты грузим best-effort — если модули недоступны или
  // вернут ошибку, форма всё равно откроется без соответствующих блоков.
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  try {
    routeTemplates = await listRouteTemplates({ isActive: true });
  } catch {
    routeTemplates = [];
  }
  let techCards: TechCardTemplateSummaryDto[] = [];
  try {
    techCards = await listTechCards({ isActive: true });
  } catch {
    techCards = [];
  }
  // Если у заказа уже стоит деактивированная техкарта (её нет в
  // активном списке), подгружаем «текущую» отдельно — UI покажет её
  // как опцию с пометкой «неактивна», чтобы submit не сбросил
  // привязку без явного действия. Тот же паттерн используется для
  // routeTemplate (через order.routeTemplateName в EditOrderForm).
  if (
    order.techCardId &&
    !techCards.some((t) => t.id === order.techCardId)
  ) {
    try {
      const detail = await getTechCard(order.techCardId);
      techCards = [
        ...techCards,
        {
          id: detail.id,
          code: detail.code,
          name: detail.name,
          isActive: detail.isActive,
          materialLinesCount: detail.materialLines.length,
          outsourceLinesCount: detail.outsourceLines.length,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        },
      ];
    } catch {
      // graceful — option «Текущая техкарта» добавится фолбэком из формы
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Заказ {order.number} — редактирование</h1>
      </div>
      <EditOrderForm
        order={order}
        sizes={sizes}
        products={products}
        routeTemplates={routeTemplates}
        techCards={techCards}
      />
    </div>
  );
}
