/**
 * Список потребностей цеха (`/admin/workshop-needs`).
 *
 * Этап 4А «Потребность цеха» (см. `docs/recon-soft-integration.md
 * §«Этап 4А»`). Рабочее место закупщика: одной таблицей видим всё, что
 * система рассчитала по заказам, фильтруем по статусу заказа / поиском
 * / по конкретному `orderId`.
 *
 * Итерация «Фильтр статуса расчёта»:
 *   Верхний фильтр страницы — это «Статус расчёта» (по `Order.status`,
 *   query-param `orderCalculationStatus`):
 *     - `ACTIVE` (default) — `Order.status = CALCULATION`;
 *     - `DONE`             — `Order.status = CALCULATION_DONE`;
 *     - `ALL`              — без фильтра по статусу заказа.
 *
 *   Прежний верхний фильтр по `WorkshopNeed.status` убран из UI —
 *   закупщик путал статус документа со статусом отдельной строки.
 *   `WORKSHOP_NEED_STATUSES` остаётся в shared и используется
 *   внутри строки/детальной формы; backend по-прежнему поддерживает
 *   технический query-param `status` (см. `workshop-needs-api.ts`).
 *   Старый bookmark `?status=...` страница сознательно игнорирует.
 *
 * Polish-итерация (`?view=`):
 *   - `view=orders` (default) — потребности группируются в карточки
 *     по заказу. В заголовке группы — превью изделия / клиент /
 *     номенклатура / цвет / срок / статус заказа; внутри —
 *     четыре секции «Материалы / Фурнитура / Нанесение / Прочее»,
 *     группировка по `getWorkshopNeedKind(sourceType, calculationMethod)`
 *     из `@sewing/shared/workshop-needs`.
 *   - `view=lines` — построчный вид (одна потребность = одна
 *     полная строка) с улучшенными колонками («Заказ + клиент +
 *     превью», «Номенклатура», бейдж «Тип»).
 *
 * Polish-итерация «Компактное inline-редактирование»:
 *   В обоих режимах (orders / lines) строка потребности использует
 *   один и тот же компонент `<InlineEditWorkshopNeedRow>` — это
 *   гарантирует, что закупщик правит цену/валюту/qty/поставщика
 *   в одинаковом UI, в каком бы режиме он ни был. В `view=orders`
 *   мы передаём `showOrderInfo = false` — превью/клиент уже в
 *   header группы заказа, поэтому строка ещё компактнее.
 *
 * Backend: `GET /api/workshop-needs` (см.
 * `apps/api/src/modules/workshop-needs/*`). Никакой пагинации на сервере
 * не делаем: на MVP-объёмах список помещается одним запросом, paginate-им
 * через `paginate(...)` уже на клиенте.
 *
 * Расчёт `WorkshopNeed` / `WorkshopNeedsService.calculateForOrder` /
 * Prisma не менялись — это исключительно DTO/API/UI polish.
 *
 * RBAC и feature-flag: страница доступна только под
 * `ADMIN`/`SHOP_MANAGER` (sidebar показывает пункт только при
 * `NEXT_PUBLIC_FEATURE_WORKSHOP_NEEDS=1`).
 */
import Link from 'next/link';
import { ClipboardList, ImageOff } from 'lucide-react';
import {
  WORKSHOP_NEED_KIND_LABELS,
  WORKSHOP_NEED_ORDER_CALCULATION_FILTERS,
  WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS,
  getWorkshopNeedKind,
  type WorkshopNeedKind,
  type WorkshopNeedListItemDto,
  type WorkshopNeedOrderCalculationFilter,
} from '@sewing/shared/workshop-needs';
import type { SupplierListItemDto } from '@sewing/shared/suppliers';
import { ApiRequestError, errorText } from '@/lib/api';
import { isFeatureEnabled } from '@/lib/feature-flags';
import { listWorkshopNeeds } from '@/lib/workshop-needs-api';
import { listSuppliers } from '@/lib/suppliers-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminStatusBadge,
  paginate,
} from '@/components/admin';
import {
  formatOrderStatus,
  getOrderStatusTone,
} from '@/lib/admin-labels';
import { BulkCreatePoProvider } from './bulk-create-po';
import { CompleteCalculationForm } from './complete-calculation-form';
import {
  InlineEditWorkshopNeedRow,
  type SupplierOption,
} from './inline-edit-row';

