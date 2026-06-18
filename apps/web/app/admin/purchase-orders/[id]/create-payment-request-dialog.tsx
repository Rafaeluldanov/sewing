'use client';

/**
 * `CreatePaymentRequestDialog` — кнопка «Создать заявку на оплату» в
 * шапке карточки заказа поставщику. Сама форма вынесена в
 * `PaymentRequestFormModal` (общая с редактированием заявки).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet } from 'lucide-react';
import type { SupplierListItemDto } from '@sewing/shared/suppliers';
import type { CashFlowItemDto } from '@sewing/shared/treasury';
import {
  PaymentRequestFormModal,
  type PaymentRequestRequisitesPrefill,
} from './payment-request-form-modal';

export type { PaymentRequestRequisitesPrefill } from './payment-request-form-modal';

interface Props {
  purchaseOrderId: string;
  supplierName: string;
  /** Сумма заказа (Σ qty×price) — предзаполнение поля «Сумма заявки». */
  defaultAmount: string | null;
  defaultCurrency?: string | null;
  requisites: PaymentRequestRequisitesPrefill;
  /** Активные поставщики для выбора плательщика (с реквизитами + ДДС). */
  suppliers: SupplierListItemDto[];
  /** Активные статьи ДДС для выпадающего списка. */
  cashFlowItems: CashFlowItemDto[];
  /** Поставщик заказа — плательщик по умолчанию. */
  initialSupplierId: string;
  /** Статья ДДС поставщика заказа — дефолт. */
  initialCashFlowItemId: string | null;
  initialCashFlowItemName?: string | null;
}

export function CreatePaymentRequestDialog({
  purchaseOrderId,
  supplierName,
  defaultAmount,
  defaultCurrency,
  requisites,
  suppliers,
  cashFlowItems,
  initialSupplierId,
  initialCashFlowItemId,
  initialCashFlowItemName,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        onClick={() => setOpen(true)}
      >
        <Wallet size={16} strokeWidth={1.6} aria-hidden />
        Создать заявку на оплату
      </button>

      <PaymentRequestFormModal
        mode="create"
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => router.refresh()}
        purchaseOrderId={purchaseOrderId}
        supplierName={supplierName}
        suppliers={suppliers}
        cashFlowItems={cashFlowItems}
        initialSupplierId={initialSupplierId}
        initialCashFlowItemId={initialCashFlowItemId}
        initialCashFlowItemName={initialCashFlowItemName}
        initialAmount={defaultAmount}
        initialCurrency={defaultCurrency ?? null}
        initialRequisites={requisites}
      />
    </>
  );
}
