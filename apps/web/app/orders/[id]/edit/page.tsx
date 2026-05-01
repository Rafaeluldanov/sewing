import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getOrder, listProducts, listSizes } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
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
  // Маршруты грузим best-effort — если модуль routes недоступен или
  // вернёт ошибку, форма всё равно откроется без блока «Шаблон маршрута».
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  try {
    routeTemplates = await listRouteTemplates({ isActive: true });
  } catch {
    routeTemplates = [];
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
      />
    </div>
  );
}
