'use client';

/**
 * Клиентская кнопка подтверждения получения выплаты (PHASE 3 STEP 5).
 *
 * Показывается только для статуса ISSUED. После отправки формы
 * server action делает revalidate, страница перерисовывается
 * с новым статусом ACKNOWLEDGED.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { BadgeCheck } from 'lucide-react';
import type { AckPayoutState } from '../actions';

type BoundAction = (
  prev: AckPayoutState,
  form: FormData,
) => Promise<AckPayoutState>;

const initial: AckPayoutState = {};

export function AckButton({ ackAction }: { ackAction: BoundAction }) {
  const [state, formAction] = useFormState(ackAction, initial);

  return (
    <div>
      {state.error && (
        <div
          className="error-box"
          role="alert"
          style={{ marginBottom: '0.75rem' }}
        >
          {state.error}
        </div>
      )}
      {state.ok && (
        <div
          role="status"
          style={{
            background: '#e4f4e6',
            border: '1px solid #a9d9b5',
            borderRadius: '0.5rem',
            padding: '0.75rem 1rem',
            color: '#2f7d4e',
            marginBottom: '0.75rem',
            fontWeight: 500,
          }}
        >
          Получение подтверждено. Спасибо!
        </div>
      )}
      <form action={formAction}>
        <SubmitButton />
      </form>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        background: '#2e9e4a',
        color: '#fff',
        border: 'none',
        borderRadius: '0.5rem',
        padding: '0.625rem 1.25rem',
        fontSize: '1rem',
        fontWeight: 600,
        cursor: pending ? 'not-allowed' : 'pointer',
        opacity: pending ? 0.7 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      <BadgeCheck size={18} strokeWidth={1.6} aria-hidden />
      {pending ? 'Подтверждение...' : 'Деньги получил'}
    </button>
  );
}