/**
 * Этап 6А «Заказы поставщикам». Bulk-создание PO из выбранных
 * потребностей включается тем же feature-flag, что и сам раздел
 * `/admin/purchase-orders` — иначе toolbar бессмысленен. Default-on
 * (см. `isFeatureEnabled` / `@/lib/feature-flags`).
 */
const FEATURE_PURCHASE_ORDERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_PURCHASE_ORDERS,
);

/**
 * Модуль «Поставщики». Когда включён — в строках потребности
 * показывается выбор поставщика из справочника (`selectedSupplierId`),
 * без которого нельзя создать заказ поставщику. Default-on.
 */
const FEATURE_SUPPLIERS_ENABLED = isFeatureEnabled(
  process.env.NEXT_PUBLIC_FEATURE_SUPPLIERS,
);

export const dynamic = 'force-dynamic';

type ViewMode = 'orders' | 'lines';

interface SearchParams {
  page?: string;
  pageSize?: string;
  search?: string;
  /**
   * Прежний query param по `WorkshopNeed.status` (статус отдельной
   * строки потребности). Намеренно не типизирован как
   * `WorkshopNeedStatus` — страница `/admin/workshop-needs` его
   * больше не использует и игнорирует (см. JSDoc файла). Тип
   * оставлен только для backward-compat ссылок, чтобы старый
   * bookmark `?status=CALCULATED` не давал 404 и просто работал
   * как пустой фильтр.
   */
  status?: string;
  orderCalculationStatus?: string;
  orderId?: string;
  view?: string;
}

function parseView(raw: string | undefined): ViewMode {
  return raw === 'lines' ? 'lines' : 'orders';
}

function parseOrderCalculationStatus(
  raw: string | undefined,
): WorkshopNeedOrderCalculationFilter {
  if (
    raw &&
    (WORKSHOP_NEED_ORDER_CALCULATION_FILTERS as readonly string[]).includes(raw)
  ) {
    return raw as WorkshopNeedOrderCalculationFilter;
  }
  return 'ACTIVE';
}

// ---------------------------------------------------------------------------
// Форматтеры
// ---------------------------------------------------------------------------

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU');
}

/**
 * Универсальное превью изделия: native `<img>` со встроенным
 * placeholder-ом (`ImageOff`). Прячет broken-images через `onError`
 * нам не нужно — это RSC, а в SSR событий нет. Поэтому если URL
 * мёртвый, мы всё равно отрисуем `<img>`, и браузер покажет
 * иконку «битой картинки». На MVP это приемлемо.
 */
