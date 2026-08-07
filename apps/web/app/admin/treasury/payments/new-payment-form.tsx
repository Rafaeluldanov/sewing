'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import type {
  CashAccountDto,
  CashFlowItemDto,
} from '@sewing/shared/treasury';
import { createSupplierPaymentAction } from '../actions';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from '../form-state';

export interface SupplierOption {
  id: string;
  name: string;
}
export interface PurchaseOrderOption {
  id: string;
  number: string;
  supplierName: string;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <Plus size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Создаём…' : 'Создать заявку'}
    </button>
  );
}

/**
 * Форма создания заявки на оплату поставщику (`DRAFT`). Деньги не
 * двигаются — проводка появится только при «Оплатить».
 */
export function NewPaymentForm({
  suppliers,
  accounts,
  items,
  purchaseOrders,
}: {
  suppliers: SupplierOption[];
  accounts: CashAccountDto[];
  items: CashFlowItemDto[];
  purchaseOrders: PurchaseOrderOption[];
}) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    createSupplierPaymentAction,
    initialTreasuryFormState,
  );

  const noRefs =
    suppliers.length === 0 || accounts.length === 0 || items.length === 0;

  return (
    <form action={formAction} className="admin-form">
      {noRefs && (
        <div className="error-box" role="alert">
          Нужны хотя бы один поставщик, счёт и статья ДДС.
        </div>
      )}
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="pay-supplier">Поставщик</label>
          <CreatableSelect
            entity="supplier"
            id="pay-supplier"
            name="supplierId"
            required
            defaultValue=""
            existingValues={suppliers.map((s) => s.id)}
          >
            <option value="" disabled>
              Выберите поставщика
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </CreatableSelect>
        </div>
        <div className="admin-field">
          <label htmlFor="pay-po">Заказ поставщику</label>
          <select id="pay-po" name="purchaseOrderId" defaultValue="">
            <option value="">— без заказа —</option>
            {purchaseOrders.map((po) => (
              <option key={po.id} value={po.id}>
                {po.number} · {po.supplierName}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-field">
          <label htmlFor="pay-amount">Сумма, ₽</label>
          <input
            id="pay-amount"
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
          <label htmlFor="pay-account">Счёт списания</label>
          <CreatableSelect
            entity="cashAccount"
            id="pay-account"
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
          <label htmlFor="pay-item">Статья ДДС</label>
          <CreatableSelect
            entity="cashFlowItem"
            id="pay-item"
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
          <label htmlFor="pay-comment">Комментарий</label>
          <input
            id="pay-comment"
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
        <SubmitButton />
      </div>
    </form>
  );
}
