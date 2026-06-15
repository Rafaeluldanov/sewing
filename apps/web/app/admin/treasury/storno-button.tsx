'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Undo2 } from 'lucide-react';
import { stornoCashFlowEntryAction } from './actions';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from './form-state';

function StornoSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-table__action-link"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm('Сторнировать проводку? Действие необратимо.')) {
          e.preventDefault();
        }
      }}
      title="Сторнировать (обратная проводка)"
    >
      <Undo2 size={14} strokeWidth={1.6} aria-hidden />
      {pending ? '…' : 'Сторно'}
    </button>
  );
}

/**
 * Кнопка сторно одной проводки журнала (INV-7). Backend создаёт
 * обратную строку; повторное сторно ловится unique-индексом (INV-4).
 */
export function StornoButton({ entryId }: { entryId: string }) {
  const action = stornoCashFlowEntryAction.bind(null, entryId);
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    action,
    initialTreasuryFormState,
  );
  return (
    <form action={formAction}>
      <StornoSubmit />
      {state.error && (
        <span className="admin-muted" style={{ fontSize: 12 }}>
          {state.error}
        </span>
      )}
    </form>
  );
}
