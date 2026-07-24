/**
 * Admin-обёртка над списком заказов (`/admin/orders`).
 *
 * Зачем отдельная страница? Старый `/orders/page.tsx` живёт в общем
 * layout с `AppHeader` и стилями `page-header` / `data-table`. Когда
 * админ кликает в sidebar «Заказы», он ожидает увидеть тот же
 * AdminPageShell + AdminTable + AdminPagination, что и в остальных
 * разделах админки. Поэтому делаем тонкий wrapper, который дёргает
 * существующий `listOrders` (backend не меняем) и приводит его к
 * новому visual-стандарту.
 *
 * Колонка «Срок» и фильтр `?deadline=…` — управленческий слой
 * «Контроль сроков заказа». Бакет считается на бэке через общий
 * helper `evaluateOrderDeadline` и приходит в `OrderListItemDto.deadline`
 * (см. `@sewing/shared/order-deadlines`). Web ничего не пересчитывает —
 * мы только показываем `deadline.label / tone / daysLeft / progressPercent`
 * и сортируем по `ORDER_DEADLINE_SORT_PRIORITY`.
 *
 * Старый `/orders/*` остаётся на месте: он используется ролью
 * `CUTTER_ASSISTANT` (см. `/orders/[id]/passports/new`) и detail-page
 * `/orders/[id]`, на который мы продолжаем ссылаться через action
 * «Открыть» — переписывать всю detail-страницу под admin-стиль на
 * этом шаге слишком рискованно (там форма выпуска паспорта и
 * перевод статусов).
 */
import Link from 'next/link';
import {
  ArrowRight,
  Package,
  Plus,
  RotateCcw,
  Search as SearchIcon,
} from 'lucide-react';
import {
  ORDER_STATUSES,
  ORDER_SORTS,
  type ListOrdersQuery,
  type OrderDeadlineStatus,
  type OrderListItemDto,
  type OrderSort,
  type OrderStatus,
} from '@sewing/shared/orders';
import {
  ORDER_DEADLINE_LABELS,
  ORDER_DEADLINE_SORT_PRIORITY,
  ORDER_DEADLINE_STATUSES,
} from '@sewing/shared/order-deadlines';
import { ApiRequestError, errorText } from '@/lib/api';
import { listOrders } from '@/lib/orders-api';
import { listClients } from '@/lib/clients-api';
import { listCompanyDivisions } from '@/lib/company-settings-api';
import {
  ORDER_NOMENCLATURE_SOURCE_BADGE,
  resolveOrderNomenclature,
} from '@/lib/order-nomenclature';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { formatOrderStatus, getOrderStatusTone } from '@/lib/admin-labels';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
} from '@sewing/shared/constructor-tasks';
import {
  formatDateRu,
  formatDaysLeft,
  formatProgressPercent,
} from '@/lib/date-format';

export const dynamic = 'force-dynamic';

interface SearchParams {
  search?: string;
  status?: string;
  clientId?: string;
  companyDivisionId?: string;
  deadline?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
}

const SORT_LABELS: Record<OrderSort, string> = {
  createdAt_desc: 'Создан — новые сверху',
  createdAt_asc: 'Создан — старые сверху',
  orderDate_desc: 'Дата заказа — новые сверху',
  orderDate_asc: 'Дата заказа — старые сверху',
};

/**
 * Лейблы вкладок «бакетов контроля сроков». «DONE» в фильтре сознательно
 * не показываем — у завершённых заказов deadline-бейджа больше нет
 * смысла, для них есть фильтр по статусу `?status=DONE`.
 */
const DEADLINE_FILTER_TABS: Array<{
  value: '' | Exclude<OrderDeadlineStatus, 'DONE'>;
  label: string;
}> = [
  { value: '', label: 'Все' },
  { value: 'OVERDUE', label: ORDER_DEADLINE_LABELS.OVERDUE },
  { value: 'AT_RISK', label: ORDER_DEADLINE_LABELS.AT_RISK },
  { value: 'ON_TRACK', label: ORDER_DEADLINE_LABELS.ON_TRACK },
  { value: 'NO_DUE_DATE', label: ORDER_DEADLINE_LABELS.NO_DUE_DATE },
];

function parseStatus(s: string | undefined): OrderStatus | undefined {
  if (!s) return undefined;
  return (ORDER_STATUSES as readonly string[]).includes(s)
    ? (s as OrderStatus)
    : undefined;
}

function parseDeadline(s: string | undefined): OrderDeadlineStatus | undefined {
  if (!s) return undefined;
  return (ORDER_DEADLINE_STATUSES as readonly string[]).includes(s)
    ? (s as OrderDeadlineStatus)
    : undefined;
}

