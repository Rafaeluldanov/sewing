/**
 * Список ДОКУМЕНТОВ ВЫПУСКА (`/admin/production-documents`).
 *
 * Что это за экран. Документ выпуска — свод по закрытому заказу: что цех сдал и почём.
 * Паспорта заказа собираются в один документ, себестоимость пишется снимком. Экран —
 * реестр таких документов: найти нужный, увидеть сумму и понять, ждём мы ещё факты
 * или документ уже сложился.
 *
 * ⛔ Доменное правило, которое держит эта страница: документ НЕ заводят, НЕ проводят и
 * НЕ подтверждают — ни человек, ни ERP (ERP только читает готовые документы). Поэтому
 * здесь нет ни одной кнопки действия: ни «Создать», ни «Провести», ни «Пересчитать».
 * Состояния всего два, и оба наступают сами:
 *   `FORMING` — факты ещё идут (открыта коробка / не подтверждены начисления);
 *   `READY`   — лёг последний факт (`lastFactKind`), себестоимость зафиксирована.
 * `recalculatedAt != null` значит «после фиксации пришёл ещё факт и документ пересобрался» —
 * помечаем это в строке ненавязчивым бейджем, чтобы разошедшаяся сумма не выглядела ошибкой.
 *
 * Откуда данные. `listProductionDocuments` → `GET /api/admin/production-documents`
 * (`apps/api/src/modules/production-documents`). Фильтр по статусу, поиск (номер документа,
 * номер заказа, клиент) и пагинация — целиком серверные: web ничего не досчитывает и не
 * пересортировывает, порядок задаёт backend (свежезакрытые сверху).
 *
 * Про деньги в колонке «Себестоимость»: это `totalRub` — снимок БЕЗ `pieceworkPendingRub`
 * (неподтверждённая сделка — обещание, а не трата). Разложение по компонентам и отдельная
 * предупреждающая строка про «в сумму не входит» живут в карточке документа.
 *
 * Права не проверяем: гейт `/admin/*` уже стоит в `apps/web/app/admin/layout.tsx`.
 */
