'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Save, XCircle } from 'lucide-react';
import type {
  CashAccountDto,
  CashFlowItemDto,
  TreasurySettingsDto,
} from '@sewing/shared/treasury';
import { updateTreasurySettingsAction } from '../actions';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
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
          <CreatableSelect
            entity="cashAccount"
            id="set-account"
            name="salaryAccountId"
            defaultValue={settings.salaryAccountId ?? ''}
            existingValues={accounts.map((a) => a.id)}
          >
            <option value="">— не задано —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor="set-item">Статья ДДС для зарплаты</label>
          <CreatableSelect
            entity="cashFlowItem"
            id="set-item"
            name="salaryItemId"
            defaultValue={settings.salaryItemId ?? ''}
            existingValues={items.map((it) => it.id)}
          >
            <option value="">— не задано —</option>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
      </div>

      <p className="admin-muted" style={{ marginBottom: 0 }}>
        Если задать «счёт для оплат поставщикам» — при создании заявки на
        оплату внутри заказа поставщику по каждому этапу автоматически
        появится черновик «заявки на расход» в казначействе на этом счёте.
        Статья ДДС берётся из заявки, а это поле — запасной вариант.
        Оставьте счёт пустым, чтобы заявки на расход не создавались.
      </p>
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="set-supplier-account">Счёт для оплат поставщикам</label>
          <CreatableSelect
            entity="cashAccount"
            id="set-supplier-account"
            name="supplierAccountId"
            defaultValue={settings.supplierAccountId ?? ''}
            existingValues={accounts.map((a) => a.id)}
          >
            <option value="">— не задано —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor="set-supplier-item">
            Статья ДДС для оплат поставщикам (по умолчанию)
          </label>
          <CreatableSelect
            entity="cashFlowItem"
            id="set-supplier-item"
            name="supplierItemId"
            defaultValue={settings.supplierItemId ?? ''}
            existingValues={items.map((it) => it.id)}
          >
            <option value="">— не задано —</option>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </CreatableSelect>
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
