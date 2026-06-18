/**
 * Казначейство — журнал движения ДС (`/admin/treasury`, Фаза 0).
 *
 * Единая «книга денег» цеха: остатки по счетам (Σ IN − Σ OUT по
 * журналу) + лента проводок с ручным вводом и сторно. Источник истины —
 * `fin`-журнал `CashFlowEntry` (append-only). Backend:
 * `GET /api/treasury/{balances,entries,accounts,items}`.
 *
 * Доступ — `ADMIN`/`SHOP_MANAGER` (на backend). Sidebar показывает пункт
 * при `NEXT_PUBLIC_FEATURE_TREASURY` (default-on).
 */
import Link from 'next/link';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  ListTree,
  Settings,
  Truck,
  Wallet,
} from 'lucide-react';
import {
  CASH_ACCOUNT_KIND_LABELS,
  CASH_FLOW_SOURCE_LABELS,
  type CashFlowEntryDto,
} from '@sewing/shared/treasury';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  getTreasuryBalances,
  listCashAccounts,
  listCashFlowEntries,
  listCashFlowItems,
} from '@/lib/treasury-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import { NewEntryForm } from './new-entry-form';
import { StornoButton } from './storno-button';

export const dynamic = 'force-dynamic';

function formatRub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default async function TreasuryPage() {
  let error: string | null = null;
  let balances: Awaited<ReturnType<typeof getTreasuryBalances>> = {
    accounts: [],
    totalBalanceRub: '0.00',
  };
  let entries: CashFlowEntryDto[] = [];
  let accounts: Awaited<ReturnType<typeof listCashAccounts>> = [];
  let items: Awaited<ReturnType<typeof listCashFlowItems>> = [];

  try {
    [balances, entries, accounts, items] = await Promise.all([
      getTreasuryBalances(),
      listCashFlowEntries({ limit: 100 }),
      listCashAccounts({ activeOnly: true }),
      listCashFlowItems({ activeOnly: true }),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить данные казначейства';
  }

  // Оригиналы, которые уже сторнированы — скрываем у них кнопку сторно.
  const reversed = new Set(
    entries.filter((e) => e.reversalOfId).map((e) => e.reversalOfId as string),
  );

  return (
    <AdminPageShell
      icon={<Wallet size={22} strokeWidth={1.6} aria-hidden />}
      title="Казначейство"
      subtitle={`Остаток по всем счетам: ${formatRub(balances.totalBalanceRub)} ₽`}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/treasury/payments" className="admin-btn">
            <Truck size={16} strokeWidth={1.6} aria-hidden />
            Заявки на расход
          </Link>
          <Link href="/admin/treasury/accounts" className="admin-btn">
            <Banknote size={16} strokeWidth={1.6} aria-hidden />
            Счета
          </Link>
          <Link href="/admin/treasury/items" className="admin-btn">
            <ListTree size={16} strokeWidth={1.6} aria-hidden />
            Статьи ДДС
          </Link>
          <Link href="/admin/treasury/settings" className="admin-btn">
            <Settings size={16} strokeWidth={1.6} aria-hidden />
            Настройки
          </Link>
        </div>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {/* Остатки по счетам */}
      <AdminCard>
        <AdminSectionHeader title="Остатки по счетам" hint={`${balances.accounts.length}`} />
        {balances.accounts.length === 0 ? (
          <AdminEmptyState
            icon={<Banknote size={26} strokeWidth={1.6} aria-hidden />}
            title="Счета не заведены"
            hint="Откройте «Счета», чтобы добавить кассу или расчётный счёт."
          />
        ) : (
          <div className="admin-table-wrap">
            <AdminTable
              rows={balances.accounts}
              rowKey={(a) => a.accountId}
              columns={[
                {
                  key: 'name',
                  header: 'Счёт',
                  render: (a) => (
                    <span className="admin-table__primary">{a.accountName}</span>
                  ),
                },
                {
                  key: 'kind',
                  header: 'Тип',
                  render: (a) => CASH_ACCOUNT_KIND_LABELS[a.kind],
                },
                {
                  key: 'inflow',
                  header: 'Поступления',
                  align: 'right',
                  render: (a) => `${formatRub(a.inflow)} ₽`,
                },
                {
                  key: 'outflow',
                  header: 'Расходы',
                  align: 'right',
                  render: (a) => `${formatRub(a.outflow)} ₽`,
                },
                {
                  key: 'balance',
                  header: 'Остаток',
                  align: 'right',
                  render: (a) => (
                    <strong>{formatRub(a.balance)} ₽</strong>
                  ),
                },
              ]}
            />
          </div>
        )}
      </AdminCard>

      {/* Новая проводка */}
      <AdminCard>
        <AdminSectionHeader
          title="Новая проводка"
          hint="ручной ввод движения ДС"
        />
        <NewEntryForm accounts={accounts} items={items} />
      </AdminCard>

      {/* Журнал */}
      <AdminCard>
        <AdminSectionHeader
          title="Журнал движения ДС"
          hint={`последние ${entries.length}`}
        />
        <JournalTable entries={entries} reversed={reversed} />
      </AdminCard>
    </AdminPageShell>
  );
}

function JournalTable({
  entries,
  reversed,
}: {
  entries: CashFlowEntryDto[];
  reversed: Set<string>;
}) {
  const columns: AdminTableColumn<CashFlowEntryDto>[] = [
    {
      key: 'postedAt',
      header: 'Дата',
      render: (e) => formatDateTime(e.postedAt),
    },
    {
      key: 'account',
      header: 'Счёт',
      render: (e) => (
        <span className="admin-table__primary">{e.accountName}</span>
      ),
    },
    {
      key: 'item',
      header: 'Статья',
      render: (e) => e.itemName,
    },
    {
      key: 'source',
      header: 'Основание',
      render: (e) => (
        <span className="admin-muted">
          {CASH_FLOW_SOURCE_LABELS[e.source]}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      render: (e) => {
        const sign = e.direction === 'IN' ? '+' : '−';
        const tone = e.direction === 'IN' ? 'success' : 'danger';
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontVariantNumeric: 'tabular-nums',
              color:
                tone === 'success'
                  ? 'var(--admin-success, #15803d)'
                  : 'var(--admin-danger, #b91c1c)',
            }}
          >
            {e.direction === 'IN' ? (
              <ArrowDownLeft size={13} strokeWidth={1.8} aria-hidden />
            ) : (
              <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
            )}
            {sign}
            {formatRub(e.amount)} ₽
          </span>
        );
      },
    },
    {
      key: 'status',
      header: '',
      render: (e) =>
        e.isStorno ? (
          <AdminStatusBadge tone="muted">сторно</AdminStatusBadge>
        ) : reversed.has(e.id) ? (
          <AdminStatusBadge tone="warning">сторнирована</AdminStatusBadge>
        ) : null,
    },
    {
      key: 'note',
      header: 'Примечание',
      render: (e) =>
        e.note ? e.note : <span className="admin-muted">—</span>,
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (e) =>
        !e.isStorno && !reversed.has(e.id) ? (
          <StornoButton entryId={e.id} />
        ) : null,
    },
  ];
  return (
    <AdminTable
      rows={entries}
      columns={columns}
      rowKey={(e) => e.id}
      emptyContent={
        <AdminEmptyState
          icon={<Wallet size={26} strokeWidth={1.6} aria-hidden />}
          title="Проводок пока нет"
          hint="Заполните форму «Новая проводка», чтобы зафиксировать движение денег."
        />
      }
    />
  );
}
