'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Save, XCircle } from 'lucide-react';
import type {
  CashAccountDto,
  CashFlowItemDto,
  TreasurySettingsDto,
} from '@sewing/shared/treasury';
import { updateTreasurySettingsAction } from '../actions';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from '../form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

/**
 * Настройки казначейства: «зарплатный» счёт + статья ДДС. Если оба
 * заданы — выдача выплаты пишет расходную проводку журнала ДС. Пусто —
 * выплаты работают как раньше.
 */
export function SettingsForm({
  settings,
  accounts,
  items,
}: {
  settings: TreasurySettingsDto;
  accounts: CashAccountDto[];
  items: CashFlowItemDto[];
}) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    updateTreasurySettingsAction,
    initialTreasuryFormState,
  );

  return (
    <form action={formAction} className="admin-form">
      <p className="admin-muted" style={{ marginTop: 0 }}>
        Если задать счёт и статью — при выдаче зарплаты автоматически
        появится расходная проводка в журнале ДС. Оставьте пустым, чтобы
        проводки по зарплате не создавались.
      </p>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="set-account">Зарплатный счёт</label>
          <select
            id="set-account"
            name="salaryAccountId"
            defaultValue={settings.salaryAccountId ?? ''}
          >
            <option value="">— не задано —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="set-item">Статья ДДС для зарплаты</label>
          <select
            id="set-item"
            name="salaryItemId"
            defaultValue={settings.salaryItemId ?? ''}
          >
            <option value="">— не задано —</option>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </select>
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
        <SubmitButton />
      </div>
    </form>
  );
}
