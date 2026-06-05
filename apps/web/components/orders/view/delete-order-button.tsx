'use client';

/**
 * `DeleteOrderButton` — кнопка «Удалить навсегда» в управленческой
 * шапке `/admin/orders/[id]`. Hard-delete заказа, в отличие от
 * soft-отмены (`CancelOrderButton`, status=CANCELLED).
 *
 * Видна ТОЛЬКО для отменённого заказа (`status === 'CANCELLED'`) —
 * отмена и есть архивное состояние заказа. Backend дополнительно
 * блокирует удаление, если по заказу есть производственная история
 * (паспорта / закрытие кроя → `ORDER_DELETE_FORBIDDEN`); текст ошибки
 * показываем inline.
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 *
 * RBAC: `/admin/*` пускает только ADMIN/SHOP_MANAGER; backend
 * независимо валидирует роль на `DELETE /api/orders/:id`.
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { OrderStatus } from '@sewing/shared/orders';
import { deleteOrderAction } from '@/app/orders/actions';

interface Props {
  orderId: string;
  status: OrderStatus;
}

export function DeleteOrderButton({ orderId, status }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Удалять навсегда можно только отменённый заказ.
  if (status !== 'CANCELLED') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        'Удалить заказ НАВСЕГДА? Действие необратимо. Удалить можно только отменённый заказ без производственной истории.',
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deleteOrderAction(orderId);
        router.push('/admin/orders');
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось удалить заказ');
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
        <Trash2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Удаляем…' : 'Удалить навсегда'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
