'use client';

/**
 * `PaymentRequestRowActions` — действия над строкой заявки на оплату в
 * таблице карточки заказа поставщику: «карандаш» (редактировать) и
 * «корзина» (удалить).
 *
 * Деталь заявки (этапы/реквизиты/вложения) тянем лениво по клику на
 * «карандаш» через server action — в списке её нет, а форма
 * редактирования (`PaymentRequestFormModal`) требует полный снимок.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import type { SupplierPaymentRequestDetailDto } from '@sewing/shared/supplier-payment-requests';
import type { CashFlowItemDto } from '@sewing/shared/treasury';
import { PaymentRequestFormModal } from './payment-request-form-modal';
import {
  deleteSupplierPaymentRequestAction,
  getSupplierPaymentRequestDetailAction,
} from './payment-request-actions';

interface Props {
  purchaseOrderId: string;
  requestId: string;
  requestNumber: string;
  supplierName: string;
  /** Активные статьи ДДС — для выпадающего списка в форме редактирования. */
  cashFlowItems: CashFlowItemDto[];
}

export function PaymentRequestRowActions({
  purchaseOrderId,
  requestId,
  requestNumber,
  supplierName,
  cashFlowItems,
}: Props) {
  const router = useRouter();
  const [detail, setDetail] = useState<SupplierPaymentRequestDetailDto | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = loadingEdit || deleting;

  const onEdit = useCallback(async () => {
    setError(null);
    setLoadingEdit(true);
    const res = await getSupplierPaymentRequestDetailAction(requestId);
    setLoadingEdit(false);
    if (!res.ok || !res.request) {
      setError(res.error ?? 'Не удалось загрузить заявку.');
      return;
    }
    setDetail(res.request);
    setEditing(true);
  }, [requestId]);

  const onDelete = useCallback(async () => {
    if (
      !window.confirm(
        `Удалить заявку на оплату ${requestNumber}? Этапы и вложения будут удалены безвозвратно.`,
      )
    ) {
      return;
    }
    setError(null);
    setDeleting(true);
    const res = await deleteSupplierPaymentRequestAction(
      purchaseOrderId,
      requestId,
    );
    setDeleting(false);
    if (!res.ok) {
      setError(res.error ?? 'Не удалось удалить заявку.');
      return;
    }
    router.refresh();
  }, [purchaseOrderId, requestId, requestNumber, router]);

  return (
    <div className="pr-actions">
      <button
        type="button"
        className="pr-actions__btn"
        onClick={onEdit}
        disabled={busy}
        aria-label="Редактировать заявку"
        title="Редактировать"
      >
        {loadingEdit ? (
          <Loader2 size={15} strokeWidth={1.7} className="pr-actions__spin" aria-hidden />
        ) : (
          <Pencil size={15} strokeWidth={1.6} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="pr-actions__btn pr-actions__btn--danger"
        onClick={onDelete}
        disabled={busy}
        aria-label="Удалить заявку"
        title="Удалить"
      >
        <Trash2 size={15} strokeWidth={1.6} aria-hidden />
      </button>

      {error && (
        <span className="pr-actions__error" role="alert">
          {error}
        </span>
      )}

      {editing && detail && (
        <PaymentRequestFormModal
          mode="edit"
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={() => router.refresh()}
          purchaseOrderId={purchaseOrderId}
          requestId={requestId}
          supplierName={supplierName}
          cashFlowItems={cashFlowItems}
          initialSupplierId={detail.supplierId}
          initialCashFlowItemId={detail.cashFlowItemId}
          initialCashFlowItemName={detail.cashFlowItemNameSnapshot}
          initialAmount={detail.amount}
          initialCurrency={detail.currency}
          initialComment={detail.comment}
          initialStatus={detail.status}
          initialRequisites={{
            legalName: detail.legalNameSnapshot,
            inn: detail.innSnapshot,
            kpp: detail.kppSnapshot,
            bankName: detail.bankNameSnapshot,
            bankAccount: detail.bankAccountSnapshot,
            bankBik: detail.bankBikSnapshot,
            bankCorrAccount: detail.bankCorrAccountSnapshot,
          }}
          initialStages={detail.stages.map((s) => ({
            percent: s.percent,
            plannedPayDate: s.plannedPayDate ? s.plannedPayDate.slice(0, 10) : '',
            comment: s.comment ?? '',
          }))}
          existingFiles={detail.files.map((f) => ({
            id: f.id,
            originalFileName: f.originalFileName,
            sizeBytes: f.sizeBytes,
            fileUrl: f.fileUrl,
          }))}
        />
      )}

      <style>{`
        .pr-actions {
          display: inline-flex; align-items: center; gap: 4px;
        }
        .pr-actions__btn {
          background: transparent; border: 1px solid transparent; cursor: pointer;
          padding: 4px; border-radius: 6px; color: #475569;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .pr-actions__btn:hover:not(:disabled) { background: #f1f5f9; }
        .pr-actions__btn--danger:hover:not(:disabled) {
          background: #fee2e2; color: #b91c1c;
        }
        .pr-actions__btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .pr-actions__spin { animation: pr-spin 0.8s linear infinite; }
        .pr-actions__error {
          color: #b91c1c; font-size: 0.78rem; margin-left: 4px;
        }
        @keyframes pr-spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
