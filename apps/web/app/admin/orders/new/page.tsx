/**
 * Создание заказа — мастер (`/admin/orders/new`).
 *
 * Страница отдаёт справочники и рендерит `OrderCreateWizard`: шесть
 * шагов в порядке решений («чей заказ» → «что шьём» → всё, что от
 * изделия зависит). Прежняя одностраничная форма
 * `AdminCreateOrderForm` удалена — см. аудит
 * `docs/order-page-ui-recon.md` §4.1 и макет варианта C
 * `docs/mockups/order-page-variant-c-mockup.html`.
 *
 * Ключевое отличие для этой страницы: заказ создаётся уже на шаге
 * «Изделие» (`createOrderDraftAction`), а не по финальному сабмиту.
 * Поэтому здесь нет ни `FormActionState`, ни редиректа после
 * создания — навигацией управляет сам мастер.
 *
 * Что грузится здесь, чтобы клиент не делал лишних round-trip-ов:
 *   - `routePreviewMap` — детальные шаги активных маршрутов
 *     (`getRouteTemplate(id)` для каждого active summary), чтобы шаг
 *     «Маршрут» рисовал превью `AdminRouteSteps` без ожидания;
 *   - `clients`, `companyDivisions`, `warehouses` — для select-ов
 *     шага «Клиент»;
 *   - `patterns`, `patternCategories`, `sizes` — для
 *     шага «Изделие» и модалки «Создать изделие».
 *
 * Backend / DTO / Prisma не менялись: мастер ходит в те же
 * `POST /orders`, `PATCH /orders/:id`, `PUT /orders/:id/applications`
 * и `POST /orders/:id/start-calculation`. Старая страница
 * `/orders/new` остаётся как есть — на неё полагается легаси-flow
 * CUTTER_ASSISTANT.
 */
import { redirect } from 'next/navigation';
import { Package } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { SizeDto } from '@sewing/shared/orders';
import type { PatternCategoryListItemDto } from '@sewing/shared/pattern-categories';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type {
  RouteTemplateDetailDto,
  RouteTemplateSummaryDto,
} from '@sewing/shared/routes';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listClients } from '@/lib/clients-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import {
  isColorwaysEnabled,
  isOrderCalculationsEnabled,
} from '@/lib/feature-flags';
import { OrderCalcTabsCreatePlaceholder } from '@/components/orders/calculations/order-calc-tabs';
import { listSizes } from '@/lib/orders-api';
import { listPatternCategories } from '@/lib/pattern-categories-api';
import { listPatterns } from '@/lib/patterns-api';
import { getRouteTemplate, listRouteTemplates } from '@/lib/routes-api';
import { listWarehouses } from '@/lib/warehouses-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import { OrderCreateWizard } from './order-create-wizard';
import type { RoutePreview } from './route-preview';

export const dynamic = 'force-dynamic';

export default async function AdminOrderNewPage() {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') redirect('/admin/orders');

  let sizes: SizeDto[] = [];
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  let clients: ClientDto[] = [];
  let patterns: PatternListItemDto[] = [];
  let patternCategories: PatternCategoryListItemDto[] = [];
  let companyDivisions: CompanyDivisionDto[] = [];
  let warehouses: WarehouseSummaryDto[] = [];
  let error: string | null = null;
  try {
    // Этап «Номенклатура = Лекала»: больше не грузим список Product —
    // в форме его нет, backend сам подставит legacy Product через
    // `OrdersService.ensureLegacyProductForPattern()`.
    const [sz, rt, cl, pt, pcat, cd, wh] = await Promise.allSettled([
      listSizes(),
      listRouteTemplates({ isActive: true }),
      listClients(),
      // Этап «Номенклатура = Лекала»: только активные карточки лекал —
      // это единственная видимая номенклатура, менеджер не должен
      // видеть архив в селекте.
      listPatterns({ status: 'ACTIVE' }),
      // Inline-создание изделия из формы заказа: активные группы
      // номенклатуры для селекта «Группа номенклатуры» в модалке
      // «Создать изделие».
      listPatternCategories({ status: 'ACTIVE' }),
      // PHASE 1 «CompanyDivision как master-справочник» (см.
      // `docs/domain.md §«Подразделения заказа»`): подгружаем
      // только активные карточки подразделений для select-а.
      listCompanyDivisions(),
      // Этап «Склад выпуска готовой продукции» (см.
      // `prisma/schema.prisma::Order.finishedGoodsWarehouseId`):
      // список складов нужен для select-а «Склад выпуска готовой
      // продукции». Это **управленческое** поле — никак не
      // затрагивает плоскость склада материалов.
      listWarehouses(),
    ]);
    if (sz.status === 'fulfilled') sizes = sz.value;
    else throw sz.reason;
    routeTemplates = rt.status === 'fulfilled' ? rt.value : [];
    clients = cl.status === 'fulfilled' ? cl.value : [];
    patterns = pt.status === 'fulfilled' ? pt.value : [];
    patternCategories = pcat.status === 'fulfilled' ? pcat.value : [];
    companyDivisions = cd.status === 'fulfilled' ? cd.value : [];
    warehouses = wh.status === 'fulfilled' ? wh.value : [];
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось загрузить справочники';
  }

  // Превью маршрутов: подтягиваем шаги для каждого активного шаблона.
  // На MVP это N запросов, но шаблонов десятки максимум, и они уже
  // закэшированы на API-стороне через тот же `cache: 'no-store'` UX.
  const routePreviewMap: Record<string, RoutePreview> = {};
  if (routeTemplates.length > 0) {
    const settled = await Promise.allSettled(
      routeTemplates.map((t) => getRouteTemplate(t.id)),
    );
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const detail = result.value;
        routePreviewMap[detail.id] = toRoutePreview(detail);
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  // Title секции остаётся «Заказы», чтобы sidebar / breadcrumb читались
  // одинаково на /admin/orders, /admin/orders/new и /admin/orders/[id];
  // subtitle уточняет состояние. Back-link «К списку» живёт в подвале
  // мастера рядом с «Далее» — там, где менеджер и принимает решение
  // «продолжать или выйти».
  return (
    <AdminPageShell
      icon={<Package size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы"
      subtitle="Создание заказа"
    >
      {error && (
        <AdminCard>
          <div role="alert" className="error-box">
            {error}
          </div>
        </AdminCard>
      )}

      {/* Фича «Варианты просчёта»: в create-mode заказа ещё нет — единственная
          вкладка «Вариант 1» + disabled-кнопка. Живой ряд появится на
          карточке после создания. */}
      {isOrderCalculationsEnabled() && <OrderCalcTabsCreatePlaceholder />}

      <OrderCreateWizard
        sizes={sizes}
        routeTemplates={routeTemplates}
        routePreviewMap={routePreviewMap}
        clients={clients}
        patterns={patterns}
        patternCategories={patternCategories}
        companyDivisions={companyDivisions}
        warehouses={warehouses}
        today={today}
        colorwaysEnabled={isColorwaysEnabled()}
      />
    </AdminPageShell>
  );
}

function toRoutePreview(detail: RouteTemplateDetailDto): RoutePreview {
  return {
    id: detail.id,
    name: detail.name,
    steps: detail.steps.map((s) => ({
      id: s.id,
      index: s.index,
      name: s.operationName,
    })),
  };
}
