import { redirect } from 'next/navigation';
import type { ProductDto, SizeDto } from '@sewing/shared/orders';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import { listProducts, listSizes } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { NewOrderForm } from './new-order-form';

export const dynamic = 'force-dynamic';

export default async function NewOrderPage() {
  // Создание заказа — только менеджер/админ. CUTTER_ASSISTANT
  // допущен в раздел только для read (см. `apps/web/app/orders/layout.tsx`),
  // но создавать заказы ему нельзя; backend всё равно вернёт 403 на POST.
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') redirect('/orders');

  let sizes: SizeDto[] = [];
  let products: ProductDto[] = [];
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  let error: string | null = null;
  try {
    // routes идут через `Promise.allSettled` отдельной веткой, чтобы
    // отсутствие/недоступность модуля routes не валило форму создания
    // заказа целиком (backward compatibility со старым flow).
    const [sz, pr, rt] = await Promise.allSettled([
      listSizes(),
      listProducts(),
      listRouteTemplates({ isActive: true }),
    ]);
    if (sz.status === 'fulfilled') sizes = sz.value;
    else throw sz.reason;
    if (pr.status === 'fulfilled') products = pr.value;
    else throw pr.reason;
    routeTemplates = rt.status === 'fulfilled' ? rt.value : [];
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось загрузить справочники';
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="page-header">
        <h1>Новый заказ</h1>
      </div>
      {error && <div className="error-box">{error}</div>}
      <NewOrderForm
        sizes={sizes}
        products={products}
        routeTemplates={routeTemplates}
        today={today}
      />
    </div>
  );
}