function parseSort(s: string | undefined): OrderSort {
  if (!s) return 'createdAt_desc';
  return (ORDER_SORTS as readonly string[]).includes(s)
    ? (s as OrderSort)
    : 'createdAt_desc';
}

function clampPageSize(raw: string | undefined): number {
  const allowed = [20, 50, 100];
  const n = Number(raw ?? 50);
  if (!Number.isInteger(n) || n <= 0) return 50;
  if (!allowed.includes(n)) return 50;
  return n;
}

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const me = await getCurrentUserOrNull();
  const role = me?.user.role;
  const isManager = role === 'ADMIN' || role === 'SHOP_MANAGER';

  const pageSize = clampPageSize(searchParams?.pageSize);
  const deadlineFilter = parseDeadline(searchParams?.deadline);
  const query: ListOrdersQuery = {
    search: searchParams?.search?.trim() || undefined,
    status: parseStatus(searchParams?.status),
    clientId: searchParams?.clientId?.trim() || undefined,
    companyDivisionId: searchParams?.companyDivisionId?.trim() || undefined,
    deadline: deadlineFilter,
    sort: parseSort(searchParams?.sort),
    page: Math.max(1, Number(searchParams?.page ?? 1) || 1),
    pageSize,
  };

  let items: OrderListItemDto[] = [];
  let total = 0;
  let error: string | null = null;
  // Списки для селектов-фильтров «Клиент» / «Подразделение». Тянем
  // параллельно с заказами; сбой любого справочника не должен ронять
  // страницу — тогда просто показываем фильтр без опций.
  const [ordersResult, clientsResult, divisionsResult] =
    await Promise.allSettled([
      listOrders(query),
      listClients(),
      listCompanyDivisions(),
    ]);
  if (ordersResult.status === 'fulfilled') {
    items = ordersResult.value.items;
    total = ordersResult.value.total;
  } else {
    const e = ordersResult.reason;
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить заказы';
  }
  const clients =
    clientsResult.status === 'fulfilled' ? clientsResult.value : [];
  const divisions =
    divisionsResult.status === 'fulfilled' ? divisionsResult.value : [];

  // Дефолтная управленческая сортировка: OVERDUE → AT_RISK → ON_TRACK
  // → NO_DUE_DATE → DONE; внутри бакета — ближайший dueDate выше.
  // Применяем только когда пользователь не задал явный `sort`.
  const userPickedSort = (searchParams?.sort ?? '').length > 0;
  if (!userPickedSort) {
    items = [...items].sort((a, b) => {
      const pa = ORDER_DEADLINE_SORT_PRIORITY[a.deadline?.status ?? 'NO_DUE_DATE'];
      const pb = ORDER_DEADLINE_SORT_PRIORITY[b.deadline?.status ?? 'NO_DUE_DATE'];
      if (pa !== pb) return pa - pb;
      const da = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });
  }

  const preserveParams: Record<string, string | undefined> = {
    search: query.search,
    status: query.status,
    clientId: query.clientId,
    companyDivisionId: query.companyDivisionId,
    deadline: query.deadline,
    sort: query.sort,
  };

  return (
    <AdminPageShell
      icon={<Package size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы"
      subtitle="Заказы в производстве и подготовке"
      actions={
        isManager ? (
          <Link
            href="/admin/orders/new"
            className="admin-btn admin-btn--primary"
          >
            <Plus size={16} strokeWidth={1.6} aria-hidden />
            Создать заказ
          </Link>
        ) : null
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader
          title="Список"
          hint={total > 0 ? `Всего: ${total.toLocaleString('ru-RU')}` : undefined}
        />

        <DeadlineTabs
          active={deadlineFilter ?? null}
          preserve={{
            search: query.search,
            status: query.status,
            clientId: query.clientId,
            companyDivisionId: query.companyDivisionId,
            sort: query.sort,
          }}
        />

        <form method="get" className="admin-form-grid" role="search">
          {/* Сохраняем активный deadline-таб при submit-е формы поиска */}
          {deadlineFilter && (
            <input type="hidden" name="deadline" value={deadlineFilter} />
          )}
          <div className="admin-field">
            <label htmlFor="orders-search">Номер / клиент</label>
            <input
              id="orders-search"
              name="search"
              type="text"
              placeholder="Например, 1024"
              defaultValue={query.search ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="orders-status">Статус</label>
            <select
              id="orders-status"
              name="status"
              defaultValue={query.status ?? ''}
            >
              <option value="">Все статусы</option>
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {formatOrderStatus(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="orders-client">Клиент</label>
            <select
              id="orders-client"
              name="clientId"
              defaultValue={query.clientId ?? ''}
            >
              <option value="">Все клиенты</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="orders-division">Подразделение</label>
            <select
              id="orders-division"
              name="companyDivisionId"
              defaultValue={query.companyDivisionId ?? ''}
            >
              <option value="">Все подразделения</option>
              {divisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="orders-sort">Сортировка</label>
            <select
              id="orders-sort"
              name="sort"
              defaultValue={query.sort}
            >
              {ORDER_SORTS.map((s) => (
                <option key={s} value={s}>
                  {SORT_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="admin-field admin-field--inline" style={{ alignSelf: 'end' }}>
            <button type="submit" className="admin-btn admin-btn--primary">
              <SearchIcon size={14} strokeWidth={1.6} aria-hidden />
              Применить
            </button>
            <Link href="/admin/orders" className="admin-btn admin-btn--ghost">
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сбросить
            </Link>
          </div>
        </form>

        <OrdersTable items={items} />

        <AdminPagination
          page={query.page ?? 1}
          pageSize={pageSize}
          total={total}
          basePath="/admin/orders"
          preserveParams={preserveParams}
          label="заказов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

/**
 * Горизонтальный ряд табов «бакетов контроля сроков». На клик
 * — обычный `<Link>` со сменой `?deadline=…`. Таб «Все» сбрасывает
 * параметр (`href` без `deadline`). Сохраняем search/status/sort,
 * чтобы пользователь не терял уже наложенные фильтры.
 */
function DeadlineTabs({
  active,
  preserve,
}: {
  active: OrderDeadlineStatus | null;
  preserve: Record<string, string | undefined>;
}) {
  function buildHref(value: '' | OrderDeadlineStatus): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(preserve)) {
      if (v !== undefined && v !== '') params.set(k, v);
    }
    if (value) params.set('deadline', value);
    const qs = params.toString();
    return qs.length > 0 ? `/admin/orders?${qs}` : '/admin/orders';
  }
  return (
    <nav className="admin-deadline-tabs" aria-label="Контроль сроков">
      {DEADLINE_FILTER_TABS.map((t) => {
        const isActive = (t.value || null) === active;
        return (
          <Link
            key={t.value || 'ALL'}
            href={buildHref(t.value)}
            className={`admin-deadline-tab${
              isActive ? ' admin-deadline-tab--active' : ''
            }${
              t.value ? ` admin-deadline-tab--${t.value.toLowerCase()}` : ''
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

function OrdersTable({ items }: { items: OrderListItemDto[] }) {
  const columns: AdminTableColumn<OrderListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (o) => (
        <span className="admin-table__primary">{o.number}</span>
      ),
    },
    {
      key: 'client',
      header: 'Клиент',
      render: (o) => <ClientCell o={o} />,
    },
    {
      key: 'division',
      header: 'Подразд.',
      render: (o) =>
        o.companyDivision ? (
          <span title={o.companyDivision.name}>{o.companyDivision.code}</span>
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'product',
      header: 'Изделие',
      render: (o) => {
        // Этап «Номенклатура = Лекала»: список заказов идёт через тот
        // же resolver, что и карточка заказа
        // (`apps/web/lib/order-nomenclature.ts`). Раньше колонка
        // показывала legacy `Product.name`, который сознательно НЕ
        // синхронизируется при переименовании `PatternItem`, поэтому
        // менеджер мог увидеть «Худи» в списке и «ХУДИ БАЗА (КЕНГУРУ)»
        // в открытой карточке одного и того же заказа.
        const nomenclature = resolveOrderNomenclature(o);
        const hintParts: string[] = [];
        if (o.color) hintParts.push(o.color);
        if (nomenclature.article) {
          hintParts.push(`арт. ${nomenclature.article}`);
        }
        return (
          <div>
            <span className="admin-table__primary">
              {nomenclature.name ?? '—'}
            </span>
            {nomenclature.source === 'legacyProduct' && (
              <span
                className="admin-order-item-card__source-badge"
                title="Историческое изделие без карточки лекала"
              >
                {ORDER_NOMENCLATURE_SOURCE_BADGE.legacyProduct}
              </span>
            )}
            {hintParts.length > 0 && (
              <div className="admin-table__hint">
                {hintParts.join(' · ')}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Статус',
      render: (o) => {
        // Маленький бейдж конструкторской задачи показываем только для
        // активных статусов: NEW/IN_PROGRESS/PENDING_ACCEPT/REWORK.
        // DONE/CANCELLED оператору заказов неинтересны (лекало уже
        // принято или задача отменена — заказ можно вести как обычно).
        const taskStatus = o.constructorTaskStatus as
          | keyof typeof CONSTRUCTOR_TASK_STATUS_LABELS
          | null
          | undefined;
        const showTaskBadge =
          taskStatus &&
          taskStatus !== 'DONE' &&
          taskStatus !== 'CANCELLED';
        return (
          <span
            style={{
              display: 'inline-flex',
              gap: '0.35rem',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <AdminStatusBadge tone={getOrderStatusTone(o.status)}>
              {formatOrderStatus(o.status)}
            </AdminStatusBadge>
            {showTaskBadge && (
              <AdminStatusBadge
                tone={CONSTRUCTOR_TASK_STATUS_TONE[taskStatus]}
              >
                КБ: {CONSTRUCTOR_TASK_STATUS_LABELS[taskStatus]}
              </AdminStatusBadge>
            )}
          </span>
        );
      },
    },
    {
      key: 'qty',
      header: 'Кол-во',
      align: 'right',
      render: (o) => (
        <strong>{o.qtyPlanTotal.toLocaleString('ru-RU')}</strong>
      ),
    },
    {
      key: 'price',
      header: 'Цена',
      align: 'right',
      render: (o) => <PriceCell o={o} />,
    },
    {
      key: 'date',
      header: 'Дата',
      render: (o) => formatDateRu(o.orderDate),
    },
    {
      key: 'deadline',
      header: 'Срок',
      render: (o) => <DeadlineCell o={o} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (o) => (
        <Link
          href={`/admin/orders/${o.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminTable
      rows={items}
      columns={columns}
      rowKey={(o) => o.id}
      rowHref={(o) => `/admin/orders/${o.id}`}
      emptyContent={
        <AdminEmptyState
          icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
          title="Заказов пока нет"
          hint="Создайте первый заказ, чтобы запустить производство."
        />
      }
    />
  );
}

/**
 * Колонка «Клиент» в списке заказов. До этого имя клиента жило
 * мелким хинтом под номером заказа — теперь это отдельный столбец,
 * чтобы менеджеру было удобнее сканировать список по клиентам.
 *
 * Если заказ привязан к карточке клиента (`o.client`), имя кликабельно
 * и ведёт в `/admin/clients/[id]`. Старый free-text `o.customer`
 * (заказы без привязки к справочнику) показываем как простой текст.
 */
function ClientCell({ o }: { o: OrderListItemDto }) {
  if (o.client) {
    return (
      <Link
        href={`/admin/clients/${o.client.id}`}
        className="admin-link"
      >
        {o.client.name}
      </Link>
    );
  }
  if (o.customer) {
    return <span>{o.customer}</span>;
  }
  return <span className="admin-muted">—</span>;
}

/**
 * Колонка «Цена» в списке заказов (этап «Цена продажи за единицу»,
 * см. ТЗ §C6). Показываем компактно: «2500 ₽ / шт» или прочерк,
 * если цена не задана. Себестоимость оставляем для карточки
 * заказа — в списке она тоже жирная и рискует разъехаться.
 */
function PriceCell({ o }: { o: OrderListItemDto }) {
  const price = o.customerUnitPrice ?? null;
  if (price == null || price === '' || Number(price) <= 0) {
    return <span className="admin-muted">—</span>;
  }
  const num = Number(price);
  if (!Number.isFinite(num)) return <span className="admin-muted">—</span>;
  const symbol =
    (o.customerCurrency ?? 'RUB') === 'USD' ? '$' : '₽';
  return (
    <div className="admin-order-price-cell">
      <strong>
        {num.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} {symbol}
      </strong>
      <span className="admin-muted admin-order-price-cell__hint">/ шт</span>
    </div>
  );
}

/**
 * Колонка «Срок» в списке заказов. Backend уже посчитал бакет в
 * `o.deadline`; мы рендерим: дату сдачи, бейдж бакета, краткую подпись
 * «осталось / просрочено / сегодня» и компактный прогресс выпуска.
 */
function DeadlineCell({ o }: { o: OrderListItemDto }) {
  const d = o.deadline;
  if (!d) {
    return <span className="admin-muted">—</span>;
  }
  const tone = (d.tone as AdminStatusTone) ?? 'muted';
  const showProgress = d.progressPercent !== null;
  return (
    <div className="admin-deadline-cell">
      <div className="admin-deadline-cell__row">
        <span className="admin-deadline-cell__date">
          {formatDateRu(o.dueDate)}
        </span>
        <AdminStatusBadge tone={tone}>{d.label}</AdminStatusBadge>
      </div>
      {(d.daysLeft !== null || showProgress) && (
        <div className="admin-deadline-cell__hint">
          {d.daysLeft !== null && (
            <span>{formatDaysLeft(d.daysLeft)}</span>
          )}
          {d.daysLeft !== null && showProgress && (
            <span aria-hidden> · </span>
          )}
          {showProgress && (
            <span>готово {formatProgressPercent(d.progressPercent)}</span>
          )}
        </div>
      )}
    </div>
  );
}
