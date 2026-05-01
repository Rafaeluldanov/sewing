'use client';

/**
 * Кнопка «Пересчитать план операций» в карточке заказа
 * `/admin/orders/[id]` (см. `docs/operation-time-norms-recon.md §11`,
 * `apps/api/src/modules/orders/orders.controller.ts::recalculateOperationPlan`,
 * `apps/web/app/orders/actions.ts::recalculateOrderOperationPlanAction`).
 *
 * Этап 2 «План операций на заказе» — UI ручного пересчёта snapshot-полей
 * `Order.operationCostPlanRub` / `operationTimePlanSec`.
 *
 * UX:
 *   - кнопка показывается родителем (`OrderOperationPlanBlock`) только
 *     при `status === 'DRAFT'` или `'CALCULATION'` — backend сам
 *     дополнительно валидирует и пробрасывает 409
 *     `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED` на остальное;
 *   - confirm НЕ показываем — действие безопасное и обратимое (новый
 *     пересчёт всегда можно повторить), а лишний клик вреден UX
 *     (пользователь часто хочет «обновить» по нажатию);
 *   - вариант `mode = 'primary'` для пустого плана («Рассчитать»),
 *     `mode = 'secondary'` для существующего плана («Пересчитать»);
 *   - ошибки backend-а (адресные коды) показываем inline-ом в
 *     `error-box` под кнопкой; success обрабатывается через
 *     revalidate в action — UI просто отрисует новый snapshot.
 */

import { RefreshCcw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { recalculateOrderOperationPlanAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
  /**
   * `'primary'` — большая основная кнопка («Рассчитать план операций»),
   * показывается, если плана ещё нет.
   * `'secondary'` — компактная кнопка («Пересчитать план операций»),
   * показывается рядом со snapshot-полями плана.
   */
  mode?: 'primary' | 'secondary';
}

export function RecalculateOperationPlanButton({
  orderId,
  mode = 'secondary',
}: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await recalculateOrderOperationPlanAction(orderId);
      if (result?.error) {
        setError(result.error);
      }
    });
  };

  const labelIdle =
    mode === 'primary'
      ? 'Рассчитать план операций'
      : 'Пересчитать план операций';
  const labelPending =
    mode === 'primary' ? 'Расчёт…' : 'Пересчитываем…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className={
          mode === 'primary'
            ? 'admin-btn admin-btn--primary'
            : 'admin-btn'
        }
        onClick={handleClick}
        disabled={pending}
        title="Пересчитать стоимость и время плана операций по live-данным"
      >
        <RefreshCcw size={16} strokeWidth={1.6} aria-hidden />
        {pending ? labelPending : labelIdle}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
