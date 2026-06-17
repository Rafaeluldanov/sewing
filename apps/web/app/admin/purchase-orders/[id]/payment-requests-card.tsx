/**
 * Карточка «Заявки на оплату» внутри заказа поставщику.
 *
 * Сервер-компонент: тянет список заявок по PO и реквизиты поставщика
 * (для предзаполнения формы), рендерит кнопку «Создать заявку на оплату»
 * (клиентская модалка) + таблицу уже созданных заявок.
 *
 * Казначейство пока не подключено — заявки только создаются и видны
 * здесь (следующий шаг: этап заявки → `SupplierPayment`).
 */
import { Wallet } from 'lucide-react';
import {
  SUPPLIER_PAYMENT_REQUEST_STATUS_LABELS,
  type SupplierPaymentRequestStatus,
} from '@sewing/shared/supplier-payment-requests';
import { AdminCard, AdminSectionHeader, AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { getSupplier } from '@/lib/suppliers-api';
import { listPurchaseOrderPaymentRequests } from '@/lib/supplier-payment-requests-api';
import {
  CreatePaymentRequestDialog,
  type PaymentRequestRequisitesPrefill,
} from './create-payment-request-dialog';
import { PaymentRequestRowActions } from './payment-request-row-actions';

const EMPTY_REQUISITES: PaymentRequestRequisitesPrefill = {
  legalName: null,
  inn: null,
  kpp: null,
  bankName: null,
  bankAccount: null,
  bankBik: null,
  bankCorrAccount: null,
};

function statusTone(status: string): AdminStatusTone {
  switch (status as SupplierPaymentRequestStatus) {
    case 'DRAFT':
      return 'info';
    case 'SUBMITTED':
      return 'warning';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatStatus(status: string): string {
  return (
    SUPPLIER_PAYMENT_REQUEST_STATUS_LABELS[
      status as SupplierPaymentRequestStatus
    ] ?? status
  );
}

function formatMoney(amount: string, currency: string | null): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  const v = n.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const cur = !currency || currency.toUpperCase() === 'RUB' ? '₽' : currency;
  return `${v} ${cur}`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export async function PaymentRequestsCard({
  purchaseOrderId,
  supplierId,
  supplierName,
  totalAmount,
  currency,
}: {
  purchaseOrderId: string;
  supplierId: string;
  supplierName: string;
  totalAmount: string | null;
  currency: string | null;
}) {
  const [requests, supplier] = await Promise.all([
    listPurchaseOrderPaymentRequests(purchaseOrderId).catch(() => []),
    getSupplier(supplierId).catch(() => null),
  ]);

  const requisites: PaymentRequestRequisitesPrefill = supplier
    ? {
        legalName: supplier.legalName,
        inn: supplier.inn,
        kpp: supplier.kpp,
        bankName: supplier.bankName,
        bankAccount: supplier.bankAccount,
        bankBik: supplier.bankBik,
        bankCorrAccount: supplier.bankCorrAccount,
      }
    : EMPTY_REQUISITES;

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<Wallet size={18} strokeWidth={1.6} aria-hidden />}
        title="Заявки на оплату"
        hint={requests.length > 0 ? `${requests.length}` : undefined}
        actions={
          <CreatePaymentRequestDialog
            purchaseOrderId={purchaseOrderId}
            supplierName={supplierName}
            defaultAmount={totalAmount}
            defaultCurrency={currency}
            requisites={requisites}
          />
        }
      />

      {requests.length === 0 ? (
        <p className="admin-muted" style={{ margin: '8px 0 0' }}>
          Заявок на оплату пока нет. Нажмите «Создать заявку на оплату», чтобы
          оформить оплату поставщику с разбивкой по этапам.
        </p>
      ) : (
        <div className="admin-table-wrap" style={{ marginTop: 8 }}>
          <table className="admin-table">
            <thead>
              <tr>
                <th>Номер</th>
                <th>Статус</th>
                <th style={{ textAlign: 'right' }}>Сумма</th>
                <th style={{ textAlign: 'center' }}>Этапов</th>
                <th style={{ textAlign: 'center' }}>Файлов</th>
                <th>Создана</th>
                <th style={{ textAlign: 'right' }}>Действия</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.number}</strong>
                  </td>
                  <td>
                    <AdminStatusBadge tone={statusTone(r.status)}>
                      {formatStatus(r.status)}
                    </AdminStatusBadge>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {formatMoney(r.amount, r.currency)}
                  </td>
                  <td style={{ textAlign: 'center' }}>{r.stagesCount}</td>
                  <td style={{ textAlign: 'center' }}>{r.filesCount}</td>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <PaymentRequestRowActions
                      purchaseOrderId={purchaseOrderId}
                      requestId={r.id}
                      requestNumber={r.number}
                      supplierName={supplierName}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminCard>
  );
}
