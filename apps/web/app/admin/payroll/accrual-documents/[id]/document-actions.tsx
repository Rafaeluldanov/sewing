'use client';

/**
 * Клиентский компонент действий над документом начисления (PHASE 3 STEP 6.3–6.4).
 *
 * Принимает связанные (`bound`) server actions от родительского RSC.
 * Кнопки: «Пересчитать», «Выплатить», «Отменить».
 *
 * STEP 6.4: корректировки поддержаны — кнопка «Выплатить» не блокируется
 * из-за manualAdjustRub, а при выплате корректировки попадают
 * в PayrollPayoutLine отдельной строкой kind=ADJUSTMENT.
 */

import { useFormState, useFormStatus } from 'react-dom';
import type { PayrollAccrualDocumentStatus } from '@sewing/shared/payroll-accrual-documents';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import type { AccrualDocumentActionState } from '../actions';

type BoundAction = (
  prev: AccrualDocumentActionState,
  form: FormData,
) => Promise<AccrualDocumentActionState>;

const initial: AccrualDocumentActionState = {};

function formatError(state: AccrualDocumentActionState): string | null {
  if (!state.error) return null;
  return state.error;
}

export function DocumentActions({
  status,
  payBlockedReason,
  hasAdjustments,
  recomputeAction,
  payAction,
  cancelAction,
}: {
  status: PayrollAccrualDocumentStatus;
  payBlockedReason: string | null;
  hasAdjustments?: boolean;
  recomputeAction: BoundAction;
  payAction: BoundAction;
  cancelAction: BoundAction;
}) {
  const [recomputeState, recomputeFormAction] = useFormState(
    recomputeAction,
    initial,
  );
  const [payState, payFormAction] = useFormState(payAction, initial);
  const [cancelState, cancelFormAction] = useFormState(cancelAction, initial);

  const recomputeError = formatError(recomputeState);
  const payError = formatError(payState);
  const cancelError = formatError(cancelState);
  const anyError = recomputeError ?? payError ?? cancelError;

  if (status === 'PAID') {
    return (
      <AdminCard>
        <p className="admin-muted">Документ выплачен. Действия недоступны.</p>
      </AdminCard>
    );
  }

  if (status === 'CANCELLED') {
    return (
      <AdminCard>
        <p className="admin-muted">Документ отменён.</p>
      </AdminCard>
    );
  }

  return (
    <AdminCard>
      <AdminSectionHeader title="Действия" />

      {anyError && (
        <div
          className="error-box"
          role="alert"
          style={{ marginBottom: '0.75rem' }}
        >
          {anyError}
        </div>
      )}

      {payBlockedReason && (
        <div
          className="admin-warning-box"
          role="note"
          style={{ marginBottom: '0.75rem' }}
        >
          ⚠️ {payBlockedReason}
        </div>
      )}

      {hasAdjustments && !payBlockedReason && (
        <div
          className="admin-info-box"
          role="note"
          style={{ marginBottom: '0.75rem' }}
        >
          ℹ️ Корректировки будут перенесены в выплату отдельной строкой.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <form action={recomputeFormAction}>
          <RecomputeButton />
        </form>

        <form action={payFormAction}>
          <PayButton disabled={!!payBlockedReason} />
        </form>

        <CancelForm cancelFormAction={cancelFormAction} />
      </div>
    </AdminCard>
  );
}

function RecomputeButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      {pending ? 'Пересчёт...' : 'Пересчитать'}
    </button>
  );
}

function PayButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
    >
      {pending ? 'Выплата...' : 'Выплатить'}
    </button>
  );
}

function CancelForm({
  cancelFormAction,
}: {
  cancelFormAction: (formData: FormData) => void;
}) {
  const { pending } = useFormStatus();
  return (
    <form
      action={cancelFormAction}
      style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}
    >
      <input
        type="text"
        name="reason"
        placeholder="Причина отмены (необязательно)"
        style={{ minWidth: '220px' }}
      />
      <button
        type="submit"
        className="admin-btn admin-btn--danger"
        disabled={pending}
      >
        {pending ? 'Отмена...' : 'Отменить'}
      </button>
    </form>
  );
}
