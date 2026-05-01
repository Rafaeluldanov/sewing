'use client';

/**
 * Кнопка «Запустить в производство» для admin-карточки заказа
 * (`/admin/orders/[id]`).
 *
 * UI-обёртка над уже существующим server-action
 * `startOrderAction` (см. `apps/web/app/orders/actions.ts`,
 * `OrdersService.start`). Backend сам валидирует переход и
 * принимает заказы как из `DRAFT`, так и из `CALCULATION` —
 * см. комментарий в `OrdersService.start` («мягкий gate-keeper»).
 *
 * UX совпадает со «старшим братом» `StartCalculationButton`:
 *   - confirm-диалог перед запуском (после старта план редактировать
 *     нельзя — backend закроет редактирование позиций);
 *   - `useTransition` для disabled-состояния и индикатора «Запускаем…»;
 *   - inline `error-box` под кнопкой при адресной ошибке backend-а.
 *
 * Никакой новой бизнес-логики компонент не вводит — это
 * UI-проводник к существующему action-у. См. workflow-карточку в
 * `apps/web/app/admin/orders/[id]/page.tsx` (статус CALCULATION).
 */

import { Rocket } from 'lucide-react';
import { useState, useTransition } from 'react';
import { startOrderAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
}

export function StartProductionButton({ orderId }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    if (
      !window.confirm(
        'Запустить заказ в производство? После этого план редактировать нельзя.',
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      try {
        await startOrderAction(orderId);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : 'Не удалось запустить заказ в производство',
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
        <Rocket size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Запускаем…' : 'Запустить в производство'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
