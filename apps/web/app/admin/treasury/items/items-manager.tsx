'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import {
  CASH_FLOW_DIRECTION_LABELS,
  type CashFlowItemDto,
} from '@sewing/shared/treasury';
import {
  createCashFlowItemAction,
  toggleCashFlowItemActiveAction,
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
      {pending ? 'Создаём…' : 'Создать статью'}
    </button>
  );
}

function ToggleButton({ item }: { item: CashFlowItemDto }) {
  const action = toggleCashFlowItemActiveAction.bind(
    null,
    item.id,
    !item.isActive,
  );
  const [, formAction] = useFormState<TreasuryFormState, FormData>(
    action,
    initialTreasuryFormState,
  );
  return (
    <form action={formAction}>
      <button type="submit" className="admin-table__action-link">
        {item.isActive ? 'Скрыть' : 'Активировать'}
      </button>
    </form>
  );
}

function directionLabel(d: CashFlowItemDto['direction']): string {
  if (d === 'IN') return CASH_FLOW_DIRECTION_LABELS.IN;
  if (d === 'OUT') return CASH_FLOW_DIRECTION_LABELS.OUT;
  return 'Любое';
}

export function ItemsManager({ items }: { items: CashFlowItemDto[] }) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    createCashFlowItemAction,
    initialTreasuryFormState,
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <form action={formAction} className="admin-form">
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="item-name">Название</label>
            <input
              id="item-name"
              name="name"
              type="text"
              required
              maxLength={160}
              placeholder="Например: Оплата поставщику"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="item-direction">Направление (намёк)</label>
            <select id="item-direction" name="direction" defaultValue="">
              <option value="">Любое</option>
              <option value="IN">{CASH_FLOW_DIRECTION_LABELS.IN}</option>
              <option value="OUT">{CASH_FLOW_DIRECTION_LABELS.OUT}</option>
            </select>
          </div>
          <div className="admin-field">
            <label htmlFor="item-code">Код</label>
            <input id="item-code" name="code" type="text" maxLength={40} />
          </div>
        </div>
        <div className="admin-field">
          <label htmlFor="item-comment">Комментарий</label>
          <input
            id="item-comment"
            name="comment"
            type="text"
            maxLength={500}
          />
        </div>
        <label
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          <input type="checkbox" name="isOverhead" />
          Накладные расходы (распределяются на заказы в себестоимости)
        </label>

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
              <th>Направление</th>
              <th>Код</th>
              <th>Накладные</th>
              <th>Статус</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="admin-muted">
                  Статей пока нет.
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id}>
                  <td className="admin-table__primary">{it.name}</td>
                  <td>{directionLabel(it.direction)}</td>
                  <td>
                    {it.code ?? <span className="admin-muted">—</span>}
                  </td>
                  <td>
                    {it.isOverhead ? (
                      'Да'
                    ) : (
                      <span className="admin-muted">—</span>
                    )}
                  </td>
                  <td>
                    {it.isActive ? (
                      <span style={{ color: 'var(--admin-success, #15803d)' }}>
                        Активна
                      </span>
                    ) : (
                      <span className="admin-muted">Скрыта</span>
                    )}
                  </td>
                  <td className="admin-table__actions">
                    <ToggleButton item={it} />
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
