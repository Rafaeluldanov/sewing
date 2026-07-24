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
 * Единственный режим — группировка по заказу: потребности
 * собираются в карточки по заказу. В заголовке группы — превью
 * изделия / клиент / номенклатура / цвет / срок / статус заказа;
 * внутри — четыре секции «Материалы / Фурнитура / Нанесение /
 * Прочее», группировка по `getWorkshopNeedKind(...)` из
 * `@sewing/shared/workshop-needs`. Прежний построчный вид
 * (`?view=lines`) убран; вход в полную карточку
 * `/admin/workshop-needs/[id]` теперь по ссылке «Подробности»
 * прямо в строке потребности.
 *
 * Компактное inline-редактирование:
 *   Строка потребности — компонент `<InlineEditWorkshopNeedRow>`:
 *   закупщик правит цену/валюту/qty/поставщика/дату/статус прямо
 *   в строке, не открывая карточку `[id]`. Превью/клиент уже в
 *   header группы заказа, поэтому строка компактная.
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
import { getModules } from '@/lib/modules';
import { listWorkshopNeeds } from '@/lib/workshop-needs-api';
import { listSuppliers } from '@/lib/suppliers-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
} from '@/components/admin';
import {
  formatOrderStatus,
  getOrderStatusTone,
} from '@/lib/admin-labels';
import { ClickableCard } from '@/components/ui/clickable-card';
import { BulkCreatePoProvider } from './bulk-create-po';
import { CompleteCalculationForm } from './complete-calculation-form';
import {
  CollapseAllButton,
  CollapseProvider,
  CollapsibleOrderCard,
  CollapsibleSection,
} from './collapse';
import { OrderCalcTabs } from '@/components/orders/calculations/order-calc-tabs';
import { getOrderCalculations } from '@/lib/order-calculations-api';
import { isOrderCalculationsEnabled } from '@/lib/feature-flags';
import type { OrderCalculationsDto } from '@sewing/shared';
import {
  InlineEditWorkshopNeedRow,
  type SupplierOption,
} from './inline-edit-row';
import {
  OrderArchiveCheckbox,
  OrderArchiveHeaderButton,
  OrderArchiveProvider,
  OrderArchiveRowActions,
  type ArchiveMode,
} from './order-archive';

// Модули «Поставщики» / «Заказы поставщикам» гейтят inline-блоки этой
// страницы (выбор поставщика в строках, bulk-создание PO). Под
// мультитенантность набор приходит в рантайме — `getModules()` ниже
// внутри компонента, а не из build-time `NEXT_PUBLIC_FEATURE_*`.

export const dynamic = 'force-dynamic';

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
  /**
   * Фича «Архив расчётов цеха»: активная вкладка списка.
   *   - отсутствует / любое ≠ `archive` → «Потребности» (активные);
   *   - `archive`                        → «Архив» (архивированные).
   */
  tab?: string;
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
 * Дата+время в московском поясе — фиксированный timeZone обязателен в
 * RSC, иначе UTC-vs-Moscow ломает hydration (см. заметку
 * feedback_hydration_timezone). Используется в подписи «архивирован …».
 */
function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Заказ на стадии расчёта — можно архивировать (гейт зеркалит backend). */
function isArchivableStatus(status: string | null): boolean {
  return (
    status === 'DRAFT' ||
    status === 'CALCULATION' ||
    status === 'CALCULATION_DONE'
  );
}

