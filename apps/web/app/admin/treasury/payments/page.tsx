/**
 * Оплаты поставщикам (`/admin/treasury/payments`, Фаза 1).
 *
 * Документ «санкционировал → оплатил» поверх закупочного контура.
 * Жизненный цикл DRAFT → APPROVED → PAID; «Оплатить» атомарно пишет
 * проводку журнала ДС. Backend: `/api/treasury/supplier-payments/*`.
 */
import Link from 'next/link';
import { ArrowLeft, Truck } from 'lucide-react';
import {
  SUPPLIER_PAYMENT_STATUS_LABELS,
  type SupplierPaymentDto,
  type SupplierPaymentStatus,
} from '@sewing/shared/treasury';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  listCashAccounts,
  listCashFlowItems,
  listSupplierPayments,
} from '@/lib/treasury-api';
import { listSuppliers } from '@/lib/suppliers-api';
import { listPurchaseOrders } from '@/lib/purchase-orders-api';
import {
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  type AdminTableColumn,
} from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { NewPaymentForm } from './new-payment-form';
import { PaymentActions } from './payment-actions';

export const dynamic = 'force-dynamic';

function formatRub(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function statusTone(status: SupplierPaymentStatus): AdminStatusTone {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'APPROVED':
      return 'info';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

export default async function SupplierPaymentsPage() {
  let error: string | null = null;
  let payments: SupplierPaymentDto[] = [];
  let suppliers: { id: string; name: string }[] = [];
  let accounts: Awaited<ReturnType<typeof listCashAccounts>> = [];
  let items: Awaited<ReturnType<typeof listCashFlowItems>> = [];
  let purchaseOrders: { id: string; number: string; supplierName: string }[] =
    [];

  try {
    const [pays, sups, accs, its, pos] = await Promise.all([
      listSupplierPayments({ limit: 100 }),
      listSuppliers({ status: 'ACTIVE' }),
      listCashAccounts({ activeOnly: true }),
      listCashFlowItems({ activeOnly: true }),
      listPurchaseOrders({}),
    ]);
    payments = pays;
    suppliers = sups.map((s) => ({ id: s.id, name: s.name }));
    accounts = accs;
    items = its;
    purchaseOrders = pos
      .slice(0, 100)
      .map((po) => ({
        id: po.id,
        number: po.number,
        supplierName: po.supplierNameSnapshot,
      }));
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить заявки на расход';
  }

  return (
    <AdminPageShell
      icon={<Truck size={22} strokeWidth={1.6} aria-hidden />}
      title="Заявки на расход"
      subtitle="Заявка → согласование → оплата (проводка в журнал ДС)"
      actions={
        <Link href="/admin/treasury" className="admin-btn admin-btn--ghost">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К журналу
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminSectionHeader title="Новая заявка на расход" />
        <NewPaymentForm
          suppliers={suppliers}
          accounts={accounts}
          items={items}
          purchaseOrders={purchaseOrders}
        />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Заявки" hint={`${payments.length}`} />
        <PaymentsTable payments={payments} />
      </AdminCard>
    </AdminPageShell>
  );
}

function PaymentsTable({ payments }: { payments: SupplierPaymentDto[] }) {
  const columns: AdminTableColumn<SupplierPaymentDto>[] = [
    {
      key: 'createdAt',
      header: 'Дата',
      render: (p) => formatDate(p.createdAt),
    },
    {
      key: 'supplier',
      header: 'Поставщик',
      render: (p) => (
        <span className="admin-table__primary">{p.supplierName}</span>
      ),
    },
    {
      key: 'po',
      header: 'Заказ',
      render: (p) =>
        p.purchaseOrderNumber ?? <span className="admin-muted">—</span>,
    },
    {
      key: 'account',
      header: 'Счёт',
      render: (p) => p.accountName,
    },
    {
      key: 'amount',
      header: 'Сумма',
      align: 'right',
      render: (p) => <strong>{formatRub(p.amount)} ₽</strong>,
    },
    {
      key: 'status',
      header: 'Статус',
      render: (p) => (
        <AdminStatusBadge tone={statusTone(p.status)}>
          {SUPPLIER_PAYMENT_STATUS_LABELS[p.status]}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'actions',
      header: '',
      isAction: true,
      render: (p) => <PaymentActions payment={p} />,
    },
  ];
  return (
    <AdminTable
      rows={payments}
      columns={columns}
      rowKey={(p) => p.id}
      emptyContent={
        <AdminEmptyState
          icon={<Truck size={26} strokeWidth={1.6} aria-hidden />}
          title="Заявок пока нет"
          hint="Создайте заявку на расход в форме выше."
        />
      }
    />
  );
}
