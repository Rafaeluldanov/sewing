import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getOrder, listProducts, listSizes } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { listClients, getClient } from '@/lib/clients-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import { getPattern, listPatterns } from '@/lib/patterns-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { PatternListItemDto } from '@sewing/shared/patterns';
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
  // Маршруты/техкарты грузим best-effort — если модули недоступны или
  // вернут ошибку, форма всё равно откроется без соответствующих блоков.
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  try {
    routeTemplates = await listRouteTemplates({ isActive: true });
  } catch {
    routeTemplates = [];
  }
  // Клиенты — best-effort. Если модуль недоступен/упал, форма
  // покажет «Клиент не указан» без селекта (вместо 500 на странице).
  let clients: ClientDto[] = [];
  try {
    clients = await listClients({ includeInactive: false });
  } catch {
    clients = [];
  }
  // Если у заказа уже привязан архивный клиент (его нет в активном
  // списке), подгружаем его карточку отдельно. Иначе при сабмите без
  // явного действия пользователя привязка слетит.
  if (
    order.client &&
    !clients.some((c) => c.id === order.client?.id)
  ) {
    try {
      const detail = await getClient(order.client.id);
      clients = [...clients, detail];
    } catch {
      // graceful — форма всё равно покажет фолбэк-опцию
    }
  }

  // Soft-pattern MVP (этап 2 «Лекала»): аналогично route /
  // client. Загружаем список активных + тёплый fallback по уже
  // привязанному (возможно архивному) лекалу.
  let patterns: PatternListItemDto[] = [];
  try {
    patterns = await listPatterns({ status: 'ACTIVE' });
  } catch {
    patterns = [];
  }
  if (
    order.patternItemId &&
    !patterns.some((p) => p.id === order.patternItemId)
  ) {
    try {
      const detail = await getPattern(order.patternItemId);
      patterns = [
        ...patterns,
        {
          id: detail.id,
          name: detail.name,
          article: detail.article,
          categoryCode: detail.categoryCode,
          categoryId: detail.categoryId,
          categoryName: detail.category?.name ?? null,
          categorySlug: detail.category?.slug ?? null,
          categoryIconKey: detail.category?.iconKey ?? null,
          categoryIconImageUrl: detail.category?.iconImageUrl ?? null,
          categoryStatus: detail.category?.status ?? null,
          previewImageUrl: detail.previewImageUrl,
          status: detail.status,
          description: detail.description,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
          sizeFilesCount: detail.sizeFiles.length,
          materialAreasCount: detail.materialAreas.length,
          materialSpecLinesCount: detail.materialSpecLines?.length ?? 0,
          sizes: [],
        },
      ];
    } catch {
      // graceful — форма всё равно покажет фолбэк-опцию
    }
  }

  // PHASE 1 «CompanyDivision как master-справочник» (см.
  // `docs/domain.md §«Подразделения заказа»`): подгружаем активные
  // карточки подразделений; пустой список → форма fallback-ит на
  // legacy enum-select.
  let companyDivisions: CompanyDivisionDto[] = [];
  try {
    companyDivisions = await listCompanyDivisions();
  } catch {
    companyDivisions = [];
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
        clients={clients}
        patterns={patterns}
        companyDivisions={companyDivisions}
      />
    </div>
  );
}
