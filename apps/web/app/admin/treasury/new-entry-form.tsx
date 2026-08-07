'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import {
  CASH_FLOW_DIRECTION_LABELS,
  CASH_FLOW_SOURCE_LABELS,
  MANUAL_CASH_FLOW_SOURCES,
  type CashAccountDto,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import { createCashFlowEntryAction } from './actions';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from './form-state';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Проводим…' : 'Провести'}
    </button>
  );
}

/**
 * Форма ручной проводки журнала ДДС (`registrarType = 'MANUAL'`).
 *
 * Момент проводки сознательно не вводится в Фазе 0 — backend ставит
 * `now()`. Источник ограничен «безобъектными» статьями
 * (`MANUAL_CASH_FLOW_SOURCES`): поступление от клиента, корректировка /
 * ввод остатков, прочее. Оплата поставщику / зарплата проводятся
 * документами Фазы 1, не руками.
 */
export function NewEntryForm({
  accounts,
  items,
}: {
  accounts: CashAccountDto[];
  items: CashFlowItemDto[];
}) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    createCashFlowEntryAction,
    initialTreasuryFormState,
  );

  const noRefs = accounts.length === 0 || items.length === 0;

  return (
    <form action={formAction} className="admin-form">
      {noRefs && (
        <div className="error-box" role="alert">
          Сначала заведите хотя бы один счёт и одну статью ДДС.
        </div>
      )}
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="entry-account">Счёт</label>
          <CreatableSelect
            entity="cashAccount"
            id="entry-account"
            name="accountId"
            required
            defaultValue=""
            existingValues={accounts.map((a) => a.id)}
          >
            <option value="" disabled>
              Выберите счёт
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor="entry-direction">Направление</label>
          <select id="entry-direction" name="direction" required defaultValue="OUT">
            <option value="IN">{CASH_FLOW_DIRECTION_LABELS.IN}</option>
            <option value="OUT">{CASH_FLOW_DIRECTION_LABELS.OUT}</option>
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="entry-amount">Сумма, ₽</label>
          <input
            id="entry-amount"
            name="amount"
            type="text"
            inputMode="decimal"
            required
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="entry-item">Статья ДДС</label>
          <CreatableSelect
            entity="cashFlowItem"
            id="entry-item"
            name="itemId"
            required
            defaultValue=""
            existingValues={items.map((it) => it.id)}
          >
            <option value="" disabled>
              Выберите статью
            </option>
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor="entry-source">Основание</label>
          <select id="entry-source" name="source" defaultValue="OTHER">
            {MANUAL_CASH_FLOW_SOURCES.map((s) => (
              <option key={s} value={s}>
                {CASH_FLOW_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="entry-source-id">Ссылка на основание</label>
          <input
            id="entry-source-id"
            name="sourceId"
            type="text"
            maxLength={60}
            placeholder="напр. номер заказа (опц.)"
          />
        </div>
      </div>

      <div className="admin-field">
        <label htmlFor="entry-note">Примечание</label>
        <input
          id="entry-note"
          name="note"
          type="text"
          maxLength={500}
          placeholder="Произвольный комментарий"
        />
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
