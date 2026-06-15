'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { BadgeCheck, Ban, Wallet } from 'lucide-react';
import type { SupplierPaymentDto } from '@sewing/shared/treasury';
import {
  approveSupplierPaymentAction,
  paySupplierPaymentAction,
  cancelSupplierPaymentAction,
} from '../actions';
import {
  initialTreasuryFormState,
  type TreasuryFormState,
} from '../form-state';

function Btn({
  label,
  icon,
  confirm,
}: {
  label: string;
  icon: React.ReactNode;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-table__action-link"
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {icon}
      {pending ? '…' : label}
    </button>
  );
}

function BoundForm({
  action,
  children,
}: {
  action: (
    prev: TreasuryFormState,
    form: FormData,
  ) => Promise<TreasuryFormState>;
  children: React.ReactNode;
}) {
  const [state, formAction] = useFormState<TreasuryFormState, FormData>(
    action,
    initialTreasuryFormState,
  );
  return (
    <form action={formAction} style={{ display: 'inline' }}>
      {children}
      {state.error && (
        <span className="admin-muted" style={{ fontSize: 12, marginLeft: 6 }}>
          {state.error}
        </span>
      )}
    </form>
  );
}

/**
 * Кнопки перехода статуса заявки на оплату. Набор зависит от статуса:
 * DRAFT → согласовать/отменить; APPROVED → оплатить/отменить; PAID и
 * CANCELLED — без действий.
 */
export function PaymentActions({ payment }: { payment: SupplierPaymentDto }) {
  if (payment.status === 'DRAFT') {
    return (
      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
        <BoundForm action={approveSupplierPaymentAction.bind(null, payment.id)}>
          <Btn
            label="Согласовать"
            icon={<BadgeCheck size={14} strokeWidth={1.6} aria-hidden />}
          />
        </BoundForm>
        <BoundForm action={cancelSupplierPaymentAction.bind(null, payment.id)}>
          <Btn
            label="Отменить"
            icon={<Ban size={14} strokeWidth={1.6} aria-hidden />}
            confirm="Отменить заявку?"
          />
        </BoundForm>
      </span>
    );
  }
  if (payment.status === 'APPROVED') {
    return (
      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
        <BoundForm action={paySupplierPaymentAction.bind(null, payment.id)}>
          <Btn
            label="Оплатить"
            icon={<Wallet size={14} strokeWidth={1.6} aria-hidden />}
            confirm="Провести оплату? Будет создана проводка в журнале ДС."
          />
        </BoundForm>
        <BoundForm action={cancelSupplierPaymentAction.bind(null, payment.id)}>
          <Btn
            label="Отменить"
            icon={<Ban size={14} strokeWidth={1.6} aria-hidden />}
            confirm="Отменить заявку?"
          />
        </BoundForm>
      </span>
    );
  }
  return null;
}
