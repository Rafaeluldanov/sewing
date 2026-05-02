'use client';

/**
 * Клиентский компонент действий над выплатой (PHASE 3 STEP 4).
 *
 * Принимает связанные (`bound`) server actions от родительского RSC
 * и отрисовывает нужный набор кнопок в зависимости от статуса.
 *
 * ВАЖНО: кнопка ACK («получено», «я получил») здесь намеренно
 * отсутствует — это действие сотрудника (PHASE 3 STEP 5).
 */

import { useFormState, useFormStatus } from 'react-dom';
import type { PayrollPayoutStatus } from '@sewing/shared/payroll-payouts';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import type { PayrollPayoutActionState } from '../form-state';

type BoundAction = (
  prev: PayrollPayoutActionState,
  form: FormData,
) => Promise<PayrollPayoutActionState>;

const initial: PayrollPayoutActionState = {};

export function PayoutActions({
  status,
  recomputeAction,
  issueAction,
  cancelAction,
}: {
  status: PayrollPayoutStatus;
  recomputeAction: BoundAction;
  issueAction: BoundAction;
  cancelAction: BoundAction;
}) {
  const [recomputeState, recomputeFormAction] = useFormState(
    recomputeAction,
    initial,
  );
  const [issueState, issueFormAction] = useFormState(issueAction, initial);
  const [cancelState, cancelFormAction] = useFormState(cancelAction, initial);

  const anyError =
    recomputeState.error ?? issueState.error ?? cancelState.error;

  if (status === 'ACKNOWLEDGED') {
    return (
      <AdminCard>
        <p className="admin-muted">
          Сотрудник подтвердил получение. Выплата завершена.
        </p>
      </AdminCard>
    );
  }

  if (status === 'CANCELLED') {
    return (
      <AdminCard>
        <p className="admin-muted">Выплата отменена.</p>
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

      {status === 'ISSUED' && (
        <p className="admin-muted" style={{ marginBottom: '0.75rem' }}>
          Ожидает подтверждения сотрудником.
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        {status === 'DRAFT' && (
          <>
            <form action={recomputeFormAction}>
              <RecomputeButton />
            </form>
            <form action={issueFormAction}>
              <IssueButton />
            </form>
          </>
        )}

        {(status === 'DRAFT' || status === 'ISSUED') && (
          <CancelForm cancelFormAction={cancelFormAction} />
        )}
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

function IssueButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      {pending ? 'Передача...' : 'Передать сотруднику'}
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
    <form action={cancelFormAction} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
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