function NomenclaturePreview({
  src,
  alt,
  size,
}: {
  src: string | null;
  alt: string;
  size: 'sm' | 'md';
}) {
  const cls =
    size === 'sm'
      ? 'workshop-order-preview workshop-order-preview--sm'
      : 'workshop-order-preview workshop-order-preview--md';
  if (!src) {
    return (
      <span className={`${cls} workshop-order-preview--empty`} aria-label={alt}>
        <ImageOff size={size === 'sm' ? 16 : 24} strokeWidth={1.4} aria-hidden />
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img className={cls} src={src} alt={alt} />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AdminWorkshopNeedsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const search = searchParams?.search?.trim();
  const orderId = searchParams?.orderId?.trim();
  // Управленческий фильтр верхнего уровня — статус заказа-документа
  // (`Order.status`). Раньше тут был фильтр по `WorkshopNeed.status`;
  // он сбивал закупщика с толку, поэтому удалён из UI. Старый
  // query param `status` страницей сознательно игнорируется (см.
  // JSDoc `SearchParams.status`). Backend по-прежнему его умеет —
  // это `apps/web/lib/workshop-needs-api.ts`.
  const orderCalculationStatus = parseOrderCalculationStatus(
    searchParams?.orderCalculationStatus,
  );
  const view = parseView(searchParams?.view);

  let items: WorkshopNeedListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listWorkshopNeeds({
      search: search || undefined,
      orderId: orderId || undefined,
      orderCalculationStatus,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить потребности цеха';
  }

  // Справочник поставщиков для inline-выбора в строках (нужен, чтобы
  // проставить `selectedSupplierId` и создать заказ). Грузим только
  // активных; ошибка чтения не валит страницу.
  let supplierOptions: { id: string; name: string }[] = [];
  if (FEATURE_SUPPLIERS_ENABLED) {
    try {
      const suppliers: SupplierListItemDto[] = await listSuppliers();
      supplierOptions = suppliers
        .filter((s) => s.status === 'ACTIVE')
        .map((s) => ({ id: s.id, name: s.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    } catch {
      supplierOptions = [];
    }
  }

  // Базовый набор query-параметров, который нужно пробросить в
  // переключатель режимов / пагинацию, чтобы фильтр не сбрасывался.
  // Намеренно НЕ сохраняем `status` — старый фильтр строки больше
  // не существует на этой странице.
  const preserveFilters = {
    search: search || undefined,
    orderCalculationStatus,
    orderId: orderId || undefined,
  } as const;

  const hasNonDefaultFilter =
    Boolean(search) ||
    Boolean(orderId) ||
    orderCalculationStatus !== 'ACTIVE';

  return (
    <AdminPageShell
      icon={<ClipboardList size={22} strokeWidth={1.6} aria-hidden />}
      title="Потребность цеха"
      subtitle={`Всего строк: ${items.length}`}
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader
          title="Фильтр"
          hint='По умолчанию показаны только заказы в статусе «Расчёт». Завершённые расчёты скрыты.'
        />

        <form
          action="/admin/workshop-needs"
          method="get"
          className="admin-form-grid"
          style={{ marginTop: 4 }}
        >
          {/*
           * Сохраняем активный режим в форме — иначе нажатие «Применить»
           * сбросит view на default. Скрытое поле проще, чем
           * вшивать `view=` в `action`.
           */}
          <input type="hidden" name="view" value={view} />
          <div className="admin-field">
            <label htmlFor="needSearch">Поиск</label>
            <input
              id="needSearch"
              name="search"
              type="search"
              defaultValue={search ?? ''}
              placeholder="описание, поставщик, номер заказа…"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="needOrderCalculationStatus">Статус расчёта</label>
            <select
              id="needOrderCalculationStatus"
              name="orderCalculationStatus"
              defaultValue={orderCalculationStatus}
            >
              {WORKSHOP_NEED_ORDER_CALCULATION_FILTERS.map((f) => (
                <option key={f} value={f}>
                  {WORKSHOP_NEED_ORDER_CALCULATION_FILTER_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="needOrderId">ID заказа</label>
            <input
              id="needOrderId"
              name="orderId"
              type="text"
              defaultValue={orderId ?? ''}
              placeholder="cuid заказа (опционально)"
            />
          </div>
          <div className="admin-actions-row" style={{ alignItems: 'end' }}>
            <button type="submit" className="admin-btn">
              Применить
            </button>
            {hasNonDefaultFilter && (
              <Link
                href={
                  view === 'lines'
                    ? '/admin/workshop-needs?view=lines'
                    : '/admin/workshop-needs'
                }
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Потребности"
          hint={`Всего: ${items.length}`}
        />

        <ViewToggle view={view} preserveFilters={preserveFilters} />

        {view === 'orders' ? (
          <OrdersView
            items={items}
            orderCalculationStatus={orderCalculationStatus}
            suppliers={supplierOptions}
            suppliersEnabled={FEATURE_SUPPLIERS_ENABLED}
          />
        ) : (
          <LinesView
            items={items}
            preserveFilters={preserveFilters}
            orderCalculationStatus={orderCalculationStatus}
            suppliers={supplierOptions}
            suppliersEnabled={FEATURE_SUPPLIERS_ENABLED}
          />
        )}
      </AdminCard>
    </AdminPageShell>
  );
}

// ---------------------------------------------------------------------------
// View toggle: «По заказам» / «Построчно»
// ---------------------------------------------------------------------------

function buildHref(
  base: string,
  params: Record<string, string | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && v.length > 0) search.set(k, v);
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

interface PreserveFilters {
  search?: string | undefined;
  orderCalculationStatus?: WorkshopNeedOrderCalculationFilter | undefined;
  orderId?: string | undefined;
}

function ViewToggle({
  view,
  preserveFilters,
}: {
  view: ViewMode;
  preserveFilters: PreserveFilters;
}) {
  const ordersHref = buildHref('/admin/workshop-needs', {
    ...preserveFilters,
    view: 'orders',
  });
  const linesHref = buildHref('/admin/workshop-needs', {
    ...preserveFilters,
    view: 'lines',
  });
  return (
    <div
      className="admin-tabs workshop-needs-view-toggle"
      style={{ marginTop: -4, marginBottom: 8 }}
    >
      <Link
        href={ordersHref}
        className={`admin-tab ${view === 'orders' ? 'admin-tab--active' : ''}`}
        prefetch={false}
      >
        По заказам
      </Link>
      <Link
        href={linesHref}
        className={`admin-tab ${view === 'lines' ? 'admin-tab--active' : ''}`}
        prefetch={false}
      >
        Построчно
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View: По заказам (grouped)
// ---------------------------------------------------------------------------

interface OrderGroup {
  orderId: string;
  // Берём «образец» строки для извлечения order/client/nomenclature
  // полей — они идентичны в каждой строке группы (см. backend mapper,
  // включающий `order` для каждой WorkshopNeed).
  sample: WorkshopNeedListItemDto;
  needs: WorkshopNeedListItemDto[];
}

function groupByOrder(
  items: WorkshopNeedListItemDto[],
): OrderGroup[] {
  const map = new Map<string, OrderGroup>();
  for (const need of items) {
    const existing = map.get(need.orderId);
    if (existing) {
      existing.needs.push(need);
    } else {
      map.set(need.orderId, {
        orderId: need.orderId,
        sample: need,
        needs: [need],
      });
    }
  }
  // Сохраняем порядок заказов «как пришли» (бэкенд сортирует по
  // createdAt desc — самые свежие потребности первыми, поэтому и
  // самые свежие заказы окажутся сверху).
  return Array.from(map.values());
}

function OrdersView({
  items,
  orderCalculationStatus,
  suppliers,
  suppliersEnabled,
}: {
  items: WorkshopNeedListItemDto[];
  orderCalculationStatus: WorkshopNeedOrderCalculationFilter;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
}) {
  if (items.length === 0) {
    return <EmptyOrdersState filter={orderCalculationStatus} />;
  }
  const groups = groupByOrder(items);
  const body = (
    <div className="workshop-order-group-list">
      {groups.map((g) => (
        <OrderNeedGroupCard
          key={g.orderId}
          group={g}
          suppliers={suppliers}
          suppliersEnabled={suppliersEnabled}
          bulkSelect={FEATURE_PURCHASE_ORDERS_ENABLED}
        />
      ))}
    </div>
  );
  // Bulk-создание заказа доступно и в «По заказам»: оборачиваем весь
  // список в провайдер, чтобы чекбоксы строк и нижний тулбар работали.
  return FEATURE_PURCHASE_ORDERS_ENABLED ? (
    <BulkCreatePoProvider needs={items}>{body}</BulkCreatePoProvider>
  ) : (
    body
  );
}

function EmptyOrdersState({
  filter,
}: {
  filter: WorkshopNeedOrderCalculationFilter;
}) {
  if (filter === 'ACTIVE') {
    return (
      <AdminEmptyState
        icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
        title="Нет заказов в расчёте"
        hint='Переведите заказ в статус «Расчёт», чтобы система сформировала потребность.'
      />
    );
  }
  if (filter === 'DONE') {
    return (
      <AdminEmptyState
        icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
        title="Нет завершённых расчётов"
      />
    );
  }
  return (
    <AdminEmptyState
      icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
      title="Потребностей пока нет"
    />
  );
}

function OrderNeedGroupCard({
  group,
  suppliers,
  suppliersEnabled,
  bulkSelect,
}: {
  group: OrderGroup;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
  bulkSelect: boolean;
}) {
  const { orderId, sample, needs } = group;

  // Раскладываем строки по типу. Стабильный порядок секций — Материалы
  // → Фурнитура → Нанесение → Прочее.
  const buckets: Record<WorkshopNeedKind, WorkshopNeedListItemDto[]> = {
    MATERIAL: [],
    HARDWARE: [],
    APPLICATION: [],
    OTHER: [],
  };
  for (const need of needs) {
    // Этап «Исправить формирование Потребности цеха» (см. ТЗ §7
    // «Исправить классификацию секций»): передаём materialRole в
    // helper, чтобы Нитки / Синтепон / Наполнитель / Дублерин
    // классифицировались как «Материалы», даже когда источник —
    // PATTERN_PARAMETER_NORM / QTY_PER_UNIT.
    const kind = getWorkshopNeedKind({
      sourceType: need.sourceType,
      calculationMethod: need.calculationMethod,
      materialRole: need.materialRole,
    });
    buckets[kind].push(need);
  }

  // Этап «Себестоимость заказа»: «Завершить расчёт» доступен только
  // для заказов в `CALCULATION` (см. backend
  // `OrdersService.completeCalculation` — отдаёт 409
  // `ORDER_CALCULATION_INVALID_STATUS` иначе). Ищем USD-строки
  // (без CANCELLED), чтобы решить, показывать ли поле «Курс USD/RUB».
  const isCalculation = sample.orderStatus === 'CALCULATION';
  const hasUsdLines = needs.some(
    (n) =>
      n.status !== 'CANCELLED' &&
      (n.quotedCurrency ?? '').toUpperCase() === 'USD',
  );

  const orderHref = `/admin/orders/${encodeURIComponent(orderId)}`;

  const previewAlt = sample.nomenclatureName ?? sample.orderNumber ?? 'Заказ';

  return (
    <article className="workshop-order-group-card">
      <header className="workshop-order-group-card__header">
        <div className="workshop-order-group-card__identity">
          <div className="workshop-order-group-card__preview">
            <NomenclaturePreview
              src={sample.nomenclaturePreviewImageUrl}
              alt={previewAlt}
              size="md"
            />
          </div>
          <div className="workshop-order-group-card__meta">
            <div className="workshop-order-group-card__title-row">
              <Link
                href={orderHref}
                className="admin-table__action-link workshop-order-group-card__order-number"
              >
                <strong>{sample.orderNumber ?? '—'}</strong>
              </Link>
              {sample.orderStatus && (
                <AdminStatusBadge tone={getOrderStatusTone(sample.orderStatus)}>
                  {formatOrderStatus(sample.orderStatus)}
                </AdminStatusBadge>
              )}
            </div>
            <div className="workshop-order-group-card__meta-line">
              {sample.clientName && (
                <span className="workshop-order-group-card__meta-item">
                  {sample.clientName}
                </span>
              )}
              {sample.nomenclatureName && (
                <span className="workshop-order-group-card__meta-item">
                  {sample.nomenclatureName}
                  {sample.nomenclatureArticle && (
                    <>
                      {' '}
                      <code className="workshop-order-group-card__article">
                        {sample.nomenclatureArticle}
                      </code>
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="workshop-order-group-card__meta-line">
              {sample.orderColor && (
                <span className="workshop-order-group-card__meta-item">
                  Цвет: {sample.orderColor}
                </span>
              )}
              {sample.orderDueDate && (
                <span className="workshop-order-group-card__meta-item">
                  Срок: {formatDate(sample.orderDueDate)}
                </span>
              )}
            </div>
            <div className="workshop-order-group-card__stats">
              {(['MATERIAL', 'HARDWARE', 'APPLICATION', 'OTHER'] as const).map(
                (k) =>
                  buckets[k].length > 0 ? (
                    <span
                      key={k}
                      className="workshop-order-group-card__stat"
                    >
                      {WORKSHOP_NEED_KIND_LABELS[k]}:{' '}
                      <strong>{buckets[k].length}</strong>
                    </span>
                  ) : null,
              )}
            </div>
          </div>
        </div>

        <div className="workshop-order-group-card__actions">
          <Link
            href={orderHref}
            className="admin-btn admin-btn--ghost workshop-order-group-card__action"
          >
            Открыть заказ
          </Link>
          {isCalculation && (
            <CompleteCalculationForm
              orderId={orderId}
              hasUsdLines={hasUsdLines}
              variant="compact"
            />
          )}
        </div>
      </header>

      <div className="workshop-order-group-card__body">
        {(['MATERIAL', 'HARDWARE', 'APPLICATION', 'OTHER'] as const).map((k) =>
          buckets[k].length > 0 ? (
            <NeedSection
              key={k}
              kind={k}
              needs={buckets[k]}
              suppliers={suppliers}
              suppliersEnabled={suppliersEnabled}
              bulkSelect={bulkSelect}
            />
          ) : null,
        )}
      </div>
    </article>
  );
}

function NeedSection({
  kind,
  needs,
  suppliers,
  suppliersEnabled,
  bulkSelect,
}: {
  kind: WorkshopNeedKind;
  needs: WorkshopNeedListItemDto[];
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
  bulkSelect: boolean;
}) {
  return (
    <section
      className={`workshop-need-section workshop-need-section--${kind.toLowerCase()}`}
    >
      <header className="workshop-need-section__header">
        <span className="workshop-need-section__label">
          {WORKSHOP_NEED_KIND_LABELS[kind]}
        </span>
        <span className="workshop-need-section__count">{needs.length}</span>
      </header>
      <div className="workshop-need-section__rows">
        {needs.map((n) => (
          <InlineEditWorkshopNeedRow
            key={n.id}
            need={n}
            showOrderInfo={false}
            bulkSelect={bulkSelect}
            suppliers={suppliers}
            suppliersEnabled={suppliersEnabled}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// View: Построчно
// ---------------------------------------------------------------------------

function LinesView({
  items,
  preserveFilters,
  orderCalculationStatus,
  suppliers,
  suppliersEnabled,
}: {
  items: WorkshopNeedListItemDto[];
  preserveFilters: PreserveFilters;
  orderCalculationStatus: WorkshopNeedOrderCalculationFilter;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
}) {
  // Пагинируем уже отфильтрованный набор. Параметры пагинации в
  // searchParams живут отдельно (`page` / `pageSize`); их подменяет
  // `paginate(...)`.
  const { pageItems, page, pageSize, total } = paginate(items, {});

  return (
    <>
      {/*
        Этап «Себестоимость заказа» (см.
        `apps/web/app/admin/workshop-needs/inline-edit-row.tsx`):
        строки в режиме «Построчно» — компактные inline-формы прямо
        в строке. Закупщик может править цену / валюту / количество /
        поставщика / дату / комментарий, не открывая отдельную
        карточку `[id]`.
      */}
      <NeedsLinesList
        rows={pageItems}
        bulkSelect={FEATURE_PURCHASE_ORDERS_ENABLED}
        orderCalculationStatus={orderCalculationStatus}
        suppliers={suppliers}
        suppliersEnabled={suppliersEnabled}
      />
      <AdminPagination
        page={page}
        pageSize={pageSize}
        total={total}
        basePath="/admin/workshop-needs"
        preserveParams={{ ...preserveFilters, view: 'lines' }}
        label="строк"
      />
    </>
  );
}

function NeedsLinesList({
  rows,
  bulkSelect,
  orderCalculationStatus,
  suppliers,
  suppliersEnabled,
}: {
  rows: WorkshopNeedListItemDto[];
  bulkSelect: boolean;
  orderCalculationStatus: WorkshopNeedOrderCalculationFilter;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyOrdersState filter={orderCalculationStatus} />;
  }
  const body = (
    <div className="workshop-need-line-list">
      {rows.map((n) => (
        <InlineEditWorkshopNeedRow
          key={n.id}
          need={n}
          showOrderInfo
          bulkSelect={bulkSelect}
          suppliers={suppliers}
          suppliersEnabled={suppliersEnabled}
        />
      ))}
    </div>
  );
  return bulkSelect ? (
    <BulkCreatePoProvider needs={rows}>{body}</BulkCreatePoProvider>
  ) : (
    body
  );
}
