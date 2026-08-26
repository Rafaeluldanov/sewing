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
 * Вкладки «Активные» / «Архив» (`?tab=archive`) — тот же контур, что в
 * справочниках админки, но архивность заказа НЕ отдельный флаг, а
 * производная от статуса: в архив уезжают заказы в
 * `ORDER_ARCHIVED_STATUSES` (сейчас — только `CANCELLED`). Отменённый
 * заказ терминален (`evaluateOrderTransitions`), вернуть его в работу
 * нельзя — архив только для просмотра. Фильтрует и считает обе вкладки
 * backend (`OrdersService.list`, параметр `tab` → `tabCounts`).
 *
 * Колонка «Срок» и фильтр `?deadline=…` — управленческий слой
 * «Контроль сроков заказа». Бакет считается на бэке через общий
 * helper `evaluateOrderDeadline` и приходит в `OrderListItemDto.deadline`
 * (см. `@sewing/shared/order-deadlines`). Web ничего не пересчитывает —
 * мы только показываем `deadline.label / tone / daysLeft / progressPercent`;
 * порядок строк задаёт backend (по умолчанию — свежесозданные сверху).
 *
 * Старый `/orders/*` остаётся на месте: он используется ролью
 * `CUTTER_ASSISTANT` (см. `/orders/[id]/passports/new`) и detail-page
 * `/orders/[id]`, на который мы продолжаем ссылаться через action
 * «Открыть» — переписывать всю detail-страницу под admin-стиль на
 * этом шаге слишком рискованно (там форма выпуска паспорта и
 * перевод статусов).
 */
import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  FileText,
  Package,
  Plus,
  RotateCcw,
  Search as SearchIcon,
} from 'lucide-react';
import {
  ORDER_STATUSES,
  ORDER_SORTS,
  isOrderArchived,
  type ListOrdersQuery,
  type OrderDeadlineStatus,
  type OrderListItemDto,
  type OrderListTab,
  type OrderListTabCounts,
  type OrderSort,
  type OrderStatus,
} from '@sewing/shared/orders';
import {
  ORDER_DEADLINE_LABELS,
  ORDER_DEADLINE_STATUSES,
} from '@sewing/shared/order-deadlines';
import { ApiRequestError, errorText } from '@/lib/api';
import { listOrders } from '@/lib/orders-api';
import { listClients } from '@/lib/clients-api';
import {
  getCompanySettings,
  listCompanyDivisions,
} from '@/lib/company-settings-api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  AdminArchiveTabs,
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { formatOrderStatus } from '@/lib/admin-labels';
import { OrderStatusSelect } from '@/components/orders/view/order-status-select';
import {
  CONSTRUCTOR_TASK_STATUS_LABELS,
  CONSTRUCTOR_TASK_STATUS_TONE,
} from '@sewing/shared/constructor-tasks';
import { formatDateRu } from '@/lib/date-format';

export const dynamic = 'force-dynamic';

