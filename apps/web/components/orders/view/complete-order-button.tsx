'use client';

/**
 * `CompleteOrderButton` — кнопка «Завершить заказ» для управленческой
 * шапки `/admin/orders/[id]`.
 *
 * UI-обёртка над server-action `completeOrderAction` (см.
 * `apps/web/app/orders/actions.ts`, `OrdersService.complete`).
 *
 * Что гарантирует компонент:
 *   - **status guard**: показываем кнопку только в `IN_PRODUCTION`
 *     (backend всё равно вернёт 409 `ORDER_INVALID_STATUS_TRANSITION`
 *     для любого другого, но мы не плодим ошибочные клики);
 *   - **confirmation**: обязательный `window.confirm` —
 *     завершение терминальное;
 *   - **disabled state**: пока action идёт, кнопка задисейблена и
 *     текст меняется на «Завершаем…»;
 *   - **error handling**: ошибка backend-а показывается inline в
 *     `error-box`;
 *   - **revalidate**: server-action ревалидирует `/admin/orders` и
 *     `/admin/orders/[id]` — после клика страница перерендерится с
 *     новым статусом.
 *
 * RBAC закрыт layout-ом `/admin/*` (ADMIN/SHOP_MANAGER) и backend
 * `@Roles(...)`.
 */
import { CheckCircle2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { OrderStatus } from '@sewing/shared/orders';
import { completeOrderAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
  status: OrderStatus;
}

export function CompleteOrderButton({ orderId, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Защитный status-guard: «Завершить» имеет смысл только в
  // `IN_PRODUCTION`; рендер на остальных статусах = null, чтобы
  // не выдавать менеджеру 409 после клика.
  if (status !== 'IN_PRODUCTION') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        'Завершить заказ? Это ручной перевод заказа в статус «Завершён»; новые паспорта по нему выпустить нельзя.',
      )
    )
      return;
    setError(null);
    startTransition(async () => {
      try {
        await completeOrderAction(orderId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось завершить заказ',
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
        aria-busy={pending}
      >
        <CheckCircle2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Завершаем…' : 'Завершить'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
