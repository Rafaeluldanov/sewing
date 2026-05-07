/**
 * Редактирование заказа в новом Admin UI (`/admin/orders/[id]/edit`).
 *
 * Делает то же, что `/admin/orders/new`, но «over an existing order»:
 *   - грузит сам заказ (`getOrder`) — нужен для дефолтных значений
 *     каждого поля и для текущей привязки клиент / маршрут / техкарта;
 *   - грузит справочники (sizes, products, route templates, tech cards,
 *     clients) для select-ов;
 *   - подготавливает `routePreviewMap` для `AdminRouteSteps` без
 *     дополнительного round-trip-а на клиенте;
 *   - доgrузит «архивные» опции (если у заказа уже привязан клиент /
 *     маршрут / техкарта, которых нет в активном списке) — тот же
 *     паттерн, что в легаси `/orders/[id]/edit/page.tsx`.
 *
 * Старая страница `/orders/[id]/edit` сознательно НЕ удаляется —
 * легаси-flow CUTTER_ASSISTANT и историческая навигация на неё
 * полагаются. См. ТЗ + smoke `admin-order-edit.smoke.test.ts`.
 */
import { notFound, redirect } from 'next/navigation';
import { Pencil } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type {
  OrderDetailDto,
  SizeDto,
} from '@sewing/shared/orders';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type {
  RouteTemplateDetailDto,
  RouteTemplateSummaryDto,
} from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import type { WarehouseSummaryDto } from '@sewing/shared/warehouses';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { getClient, listClients } from '@/lib/clients-api';
import {
  getCompanyDivision,
  listCompanyDivisions,
} from '@/lib/company-settings-api';
import { getOrder, listSizes } from '@/lib/orders-api';
import { getPattern, listPatterns } from '@/lib/patterns-api';
import { getRouteTemplate, listRouteTemplates } from '@/lib/routes-api';
import { getTechCard, listTechCards } from '@/lib/tech-cards-api';
import { listWarehouses } from '@/lib/warehouses-api';
import { AdminCard, AdminPageShell } from '@/components/admin';
import {
  AdminEditOrderForm,
  type RoutePreview,
} from './admin-edit-order-form';

export const dynamic = 'force-dynamic';

interface Params {
  params: { id: string };
}