interface SearchParams {
  search?: string;
  status?: string;
  clientId?: string;
  companyDivisionId?: string;
  deadline?: string;
  /** Вкладка списка: без параметра — «Активные», `archive` — «Архив». */
  tab?: string;
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

/**
 * Вкладка списка. По умолчанию — «Активные»: рабочий список без
 * отменённых заказов.
 *
 * Отдельный случай — старая ссылка/закладка вида `?status=CANCELLED`:
 * такой статус живёт теперь только в архиве, поэтому запрос сам
 * переключает вкладку (иначе пользователь получил бы пустой экран).
 */
function parseTab(sp: SearchParams | undefined): OrderListTab {
  if (sp?.tab === 'archive') return 'archive';
  const status = parseStatus(sp?.status);
  return status && isOrderArchived(status) ? 'archive' : 'active';
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
  const tab = parseTab(searchParams);
  const isArchive = tab === 'archive';
  // В архиве лежат заказы ровно одного статуса (`CANCELLED`), поэтому
  // ни селект статуса, ни бакеты контроля сроков там не имеют смысла —
  // не показываем их и не пробрасываем в запрос.
  const deadlineFilter = isArchive
    ? undefined
    : parseDeadline(searchParams?.deadline);
  const statusFilter = isArchive
    ? undefined
    : parseStatus(searchParams?.status);
  const query: ListOrdersQuery = {
    search: searchParams?.search?.trim() || undefined,
    status: statusFilter,
    clientId: searchParams?.clientId?.trim() || undefined,
    companyDivisionId: searchParams?.companyDivisionId?.trim() || undefined,
    deadline: deadlineFilter,
    tab,
    sort: parseSort(searchParams?.sort),
    page: Math.max(1, Number(searchParams?.page ?? 1) || 1),
    pageSize,
  };

  let items: OrderListItemDto[] = [];
  let total = 0;
  let tabCounts: OrderListTabCounts | null = null;
  let error: string | null = null;
  // Списки для селектов-фильтров «Клиент» / «Подразделение». Тянем
  // параллельно с заказами; сбой любого справочника не должен ронять
  // страницу — тогда просто показываем фильтр без опций.
  const [ordersResult, clientsResult, divisionsResult, settingsResult] =
    await Promise.allSettled([
      listOrders(query),
      listClients(),
      listCompanyDivisions(),
      getCompanySettings(),
    ]);
  if (ordersResult.status === 'fulfilled') {
    items = ordersResult.value.items;
    total = ordersResult.value.total;
    tabCounts = ordersResult.value.tabCounts ?? null;
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
  // «Организация» (наше юр.лицо) — singleton `CompanySettings`, одна на всю
  // компанию. Отдельного поля в заказе нет, поэтому колонка показывает это
  // значение во всех строках (см. решение по дизайну вкладки «Заказы»).
  const orgName =
    settingsResult.status === 'fulfilled'
      ? settingsResult.value.shortName ??
        settingsResult.value.legalName ??
        null
      : null;

  // Порядок списка целиком задаёт backend (`OrdersService.list`):
  // по умолчанию `createdAt_desc` — свежесозданные заказы сверху.
  // Раньше здесь была in-memory пересортировка по deadline-бакетам
  // (OVERDUE → AT_RISK → …) — убрана по решению от 09.08.2026; срезы
  // по срокам остаются доступны через бакеты `?deadline=…`.
  const userPickedSort = (searchParams?.sort ?? '').length > 0;

  // `tab` держим во всех переходах внутри страницы (пагинация, поиск,
  // бакеты сроков), иначе любой клик выкидывал бы из архива в активные.
  const tabParam = isArchive ? 'archive' : undefined;
  const preserveParams: Record<string, string | undefined> = {
    search: query.search,
    status: query.status,
    clientId: query.clientId,
    companyDivisionId: query.companyDivisionId,
    deadline: query.deadline,
    tab: tabParam,
    sort: query.sort,
  };
  /** Ссылка «Сбросить» — чистый список ТЕКУЩЕЙ вкладки. */
  const resetHref = isArchive ? '/admin/orders?tab=archive' : '/admin/orders';

  return (
    <AdminPageShell
      icon={<Package size={22} strokeWidth={1.6} aria-hidden />}
      title="Заказы"
      subtitle={
        isArchive
          ? 'Отменённые заказы — только просмотр'
          : 'Заказы в производстве и подготовке'
      }
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

        {/*
          Вкладки «Активные» / «Архив» — тот же контур, что в справочниках
          админки. Архив заказа — производная от статуса (`CANCELLED`),
          отдельного `archivedAt` у заказа нет: см. `ORDER_ARCHIVED_STATUSES`.
          Счётчики считает backend под теми же фильтрами, что и выдачу;
          если ручка их не вернула (ошибка запроса) — показываем то, что
          знаем про текущую вкладку, и 0 про соседнюю.
        */}
        <AdminArchiveTabs
          basePath="/admin/orders"
          tab={tab}
          activeCount={tabCounts?.active ?? (isArchive ? 0 : total)}
          archiveCount={tabCounts?.archive ?? (isArchive ? total : 0)}
          preserveParams={{
            search: query.search,
            clientId: query.clientId,
            companyDivisionId: query.companyDivisionId,
            sort: userPickedSort ? query.sort : undefined,
          }}
        />

        {!isArchive && (
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
        )}

        <form method="get" className="admin-form-grid" role="search">
          {/* Сохраняем активный deadline-таб при submit-е формы поиска */}
          {deadlineFilter && (
            <input type="hidden" name="deadline" value={deadlineFilter} />
          )}
          {/* …и саму вкладку: submit формы не должен уводить из архива */}
          {isArchive && <input type="hidden" name="tab" value="archive" />}
          {/* Динамический поиск «на лету» по любому текстовому параметру
              заказа (номер / изделие / клиент / подразделение / дата /
              срок). Матч — нечувствительный к регистру и частичный, начиная
              с первой буквы; мультиполевой OR делает backend
              (OrdersService.list → buildOrderSearchOr). Изделие ищется по
              тем же трём источникам имени, что показывает колонка
              «Изделие»: snapshot заказа, живая карточка лекала, legacy
              `product.name`.
              Поле остаётся в форме с name="search", поэтому Enter/«Применить»
              работают как фолбэк. */}
          <AdminSearchInput
            id="orders-search"
            placeholder="Номер, изделие, клиент, подразделение, дата…"
            initial={query.search ?? ''}
            basePath="/admin/orders"
            preserveParams={{
              status: query.status,
              clientId: query.clientId,
              companyDivisionId: query.companyDivisionId,
              deadline: query.deadline,
              tab: tabParam,
              sort: userPickedSort ? query.sort : undefined,
              pageSize: pageSize !== 50 ? String(pageSize) : undefined,
            }}
          />
          {/*
            Селект статуса — только на вкладке «Активные». В архиве все
            заказы одного статуса («Отменён»), фильтровать нечего; сам
            «Отменён» из списка опций убран — он теперь живёт в архиве.
          */}
          {!isArchive && (
            <div className="admin-field">
              <label htmlFor="orders-status">Статус</label>
              <select
                id="orders-status"
                name="status"
                defaultValue={query.status ?? ''}
              >
                <option value="">Все статусы</option>
                {ORDER_STATUSES.filter((s) => !isOrderArchived(s)).map((s) => (
                  <option key={s} value={s}>
                    {formatOrderStatus(s)}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            <Link href={resetHref} className="admin-btn admin-btn--ghost">
              <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
              Сбросить
            </Link>
          </div>
        </form>

        <OrdersTable
          items={items}
          orgName={orgName}
          canManage={isManager}
          isArchive={isArchive}
          filtered={Boolean(
            query.search ||
              query.status ||
              query.clientId ||
              query.companyDivisionId ||
              deadlineFilter,
          )}
        />

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

function OrdersTable({
  items,
  orgName,
  filtered,
  canManage,
  isArchive,
}: {
  items: OrderListItemDto[];
  orgName: string | null;
  /** Активен ли поиск/фильтр — от этого зависит текст пустого состояния. */
  filtered: boolean;
  /**
   * ADMIN/SHOP_MANAGER — статус в строке переключаемый; остальным
   * (CUTTER_ASSISTANT) контрол рисуется обычным бейджем.
   */
  canManage: boolean;
  /** Вкладка «Архив» — меняет только пустое состояние таблицы. */
  isArchive: boolean;
}) {
  const columns: AdminTableColumn<OrderListItemDto>[] = [
    {
      key: 'number',
      header: 'Номер',
      render: (o) => (
        <Link
          href={`/admin/orders/${o.id}`}
          className="admin-order-number-link"
        >
          <FileText size={15} strokeWidth={1.6} aria-hidden />
          {o.number}
        </Link>
      ),
    },
    {
      key: 'date',
      header: 'Дата',
      render: (o) => formatDateRu(o.orderDate),
    },
    {
      key: 'deadline',
      header: 'Сроки',
      render: (o) => <DeadlineCell o={o} />,
    },
    {
      key: 'product',
      header: 'Изделие',
      render: (o) => <ProductCell o={o} />,
    },
    {
      key: 'client',
      header: 'Клиент',
      render: (o) => <ClientCell o={o} />,
    },
    {
      key: 'organization',
      header: 'Организация',
      render: () =>
        orgName ? (
          <div
            className="admin-cell-marquee"
            style={{ '--admin-marquee-w': '9rem' } as CSSProperties}
          >
            <span className="admin-cell-marquee__text" title={orgName}>
              {orgName}
            </span>
          </div>
        ) : (
          <span className="admin-muted">—</span>
        ),
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
      key: 'total',
      header: 'Сумма',
      align: 'right',
      render: (o) => <OrderTotalCell o={o} />,
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
              // Строка списка — ровно в одну строку: бейдж КБ уезжает
              // вправо вместе со статусом, а не переносится под него.
              flexWrap: 'nowrap',
            }}
          >
            {/*
              Контрол «Статус заказа» прямо в строке: список переходов
              догружается лениво по открытию (`GET /orders/:id/transitions`),
              а не считается для всех строк на рендере — это N заказов ×
              проверки позиций/лекала/состава материалов.
            */}
            <OrderStatusSelect
              orderId={o.id}
              status={o.status}
              compact
              readOnly={!canManage}
            />
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
  ];

  // `admin-table--oneline`: ряд списка — ровно в одну строку. Ни одна
  // ячейка не переносится, длинный текст обрезается троеточием (полный —
  // в `title` и бегущей строкой на ховере). См. `globals.css`.
  return (
    <AdminTable
      rows={items}
      columns={columns}
      rowKey={(o) => o.id}
      rowHref={(o) => `/admin/orders/${o.id}`}
      className="admin-table--oneline"
      emptyContent={
        filtered ? (
          <AdminEmptyState
            icon={<SearchIcon size={26} strokeWidth={1.6} aria-hidden />}
            title="Данные не найдены"
            hint="По заданному поиску и фильтрам заказов нет. Измените запрос или сбросьте фильтры."
          />
        ) : isArchive ? (
          <AdminEmptyState
            icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
            title="Архив пуст"
            hint="Сюда попадают отменённые заказы — их не удаляют, но и в рабочем списке они не мешают."
          />
        ) : (
          <AdminEmptyState
            icon={<Package size={26} strokeWidth={1.6} aria-hidden />}
            title="Заказов пока нет"
            hint="Создайте первый заказ, чтобы запустить производство."
          />
        )
      }
    />
  );
}

/**
 * Колонка «Изделие» — что именно шьём по этому заказу.
 *
 * Имя берём по тому же правилу, что и hero-карточка заказа
 * (`pickHeroNomenclature`): snapshot заказа главнее live-карточки
 * лекала, а `productName` — фолбэк для исторических заказов без
 * привязки к лекалу. Иначе список и карточка называли бы одно и то же
 * изделие по-разному после правки номенклатуры.
 *
 * В колонке ТОЛЬКО название: артикул из списка убран (ряд держим ровно
 * в одну строку, а по артикулу список не сканируют — он есть в карточке
 * заказа и в справочнике лекал).
 *
 * Ширина колонки фиксирована (`--admin-marquee-w`), иначе длинное имя
 * изделия растягивает колонку и перекраивает всю таблицу. Не влезающий
 * текст обрезается троеточием, а на ховере строки едет бегущей строкой
 * (см. `.admin-cell-marquee` в `globals.css`). `title` оставляем как
 * доступный фолбэк — нативная подсказка покажет имя целиком.
 */
function ProductCell({ o }: { o: OrderListItemDto }) {
  const name =
    o.patternNameSnapshot ?? o.patternName ?? o.productName ?? null;
  if (!name) {
    return <span className="admin-muted">—</span>;
  }
  return (
    <div
      className="admin-cell-marquee"
      style={{ '--admin-marquee-w': '16rem' } as CSSProperties}
    >
      <span
        className="admin-cell-marquee__text admin-table__primary"
        title={name}
      >
        {name}
      </span>
    </div>
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
 *
 * Ширина фиксирована так же, как у «Изделия»: юрлица в справочнике
 * длинные («АКЦИОНЕРНОЕ ОБЩЕСТВО …»), и без ограничения такое имя
 * переносилось на 2-3 строки и задирало высоту всего ряда.
 */
function ClientCell({ o }: { o: OrderListItemDto }) {
  const name = o.client?.name ?? o.customer ?? null;
  if (!name) {
    return <span className="admin-muted">—</span>;
  }
  return (
    <div
      className="admin-cell-marquee"
      style={{ '--admin-marquee-w': '12rem' } as CSSProperties}
    >
      <span className="admin-cell-marquee__text" title={name}>
        {o.client ? (
          <Link href={`/admin/clients/${o.client.id}`} className="admin-link">
            {name}
          </Link>
        ) : (
          name
        )}
      </span>
    </div>
  );
}

/**
 * Колонка «Сумма» — сумма заказа = цена продажи за единицу × плановое
 * количество. Отдельного поля «итого» в заказе нет (храним цену за 1 шт
 * в `customerUnitPrice`), поэтому считаем на лету. Прочерк, если цена не
 * задана.
 */
function OrderTotalCell({ o }: { o: OrderListItemDto }) {
  const raw = o.customerUnitPrice;
  const price = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(price) || price <= 0) {
    return <span className="admin-muted">—</span>;
  }
  const symbol = (o.customerCurrency ?? 'RUB') === 'USD' ? '$' : '₽';
  const total = price * o.qtyPlanTotal;
  return (
    <strong>
      {total.toLocaleString('ru-RU', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}{' '}
      {symbol}
    </strong>
  );
}

/**
 * Колонка «Срок» — ТОЛЬКО дата сдачи, но не крашеным текстом, а ЗАЛИТАЯ
 * мягким цветом бакета контроля сроков (как раньше выглядел бейдж
 * статуса): просрочен → красная заливка, в риске → янтарная, в срок →
 * зелёная, без срока/готов → серая. Сам текст даты остаётся чёрным.
 * Пилюля и токены — `admin-deadline-pill*` из `globals.css` (те же
 * `-soft`-фоны, что у `AdminStatusBadge`).
 */
function DeadlineCell({ o }: { o: OrderListItemDto }) {
  if (!o.dueDate) {
    return <span className="admin-muted">—</span>;
  }
  const tone = (o.deadline?.tone as AdminStatusTone) ?? 'muted';
  return (
    <span className={`admin-deadline-pill admin-deadline-pill--${tone}`}>
      {formatDateRu(o.dueDate)}
    </span>
  );
}
