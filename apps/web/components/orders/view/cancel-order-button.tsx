'use client';

/**
 * `CancelOrderButton` — кнопка «Отменить заказ» для управленческой
 * шапки `/admin/orders/[id]`.
 *
 * UI-обёртка над server-action `cancelOrderAction` (см.
 * `apps/web/app/orders/actions.ts`, `OrdersService.cancel`).
 *
 * Что гарантирует компонент:
 *   - **confirmation**: `window.confirm` с подсказкой, зависящей от
 *     статуса (для `IN_PRODUCTION` адресный warning про паспорта);
 *   - **status guard**: терминальные `DONE`/`CANCELLED` НЕ рендерятся
 *     вовсе (parent шапка тоже это контролирует, но и кнопка не
 *     выстрелит, если кто-то пробросит status в обход);
 *   - **disabled state**: пока `useTransition` ещё бежит, кнопка
 *     задисейблена и текст меняется на «Отменяем…»;
 *   - **error handling**: server-action бросает `Error(explainApiError)`,
 *     ошибку показываем в inline `error-box` под кнопкой;
 *   - **revalidate**: server-action сам ревалидирует `/admin/orders`
 *     и `/admin/orders/[id]` — после клика страница перерендерится
 *     с новым статусом.
 *
 * RBAC: страница `/admin/*` уже пускает только ADMIN/SHOP_MANAGER
 * (см. `apps/web/app/admin/layout.tsx`); backend независимо
 * валидирует роль и переходы.
 */
import { Ban } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { OrderStatus } from '@sewing/shared/orders';
import { cancelOrderAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
  status: OrderStatus;
}

/**
 * Терминальные статусы — отмена больше не имеет смысла. Backend
 * закроет такой запрос 409 `ORDER_INVALID_STATUS_TRANSITION`, мы
 * просто не рендерим кнопку, чтобы менеджер не получал ошибку
 * после клика.
 */
function isTerminalStatus(status: OrderStatus): boolean {
  return status === 'DONE' || status === 'CANCELLED';
}

export function CancelOrderButton({ orderId, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Защитный status-guard: если кнопку всё-таки попытались
  // отрендерить на терминальном статусе — молча возвращаем null.
  if (isTerminalStatus(status)) return null;

  const handleClick = () => {
    if (!window.confirm(buildConfirm(status))) return;
    setError(null);
    startTransition(async () => {
      try {
        await cancelOrderAction(orderId);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось отменить заказ',
        );
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="admin-btn admin-btn--danger"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        <Ban size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Отменяем…' : 'Отменить'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * Подсказка confirm-диалога зависит от статуса: для запущенного заказа
 * предупреждаем, что в производстве уже могут быть паспорта; для
 * черновика — упрощённый текст.
 */
function buildConfirm(status: OrderStatus): string {
  if (status === 'IN_PRODUCTION') {
    return 'Отменить заказ? В производстве могут быть выпущенные паспорта — отмена не вернёт их обратно.';
  }
  return 'Отменить заказ?';
}
