'use client';

/**
 * `CreatePaymentRequestDialog` — кнопка «Создать заявку на оплату» в
 * шапке карточки заказа поставщику. Сама форма вынесена в
 * `PaymentRequestFormModal` (общая с редактированием заявки).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wallet } from 'lucide-react';
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
}

export function CreatePaymentRequestDialog({
  purchaseOrderId,
  supplierName,
  defaultAmount,
  defaultCurrency,
  requisites,
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
        initialAmount={defaultAmount}
        initialCurrency={defaultCurrency ?? null}
        initialRequisites={requisites}
      />
    </>
  );
}