export default async function AdminOrderEditPage({ params }: Params) {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  if (role !== 'ADMIN' && role !== 'SHOP_MANAGER') {
    redirect(`/admin/orders/${params.id}`);
  }

  let order: OrderDetailDto;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  let sizes: SizeDto[] = [];
  let routeTemplates: RouteTemplateSummaryDto[] = [];
  let techCards: TechCardTemplateSummaryDto[] = [];
  let clients: ClientDto[] = [];
  let patterns: PatternListItemDto[] = [];
  let companyDivisions: CompanyDivisionDto[] = [];
  let warehouses: WarehouseSummaryDto[] = [];
  let error: string | null = null;
  try {
    // Этап «Номенклатура = Лекала»: список Product больше не нужен —
    // в admin-форме его нет. См. `admin-edit-order-form.tsx`.
    //
    // PHASE 1 «CompanyDivision как master-справочник»: подгружаем
    // активные карточки подразделений вместе с остальными
    // справочниками.
    const [sz, rt, tc, cl, pt, cd, wh] = await Promise.allSettled([
      listSizes(),
      listRouteTemplates({ isActive: true }),
      listTechCards({ isActive: true }),
      listClients(),
      listPatterns({ status: 'ACTIVE' }),
      listCompanyDivisions(),
      // Этап «Склад выпуска готовой продукции»: список складов для
      // select-а «Склад выпуска готовой продукции» в форме
      // редактирования. Не путать со складом материалов.
      listWarehouses(),
    ]);
    if (sz.status === 'fulfilled') sizes = sz.value;
    else throw sz.reason;
    routeTemplates = rt.status === 'fulfilled' ? rt.value : [];
    techCards = tc.status === 'fulfilled' ? tc.value : [];
    clients = cl.status === 'fulfilled' ? cl.value : [];
    patterns = pt.status === 'fulfilled' ? pt.value : [];
    companyDivisions = cd.status === 'fulfilled' ? cd.value : [];
    warehouses = wh.status === 'fulfilled' ? wh.value : [];
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? e.message
        : 'Не удалось загрузить справочники';
  }

  // Если у заказа уже привязан архивный клиент / неактивный маршрут /
  // неактивная техкарта — догружаем их «тёплым» отдельным запросом и
  // мерджим с активным списком. Так select сохранит текущее значение
  // даже после деактивации (без явного действия пользователя).
  if (
    order.client &&
    !clients.some((c) => c.id === order.client?.id)
  ) {
    try {
      const detail = await getClient(order.client.id);
      clients = [...clients, detail];
    } catch {
      // graceful — UI покажет fallback-опцию «архивный» из формы.
    }
  }
  if (
    order.routeTemplateId &&
    !routeTemplates.some((t) => t.id === order.routeTemplateId)
  ) {
    try {
      const detail = await getRouteTemplate(order.routeTemplateId);
      routeTemplates = [
        ...routeTemplates,
        {
          id: detail.id,
          code: detail.code,
          name: detail.name,
          isActive: detail.isActive,
          stepsCount: detail.steps.length,
          createdAt: detail.createdAt,
          updatedAt: detail.updatedAt,
        },
      ];
    } catch {
      // graceful — UI покажет fallback-опцию «неактивен» из формы.
    }
  }
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
      // graceful — UI покажет fallback-опцию «неактивна» из формы.
    }
  }
  // Soft-pattern MVP (этап 2 «Лекала»): если у заказа уже привязано
  // лекало, которого нет в активном списке (например, его архивировали
  // после привязки), доgrузим карточку и подложим её в массив. Это
  // та же схема, что для clients/routes/techCards.
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
          sizes: [],
        },
      ];
    } catch {
      // graceful — UI покажет fallback-опцию «архивное» из формы.
    }
  }

  // PHASE 1 «CompanyDivision как master-справочник»: если у заказа
  // привязана карточка, которой нет в активном списке (архивная или
  // удалённая) — догружаем тёплым отдельным запросом, иначе селект
  // потеряет привязку при сохранении формы. Тот же приём, что для
  // patterns/route/tech-card/client выше.
  if (
    order.companyDivisionId &&
    !companyDivisions.some((d) => d.id === order.companyDivisionId)
  ) {
    try {
      const detail = await getCompanyDivision(order.companyDivisionId);
      companyDivisions = [...companyDivisions, detail];
    } catch {
      // graceful — UI покажет fallback-опцию «архивное» из формы.
    }
  }

  // Превью маршрутов: подтягиваем шаги для каждого активного шаблона
  // (плюс текущего шаблона заказа, если он есть в списке выше). На
  // MVP это N запросов, но шаблонов десятки максимум.
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
  //   - title секции остаётся «Заказы», как на /admin/orders/new и
  //     /admin/orders/[id], чтобы менеджер видел один и тот же
  //     header/breadcrumb;
  //   - subtitle уточняет, что страница в edit-режиме;
  //   - конкретный «номер / клиент / лекало» уже показывает
  //     `OrderHeroCard` внутри формы, back-link «К карточке»
  //     переехал в hero actions.
  return (
    <AdminPageShell
      icon={<Pencil size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы"
      subtitle="Редактирование заказа"
    >
      {error && (
        <AdminCard>
          <div role="alert" className="error-box">
            {error}
          </div>
        </AdminCard>
      )}

      <AdminEditOrderForm
        order={order}
        sizes={sizes}
        routeTemplates={routeTemplates}
        routePreviewMap={routePreviewMap}
        techCards={techCards}
        clients={clients}
        patterns={patterns}
        companyDivisions={companyDivisions}
        warehouses={warehouses}
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
