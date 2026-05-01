import { redirect } from 'next/navigation';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { ProductDto, SizeDto } from '@sewing/shared/orders';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { listProducts, listSizes } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { listTechCards } from '@/lib/tech-cards-api';
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
  let techCards: TechCardTemplateSummaryDto[] = [];
  let companyDivisions: CompanyDivisionDto[] = [];
  let error: string | null = null;
  try {
    // routes/tech-cards идут через `Promise.allSettled` отдельными
    // ветками, чтобы отсутствие/недоступность опциональных модулей не
    // валило форму создания заказа целиком (backward compatibility со
    // старым flow). См. ADR-0006 для маршрутов и ADR-0022 для техкарт.
    //
    // PHASE 1 «CompanyDivision как master-справочник»: подгружаем
    // активные карточки подразделений; пустой список → форма
    // fallback-ит на legacy enum-select (см. NewOrderForm).
    const [sz, pr, rt, tc, cd] = await Promise.allSettled([
      listSizes(),
      listProducts(),
      listRouteTemplates({ isActive: true }),
      listTechCards({ isActive: true }),
      listCompanyDivisions(),
    ]);
    if (sz.status === 'fulfilled') sizes = sz.value;
    else throw sz.reason;
    if (pr.status === 'fulfilled') products = pr.value;
    else throw pr.reason;
    routeTemplates = rt.status === 'fulfilled' ? rt.value : [];
    techCards = tc.status === 'fulfilled' ? tc.value : [];
    companyDivisions = cd.status === 'fulfilled' ? cd.value : [];
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
        techCards={techCards}
        companyDivisions={companyDivisions}
        today={today}
      />
    </div>
  );
}
