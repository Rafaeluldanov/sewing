/**
 * Создание заказа в новом Admin UI 2.7 (`/admin/orders/new`).
 *
 * Backend / DTO / Prisma не меняем — это «pretty-wrapper» над тем же
 * `createOrderAction`, что использует старая страница `/orders/new`.
 * Старая страница остаётся как есть (см. комментарий в
 * `apps/web/app/orders/new/page.tsx`), а админка получает форму
 * без raw-id/code в основном UI.
 *
 * Что грузится здесь, чтобы клиентская форма могла рендерить превью
 * без лишних round-trip-ов:
 *   - `routeTemplatesMap` — детальные шаги активных маршрутов
 *     (`getRouteTemplate(id)` для каждого active summary). Превью
 *     `AdminRouteSteps` строится без ожиданий.
 *   - `clients` — активные клиенты для select-а.
 *   - `techCards` — на превью только название/счётчики строк (DTO
 *     `TechCardTemplateSummaryDto` не содержит маршрут — см. TODO
 *     в `admin-create-order-form.tsx`).
 *
 * Источник правды по полям и FormData-ключам — `createOrderAction`
 * в `apps/web/app/orders/actions.ts`.
 */
import { redirect } from 'next/navigation';
import { Package } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { SizeDto } from '@sewing/shared/orders';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type {
  RouteTemplateDetailDto,
  RouteTemplateSummaryDto,
} from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listClients } from '@/lib/clients-api';
import { listSizes } from '@/lib/orders-api';
import { listPatterns } from '@/lib/patterns-api';
import { getRouteTemplate, listRouteTemplates } from '@/lib/routes-api';
import { listTechCards } from '@/lib/tech-cards-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import {
  AdminCreateOrderForm,
  type RoutePreview,
} from './admin-create-order-form';

export const dynamic = 'force-dynamic';

export default async function AdminOrderNewPage() {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') redirect('/admin/orders');

  let sizes: SizeDto[] = [];
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  let techCards: TechCardTemplateSummaryDto[] = [];
  let clients: ClientDto[] = [];
  let patterns: PatternListItemDto[] = [];
  let error: string | null = null;
  try {
    // Этап «Номенклатура = Лекала»: больше не грузим список Product —
    // в форме его нет, backend сам подставит legacy Product через
    // `OrdersService.ensureLegacyProductForPattern()`.
    const [sz, rt, tc, cl, pt] = await Promise.allSettled([
      listSizes(),
      listRouteTemplates({ isActive: true }),
      listTechCards({ isActive: true }),
      listClients(),
      // Этап «Номенклатура = Лекала»: только активные карточки лекал —
      // это единственная видимая номенклатура, менеджер не должен
      // видеть архив в селекте.
      listPatterns({ status: 'ACTIVE' }),
    ]);
    if (sz.status === 'fulfilled') sizes = sz.value;
    else throw sz.reason;
    routeTemplates = rt.status === 'fulfilled' ? rt.value : [];
    techCards = tc.status === 'fulfilled' ? tc.value : [];
    clients = cl.status === 'fulfilled' ? cl.value : [];
    patterns = pt.status === 'fulfilled' ? pt.value : [];
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

  // Order-workspace unification (см.
  // `apps/web/components/orders/order-workspace-layout.tsx`):
  //   - title секции остаётся «Заказы», чтобы sidebar / breadcrumb
  //     читались одинаково на /admin/orders, /admin/orders/new и
  //     /admin/orders/[id];
  //   - subtitle уточняет состояние («Создание заказа»);
  //   - конкретный «номер / клиент / лекало» уже показывает
  //     `OrderHeroCard` внутри формы.
  // Поэтому actions-слот тут пустой — back-link «К списку» переехал
  // в hero, чтобы create / view / edit имели одинаковую шапку.
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

      <AdminCreateOrderForm
        sizes={sizes}
        routeTemplates={routeTemplates}
        routePreviewMap={routePreviewMap}
        techCards={techCards}
        clients={clients}
        patterns={patterns}
        today={today}
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
