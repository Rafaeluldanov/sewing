'use client';

/**
 * Кнопка «Вернуть на пересчёт» в карточке заказа `/admin/orders/[id]`.
 *
 * Этап «Себестоимость заказа» (см.
 * `apps/api/src/modules/orders/orders.service.ts::reopenCalculation`,
 * `apps/web/app/orders/actions.ts::reopenOrderCalculationAction`).
 *
 * UX:
 *   - показывается родителем только при `status = CALCULATION_DONE`;
 *   - confirm перед действием — backend пометит активный
 *     `OrderCostEstimate` как `REVOKED` и вернёт заказ в `CALCULATION`;
 *   - WorkshopNeed, PurchaseOrder и PurchaseReceipt не трогаются —
 *     закупщик правит существующие строки.
 */

import { useTransition, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { reopenOrderCalculationAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
}

export function ReopenCalculationButton({ orderId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (
      !window.confirm(
        'Вернуть заказ на пересчёт? Текущая себестоимость будет помечена как отозванная (история сохранится). Закупщик сможет править строки потребности заново.',
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      const result = await reopenOrderCalculationAction(orderId, {}, form);
      if (result?.error) {
        setError(result.error);
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="admin-btn"
        onClick={handleClick}
        disabled={pending}
        title="Вернуть заказ на пересчёт"
      >
        <Undo2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Возвращаем…' : 'Вернуть на пересчёт'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
