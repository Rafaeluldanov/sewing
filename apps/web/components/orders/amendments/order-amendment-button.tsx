'use client';

/**
 * `OrderAmendmentButton` — кнопка «Изменить в производстве» в шапке
 * карточки «Производство по размерам» (вкладка «Производство» заказа).
 * Открывает `OrderAmendmentDialog` с вкладками «Количество» / «Размерность».
 *
 * Фича «Правка заказа в производстве» (флаг `FEATURE_ORDER_AMENDMENTS`).
 * Монтируется только когда заказ в `IN_PRODUCTION` и у роли есть право
 * управлять заказом (см. `OrderProductionTab`).
 */
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type {
  OperationAmendmentStateDto,
  QuantityAmendmentStateDto,
  SizeAmendmentStateDto,
} from '@sewing/shared';
import { OrderAmendmentDialog } from './order-amendment-dialog';

interface Props {
  orderId: string;
  quantityState: QuantityAmendmentStateDto;
  sizeState: SizeAmendmentStateDto;
  operationState: OperationAmendmentStateDto;
}

export function OrderAmendmentButton({
  orderId,
  quantityState,
  sizeState,
  operationState,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        data-testid="order-amendment-button"
      >
        <SlidersHorizontal size={16} strokeWidth={1.6} aria-hidden />
        Изменить в производстве
      </button>
      {open && (
        <OrderAmendmentDialog
          orderId={orderId}
          quantityState={quantityState}
          sizeState={sizeState}
          operationState={operationState}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