/** Ссылка на вкладку списка с сохранением текущих фильтров. */
function buildTabHref(
  tab: ArchiveMode,
  filters: { search?: string; orderId?: string; orderCalculationStatus?: string },
): string {
  const params = new URLSearchParams();
  if (tab === 'archive') params.set('tab', 'archive');
  if (filters.search) params.set('search', filters.search);
  if (filters.orderId) params.set('orderId', filters.orderId);
  if (
    filters.orderCalculationStatus &&
    filters.orderCalculationStatus !== 'ACTIVE'
  ) {
    params.set('orderCalculationStatus', filters.orderCalculationStatus);
  }
  const qs = params.toString();
  return qs ? `/admin/workshop-needs?${qs}` : '/admin/workshop-needs';
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

  // Фича «Архив расчётов цеха»: активная вкладка списка.
  const tab: ArchiveMode =
    searchParams?.tab === 'archive' ? 'archive' : 'active';

  const modules = await getModules();

  // Скоуп текущей вкладки. Архив показываем плоско — фильтр «Статус
  // расчёта» к нему не применяем (архивные заказы могут быть любой
  // стадии), поэтому в archive-режиме принудительно `ALL`.
  const orderArchive = tab === 'archive' ? 'ARCHIVED' : 'ACTIVE';
  const effectiveCalcStatus = tab === 'archive' ? 'ALL' : orderCalculationStatus;

  let items: WorkshopNeedListItemDto[] = [];
  let error: string | null = null;
  try {
    items = await listWorkshopNeeds({
      search: search || undefined,
      orderId: orderId || undefined,
      orderCalculationStatus: effectiveCalcStatus,
      orderArchive,
    });
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить потребности цеха';
  }

  // Счётчик заказов противоположной вкладки для бейджа. Ошибку глушим —
  // бейдж просто покажет 0.
  const currentOrderCount = new Set(items.map((n) => n.orderId)).size;
  let otherOrderCount = 0;
  try {
    const otherItems = await listWorkshopNeeds(
      tab === 'archive'
        ? {
            search: search || undefined,
            orderId: orderId || undefined,
            orderCalculationStatus,
            orderArchive: 'ACTIVE',
          }
        : {
            search: search || undefined,
            orderId: orderId || undefined,
            orderCalculationStatus: 'ALL',
            orderArchive: 'ARCHIVED',
          },
    );
    otherOrderCount = new Set(otherItems.map((n) => n.orderId)).size;
  } catch {
    otherOrderCount = 0;
  }
  const activeTabCount = tab === 'active' ? currentOrderCount : otherOrderCount;
  const archiveTabCount = tab === 'archive' ? currentOrderCount : otherOrderCount;
  const allOrderIds = Array.from(new Set(items.map((n) => n.orderId)));

  // Справочник поставщиков для inline-выбора в строках (нужен, чтобы
  // проставить `selectedSupplierId` и создать заказ). Грузим только
  // активных; ошибка чтения не валит страницу.
  let supplierOptions: { id: string; name: string }[] = [];
  if (modules.suppliers) {
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

  // Фича «Варианты просчёта»: для каждого заказа на экране тянем его
  // варианты — из них строится ряд вкладок в карточке. Список строк
  // (`items`) содержит потребности ВСЕХ вариантов, поэтому карточка
  // сама отфильтрует активный. Ошибку глушим: заказ просто останется
  // без вкладок.
  // В архиве вкладки вариантов не показываем (это переключатели активного
  // варианта — для скрытого заказа не нужны), поэтому и не грузим.
  const calcEnabled = isOrderCalculationsEnabled() && tab === 'active';
  const calculationsByOrder = new Map<string, OrderCalculationsDto>();
  if (calcEnabled && items.length > 0) {
    const orderIds = Array.from(new Set(items.map((n) => n.orderId)));
    const loaded = await Promise.all(
      orderIds.map(async (id) => {
        try {
          return [id, await getOrderCalculations(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    for (const [id, dto] of loaded) {
      if (dto) calculationsByOrder.set(id, dto);
    }
  }

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
          {/* Сохраняем активную вкладку при применении фильтра. */}
          {tab === 'archive' && (
            <input type="hidden" name="tab" value="archive" />
          )}
          <AdminSearchInput
            id="needSearch"
            placeholder="описание, поставщик, номер заказа…"
            initial={search ?? ''}
            basePath="/admin/workshop-needs"
            resetParams={{}}
            preserveParams={{
              tab: tab === 'archive' ? 'archive' : undefined,
              orderCalculationStatus,
              orderId,
            }}
          />
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
                href={tab === 'archive' ? '/admin/workshop-needs?tab=archive' : '/admin/workshop-needs'}
                className="admin-btn admin-btn--ghost"
              >
                Сбросить
              </Link>
            )}
          </div>
        </form>
      </AdminCard>

      <AdminCard>
        {/* Фича «Архив расчётов цеха»: вкладки «Потребности» / «Архив». */}
        <nav className="wn-tabs" aria-label="Потребности и архив">
          <Link
            href={buildTabHref('active', {
              search,
              orderId,
              orderCalculationStatus,
            })}
            className={`wn-tab${tab === 'active' ? ' wn-tab--active' : ''}`}
            aria-current={tab === 'active' ? 'page' : undefined}
          >
            Потребности
            <span className="wn-tab__count">{activeTabCount}</span>
          </Link>
          <Link
            href={buildTabHref('archive', {
              search,
              orderId,
              orderCalculationStatus,
            })}
            className={`wn-tab${tab === 'archive' ? ' wn-tab--active' : ''}`}
            aria-current={tab === 'archive' ? 'page' : undefined}
          >
            Архив
            <span className="wn-tab__count">{archiveTabCount}</span>
          </Link>
        </nav>

        {/* Провайдер архива оборачивает шапку (кнопка «Архивировать все» /
            «Очистить архив») и карточки (чекбоксы + нижний тулбар). Внутри
            — провайдер сворачивания (кнопка «Свернуть все» + карточки). */}
        <OrderArchiveProvider mode={tab} allOrderIds={allOrderIds}>
          <CollapseProvider>
            <AdminSectionHeader
              title={tab === 'archive' ? 'Архив' : 'Потребности'}
              hint={`Всего: ${items.length}`}
              actions={
                <div className="wn-head-actions">
                  <OrderArchiveHeaderButton />
                  <CollapseAllButton />
                </div>
              }
            />

            <OrdersView
              items={items}
              mode={tab}
              orderCalculationStatus={orderCalculationStatus}
              suppliers={supplierOptions}
              suppliersEnabled={modules.suppliers}
              purchaseOrdersEnabled={modules.purchaseOrders}
              calculationsByOrder={calculationsByOrder}
            />
          </CollapseProvider>
        </OrderArchiveProvider>
      </AdminCard>
    </AdminPageShell>
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
  mode,
  orderCalculationStatus,
  suppliers,
  suppliersEnabled,
  purchaseOrdersEnabled,
  calculationsByOrder,
}: {
  items: WorkshopNeedListItemDto[];
  mode: ArchiveMode;
  orderCalculationStatus: WorkshopNeedOrderCalculationFilter;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
  purchaseOrdersEnabled: boolean;
  calculationsByOrder: Map<string, OrderCalculationsDto>;
}) {
  if (items.length === 0) {
    return <EmptyOrdersState filter={orderCalculationStatus} mode={mode} />;
  }
  // В архиве закупочный bulk-выбор строк не нужен (архивные заказы не
  // заказывают у поставщика) — оставляем его только на активной вкладке.
  const poBulk = mode === 'active' && purchaseOrdersEnabled;
  const groups = groupByOrder(items);
  const body = (
    <div className="workshop-order-group-list">
      {groups.map((g) => (
        <OrderNeedGroupCard
          key={g.orderId}
          group={g}
          mode={mode}
          suppliers={suppliers}
          suppliersEnabled={suppliersEnabled}
          bulkSelect={poBulk}
          calculations={calculationsByOrder.get(g.orderId) ?? null}
        />
      ))}
    </div>
  );
  // Bulk-создание заказа доступно и в «По заказам»: оборачиваем весь
  // список в провайдер, чтобы чекбоксы строк и нижний тулбар работали.
  return poBulk ? (
    <BulkCreatePoProvider needs={items}>{body}</BulkCreatePoProvider>
  ) : (
    body
  );
}

function EmptyOrdersState({
  filter,
  mode,
}: {
  filter: WorkshopNeedOrderCalculationFilter;
  mode: ArchiveMode;
}) {
  if (mode === 'archive') {
    return (
      <AdminEmptyState
        icon={<ClipboardList size={26} strokeWidth={1.6} aria-hidden />}
        title="Архив пуст"
        hint='Заказы, отправленные в архив со вкладки «Потребности», появятся здесь.'
      />
    );
  }
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

/** Σ по строкам (qty × цена, только RUB) — для сумм в заголовках секций. */
function sumRub(needs: WorkshopNeedListItemDto[]): number {
  let total = 0;
  for (const n of needs) {
    if (n.status === 'CANCELLED') continue;
    if (n.quotedPrice == null) continue;
    if ((n.quotedCurrency ?? 'RUB').toUpperCase() !== 'RUB') continue;
    const qty = Number(n.purchaseQty ?? n.calculatedQty);
    const price = Number(n.quotedPrice);
    if (Number.isFinite(qty) && Number.isFinite(price)) total += qty * price;
  }
  return total;
}

function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}

function OrderNeedGroupCard({
  group,
  mode,
  suppliers,
  suppliersEnabled,
  bulkSelect,
  calculations,
}: {
  group: OrderGroup;
  mode: ArchiveMode;
  suppliers: SupplierOption[];
  suppliersEnabled: boolean;
  bulkSelect: boolean;
  /** Варианты просчёта заказа — ряд вкладок; null, если фича выключена. */
  calculations: OrderCalculationsDto | null;
}) {
  const { orderId, sample } = group;
  const isArchive = mode === 'archive';
  const archivable = isArchivableStatus(sample.orderStatus);

  // Фича «Варианты просчёта»: строки всех вариантов приходят вперемешку —
  // карточка показывает потребности АКТИВНОГО варианта (переключение —
  // вкладками ниже). Строки вне контура вариантов (sample/legacy,
  // orderCalculationId = null) показываем всегда.
  const activeCalcId = calculations?.activeId ?? null;
  const needs = activeCalcId
    ? group.needs.filter(
        (n) => n.orderCalculationId == null || n.orderCalculationId === activeCalcId,
      )
    : group.needs;

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

  const totalRub = sumRub(needs);
  const variantsCount = calculations?.items.length ?? 0;
  const activeVariant = calculations?.items.find((i) => i.isActive) ?? null;
  const activeIsDraft = activeVariant?.sentToCalculationAt == null;

  return (
    <CollapsibleOrderCard
      id={orderId}
      className={isArchive ? 'workshop-order-group-card--archived' : undefined}
      summary={
        <>
          {variantsCount > 1 ? `${variantsCount} варианта просчёта · ` : null}
          {needs.length} строк потребности
          {totalRub > 0 ? ` · ${formatRub(totalRub)}` : ''}
        </>
      }
      head={
        <ClickableCard
          href={orderHref}
          ariaLabel={
            sample.orderNumber
              ? `Открыть заказ ${sample.orderNumber}`
              : 'Открыть заказ'
          }
        >
        <header className="workshop-order-group-card__header">
        <div className="workshop-order-group-card__identity">
          <OrderArchiveCheckbox orderId={orderId} />
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
              {isArchive && <span className="wn-archive-chip">В архиве</span>}
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
            {isArchive && (
              <div className="workshop-order-group-card__meta-line wn-archive-meta">
                Архивирован: {formatDateTime(sample.orderNeedsArchivedAt)}
                {sample.orderNeedsArchivedByName
                  ? `, ${sample.orderNeedsArchivedByName}`
                  : ''}
              </div>
            )}
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
              {totalRub > 0 && (
                <span className="workshop-order-group-card__stat">
                  Итого: <strong>{formatRub(totalRub)}</strong>
                </span>
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
          {isCalculation && !isArchive && (
            <CompleteCalculationForm
              orderId={orderId}
              hasUsdLines={hasUsdLines}
              variant="compact"
            />
          )}
          {/* Фича «Архив расчётов цеха»: active → «В архив»;
              archive → «Восстановить» / «Удалить безвозвратно». */}
          <OrderArchiveRowActions orderId={orderId} archivable={archivable} />
        </div>
        </header>
        </ClickableCard>
      }
    >
      {/* Фича «Варианты просчёта»: ряд вкладок вариантов заказа. Клик
          переключает АКТИВНЫЙ вариант (та же ручка, что в карточке
          заказа) — строки ниже показывают его потребности. compact:
          состав вариантов правится в самом заказе. */}
      {!isArchive && calculations && calculations.items.length > 0 && (
        <div className="workshop-order-group-card__variants">
          <OrderCalcTabs orderId={orderId} initial={calculations} compact />
        </div>
      )}

      {!isArchive && needs.length === 0 && activeIsDraft && (
        <div className="workshop-order-group-card__draft">
          Активный вариант ещё не отправлен на расчёт — потребностей нет.
          Откройте заказ и нажмите «Рассчитать вариант».
        </div>
      )}

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
    </CollapsibleOrderCard>
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
  // Сумма по секции — видна и в свёрнутом виде (см. согласованный макет).
  const total = sumRub(needs);
  return (
    <CollapsibleSection
      kind={kind}
      label={WORKSHOP_NEED_KIND_LABELS[kind]}
      count={needs.length}
      sum={total > 0 ? formatRub(total) : null}
    >
      {needs.map((n) => (
        <InlineEditWorkshopNeedRow
          key={n.id}
          need={n}
          bulkSelect={bulkSelect}
          suppliers={suppliers}
          suppliersEnabled={suppliersEnabled}
        />
      ))}
    </CollapsibleSection>
  );
}
