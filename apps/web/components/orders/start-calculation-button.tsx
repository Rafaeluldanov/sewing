'use client';

/**
 * Кнопка «Перевести в расчёт» для карточки заказа в admin-разделе
 * (`/admin/orders/[id]`).
 *
 * Этап «Расчёт» (см. `OrdersService.startCalculation`,
 * `apps/web/app/orders/actions.ts::startCalculationOrderAction`).
 *
 * UX:
 *   - кнопка показывается только при `status = 'DRAFT'` — за это
 *     отвечает родитель (`AdminOrderDetailPage`), компонент сам
 *     status уже не проверяет (он всегда отрисовывается в DRAFT-блоке);
 *   - перед сменой статуса просим подтверждение, чтобы случайный
 *     клик не уносил план в расчёт без размышления;
 *   - ошибки backend-а (адресные коды, см. action-комментарий)
 *     показываем inline-ом в `error-box` под кнопкой; success
 *     обрабатывается через revalidate в action — UI просто
 *     отрисует обновлённый статус и блок «Потребность цеха».
 */

import { Calculator } from 'lucide-react';
import { useState, useTransition } from 'react';
import { startCalculationOrderAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
}

export function StartCalculationButton({ orderId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (
      !window.confirm(
        'Перевести заказ в статус «Расчёт»? Будут автоматически собраны строки потребности цеха по лекалу и техкарте.',
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      try {
        // Action возвращает `{ error }` (а не throw) — в проде Next.js
        // вырезает текст брошенных из server-action ошибок, поэтому
        // осмысленное сообщение приходит только через возвращаемое поле.
        const result = await startCalculationOrderAction(orderId);
        if (result?.error) {
          setError(result.error);
        }
      } catch (e) {
        // Фолбэк на непредвиденный сбой транспорта (не бизнес-ошибку):
        // текст всё равно будет generic-ом из-за prod-редакции.
        setError(
          e instanceof Error
            ? e.message
            : 'Не удалось перевести заказ в расчёт',
        );
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        onClick={handleClick}
        disabled={pending}
      >
        <Calculator size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Расчёт…' : 'Перевести в расчёт'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
