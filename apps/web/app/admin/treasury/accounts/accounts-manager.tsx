'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import {
  CASH_ACCOUNT_KIND_LABELS,
  type CashAccountDto,
} from '@sewing/shared/treasury';
import {
  createCashAccountAction,
  toggleCashAccountActiveAction,
} from '../actions';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from '../form-state';

function CreateSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать счёт'}
    </button>
  );
}

function ToggleButton({ account }: { account: CashAccountDto }) {
  const action = toggleCashAccountActiveAction.bind(
    null,
    account.id,
    !account.isActive,
  );
  const [, formAction] = useFormState<TreasuryFormState, FormData>(
    action,
    initialTreasuryFormState,
  );
  return (
    <form action={formAction}>
      <button type="submit" className="admin-table__action-link">
        {account.isActive ? 'Скрыть' : 'Активировать'}
      </button>
    </form>
  );
}

export function AccountsManager({ accounts }: { accounts: CashAccountDto[] }) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    createCashAccountAction,
    initialTreasuryFormState,
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <form action={formAction} className="admin-form">
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="acc-kind">Тип</label>
            <select id="acc-kind" name="kind" required defaultValue="CASH">
              <option value="CASH">{CASH_ACCOUNT_KIND_LABELS.CASH}</option>
              <option value="BANK">{CASH_ACCOUNT_KIND_LABELS.BANK}</option>
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="acc-name">Название</label>
            <input
              id="acc-name"
              name="name"
              type="text"
              required
              maxLength={120}
              placeholder="Например: Касса цеха"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="acc-comment">Комментарий</label>
            <input
              id="acc-comment"
              name="comment"
              type="text"
              maxLength={500}
            />
          </div>
        </div>

        {state.error && (
          <div className="error-box" role="alert">
            <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
        )}
        {state.ok && state.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle2 size={16} strokeWidth={1.6} aria-hidden />{' '}
            {state.successMessage}
          </div>
        )}

        <div className="admin-actions-row">
          <CreateSubmit />
        </div>
      </form>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Тип</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr>
                <td colSpan={4} className="admin-muted">
                  Счетов пока нет.
                </td>
              </tr>
            ) : (
              accounts.map((a) => (
                <tr key={a.id}>
                  <td className="admin-table__primary">{a.name}</td>
                  <td>{CASH_ACCOUNT_KIND_LABELS[a.kind]}</td>
                  <td>
                    {a.isActive ? (
                      <span style={{ color: 'var(--admin-success, #15803d)' }}>
                        Активен
                      </span>
                    ) : (
                      <span className="admin-muted">Скрыт</span>
                    )}
                  </td>
                  <td className="admin-table__actions">
                    <ToggleButton account={a} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