import Link from 'next/link';
import { ArrowRight, FileText, PackageCheck } from 'lucide-react';
import {
  PRODUCTION_DOCUMENT_FACT_KIND_LABELS,
  PRODUCTION_DOCUMENT_STATUS_LABELS,
  PRODUCTION_DOCUMENT_STATUSES,
  type ProductionDocumentListItemDto,
  type ProductionDocumentStatus,
} from '@sewing/shared/production-documents';
import { ApiRequestError, errorText } from '@/lib/api';
import { listProductionDocuments } from '@/lib/production-documents-api';
import {
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

export const dynamic = 'force-dynamic';

const BASE_PATH = '/admin/production-documents';

/**
 * Даты форматируем ЖЁСТКО в московской зоне. RSC рендерит строку на сервере (там UTC), а
 * гидратация идёт в браузере пользователя (обычно MSK) — без явного `timeZone` дата у
 * ночных событий разъезжается и React ругается на hydration mismatch.
 * Общий `formatDateRu` из `lib/date-format` зону не фиксирует, поэтому здесь свои хелперы.
 */
const MSK = 'Europe/Moscow';

interface SearchParams {
  status?: string;
  search?: string;
  page?: string;
  pageSize?: string;
}

/**
 * Вкладки — это срез по статусу, а не архив, поэтому `AdminArchiveTabs` не подходит:
 * рисуем ряд `.admin-tab` руками. Подписи вкладок — во множественном числе (это навигация
 * «покажи мне такие документы»); лейбл самого статуса в строке берём строго из
 * `PRODUCTION_DOCUMENT_STATUS_LABELS`, коды наружу не показываем.
 */
const TABS: Array<{ key: 'FORMING' | 'READY' | 'ALL'; label: string }> = [
  { key: 'FORMING', label: 'Формируются' },
  { key: 'READY', label: 'Сформированные' },
  { key: 'ALL', label: 'Все' },
];

/** Размеры страницы: backend режет `pageSize` по 100, шире не просим. */
const PAGE_SIZES = [20, 50, 100];

function parseStatus(
  raw: string | undefined,
): ProductionDocumentStatus | undefined {
  if (!raw) return undefined;
  return (PRODUCTION_DOCUMENT_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProductionDocumentStatus)
    : undefined;
}

function clampPageSize(raw: string | undefined): number {
  const n = Number(raw ?? PAGE_SIZES[0]);
  return PAGE_SIZES.includes(n) ? n : PAGE_SIZES[0];
}

function formatDateMsk(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ru-RU', {
    timeZone: MSK,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatDateTimeMsk(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    timeZone: MSK,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Деньги в списке — всегда с копейками: суммы сверяют с бухгалтерией. */
function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ₽`;
}

function formatQty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return value.toLocaleString('ru-RU');
}

function buildHref(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
}

export default async function AdminProductionDocumentsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const status = parseStatus(searchParams?.status);
  const search = searchParams?.search?.trim() || undefined;
  const page = Math.max(1, Number(searchParams?.page ?? 1) || 1);
  const pageSize = clampPageSize(searchParams?.pageSize);
  const activeTab: 'FORMING' | 'READY' | 'ALL' = status ?? 'ALL';

  let items: ProductionDocumentListItemDto[] = [];
  let total = 0;
  let formingCount = 0;
  let error: string | null = null;
  try {
    const data = await listProductionDocuments({
      status,
      search,
      page,
      pageSize,
    });
    items = data.items;
    total = data.total;
    formingCount = data.formingCount;
  } catch (e) {
    // Сбой ручки не роняет раздел: показываем полосу с ошибкой и пустой список.
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить документы выпуска';
  }

  // Эти параметры обязаны пережить и набор в поиске, и переключение страницы: иначе
  // первая же буква в поле выбрасывает человека из выбранной вкладки в «Все».
  const preserveParams: Record<string, string | undefined> = {
    status,
    search,
    pageSize: pageSize !== PAGE_SIZES[0] ? String(pageSize) : undefined,
  };

  const columns: AdminTableColumn<ProductionDocumentListItemDto>[] = [
    {
      key: 'number',
      header: 'Документ',
      render: (doc) => <NumberCell doc={doc} />,
    },
    {
      key: 'order',
      header: 'Заказ',
      render: (doc) => (
        <span style={{ display: 'grid', gap: 2 }}>
          <span className="admin-table__primary">{doc.orderNumber}</span>
          {doc.patternName && (
            <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
              {doc.patternName}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Клиент',
      render: (doc) =>
        doc.customer ? (
          doc.customer
        ) : (
          <span className="admin-muted">—</span>
        ),
    },
    {
      key: 'qty',
      header: 'Годных',
      align: 'right',
      render: (doc) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <strong>{formatQty(doc.qtyGood)}</strong>
          <span className="admin-muted"> из {formatQty(doc.qtyPlan)}</span>
        </span>
      ),
    },
    {
      key: 'total',
      header: 'Себестоимость',
      align: 'right',
      // Ровно `totalRub` из снимка — ничего не пересчитываем на фронте.
      render: (doc) => (
        <span style={{ whiteSpace: 'nowrap' }}>{formatMoney(doc.totalRub)}</span>
      ),
    },
    {
      key: 'perUnit',
      header: 'За ед.',
      align: 'right',
      render: (doc) => (
        <span className="admin-muted" style={{ whiteSpace: 'nowrap' }}>
          {formatMoney(doc.perUnitRub)}
        </span>
      ),
    },
    {
      key: 'closedAt',
      header: 'Сдан',
      render: (doc) => (
        <span style={{ fontSize: '0.85rem' }}>{formatDateMsk(doc.closedAt)}</span>
      ),
    },
    {
      key: 'lastFact',
      header: 'Последний факт',
      render: (doc) => <LastFactCell doc={doc} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (doc) => (
        <Link href={`${BASE_PATH}/${doc.id}`} className="admin-table__action-link">
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  return (
    <AdminPageShell
      icon={<PackageCheck size={22} strokeWidth={1.6} aria-hidden />}
      title="Документы выпуска"
      subtitle="Собираются сами из фактов производства — заводить и проводить не нужно"
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        {/*
          Срез по статусу. «Все» — вкладка по умолчанию (адрес без параметров), чтобы старые
          ссылки и закладки открывали полный реестр. Счётчик у «Формируются» — это
          `formingCount` из ответа: он считается по ВСЕЙ базе, без учёта поиска, и работает
          как напоминание «столько заказов ещё досдаёт факты», а не как счётчик выдачи.
        */}
        <div className="admin-tabs" role="tablist">
          {TABS.map((t) => {
            const isActive = t.key === activeTab;
            return (
              <Link
                key={t.key}
                href={buildHref({
                  status: t.key === 'ALL' ? undefined : t.key,
                  search,
                  pageSize: preserveParams.pageSize,
                })}
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                className={`admin-tab ${isActive ? 'admin-tab--active' : ''}`}
              >
                {t.label}
                {t.key === 'FORMING' && formingCount > 0 && (
                  <AdminStatusBadge tone="warning">{formingCount}</AdminStatusBadge>
                )}
              </Link>
            );
          })}
        </div>

        <form method="get" className="admin-form-grid" role="search">
          {/* Submit формы (Enter) не должен уводить с выбранной вкладки. */}
          {status && <input type="hidden" name="status" value={status} />}
          <AdminSearchInput
            id="production-documents-search"
            placeholder="Номер документа, номер заказа или клиент"
            initial={search ?? ''}
            basePath={BASE_PATH}
            preserveParams={{
              status,
              pageSize: preserveParams.pageSize,
            }}
          />
        </form>

        <AdminSectionHeader
          title={
            activeTab === 'FORMING'
              ? 'Формируются'
              : activeTab === 'READY'
                ? 'Сформированные'
                : 'Все документы'
          }
          hint={`Всего: ${total.toLocaleString('ru-RU')}`}
        />

        <AdminTable
          rows={items}
          columns={columns}
          rowKey={(doc) => doc.id}
          rowHref={(doc) => `${BASE_PATH}/${doc.id}`}
          emptyContent={
            <EmptyState tab={activeTab} search={search} hasError={Boolean(error)} />
          }
        />

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath={BASE_PATH}
          preserveParams={{ status, search }}
          pageSizeOptions={PAGE_SIZES}
          label="документов"
        />
      </AdminCard>
    </AdminPageShell>
  );
}

/**
 * Номер документа. Рядом — метка «пересобран» (`recalculatedAt != null`): факт пришёл уже
 * после фиксации, и сумма могла измениться. Это не ошибка и не действие человека, поэтому
 * тон спокойный, `info`, а подробности («почему») — в карточке, в `recalcReason`.
 */
function NumberCell({ doc }: { doc: ProductionDocumentListItemDto }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.4rem',
        flexWrap: 'wrap',
      }}
    >
      <FileText size={15} strokeWidth={1.6} aria-hidden />
      <span className="admin-table__primary">{doc.number}</span>
      {doc.recalculatedAt && (
        <span
          title={`Документ пересобран ${formatDateTimeMsk(
            doc.recalculatedAt,
          )}: факт пришёл после фиксации`}
        >
          <AdminStatusBadge tone="info">пересобран</AdminStatusBadge>
        </span>
      )}
    </span>
  );
}

/**
 * «Последний факт» — не статус, а то, чем документ закрылся.
 * У `READY` показываем дату последнего факта и его вид («закрыта коробка», …);
 * у `FORMING` факты ещё идут, поэтому вместо даты — чип состояния (причины ожидания
 * лежат в `pendingReasons` и раскрываются в карточке документа).
 */
function LastFactCell({ doc }: { doc: ProductionDocumentListItemDto }) {
  if (doc.status === 'FORMING') {
    return (
      <AdminStatusBadge tone="warning">
        {PRODUCTION_DOCUMENT_STATUS_LABELS.FORMING}
      </AdminStatusBadge>
    );
  }
  // `lastFactAt` теоретически пуст у старых документов — тогда показываем момент фиксации.
  const at = doc.lastFactAt ?? doc.readyAt;
  const kind = doc.lastFactKind
    ? PRODUCTION_DOCUMENT_FACT_KIND_LABELS[doc.lastFactKind]
    : null;
  if (!at && !kind) return <span className="admin-muted">—</span>;
  return (
    <span style={{ display: 'grid', gap: 2 }}>
      <span style={{ fontSize: '0.85rem' }}>{formatDateTimeMsk(at)}</span>
      {kind && (
        <span className="admin-muted" style={{ fontSize: '0.8rem' }}>
          {kind}
        </span>
      )}
    </span>
  );
}

/**
 * Пустой список. Текст обязан объяснить ГЛАВНОЕ: документ появляется сам при закрытии
 * заказа — искать кнопку «создать» бесполезно, её нет и не будет.
 */
function EmptyState({
  tab,
  search,
  hasError,
}: {
  tab: 'FORMING' | 'READY' | 'ALL';
  search: string | undefined;
  hasError: boolean;
}) {
  const icon = <PackageCheck size={26} strokeWidth={1.6} aria-hidden />;
  if (hasError) {
    return (
      <AdminEmptyState
        icon={icon}
        title="Список недоступен"
        hint="Документы выпуска не загрузились — причина в сообщении выше. Обновите страницу."
      />
    );
  }
  if (search) {
    return (
      <AdminEmptyState
        icon={icon}
        title="Данные не найдены"
        hint="По запросу нет документов выпуска. Ищем по номеру документа, номеру заказа и клиенту."
      />
    );
  }
  if (tab === 'FORMING') {
    return (
      <AdminEmptyState
        icon={icon}
        title="Формирующихся документов нет"
        hint="Все закрытые заказы досчитаны: коробки закрыты, начисления подтверждены."
      />
    );
  }
  if (tab === 'READY') {
    return (
      <AdminEmptyState
        icon={icon}
        title="Сформированных документов нет"
        hint="Документ становится сформированным сам, когда ляжет последний факт по заказу."
      />
    );
  }
  return (
    <AdminEmptyState
      icon={icon}
      title="Документов выпуска пока нет"
      hint="Документ выпуска появляется сам, когда заказ закрывается: паспорта собираются в один свод, себестоимость пишется снимком. Заводить его руками не нужно."
    />
  );
}
