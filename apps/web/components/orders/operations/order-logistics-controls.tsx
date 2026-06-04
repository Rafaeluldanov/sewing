'use client';

/**
 * Клиентские острова управления ручными строками логистики в таблице
 * «Операции» карточки заказа:
 *
 *   - `OrderLogisticsAddButton` — кнопка «Добавить поле» под таблицей;
 *     открывает модальное окно `OrderLogisticsLineDialog` (режим
 *     создания);
 *   - `OrderLogisticsRowActions` — кнопки «Изменить» / «Удалить» в
 *     колонке действий логистической строки. «Изменить» открывает то
 *     же модальное окно (режим редактирования); «Удалить» — submit
 *     server action с inline-подтверждением.
 *
 * Каждый остров самодостаточен (владеет своим состоянием модалки), без
 * общего контекста — это позволяет встроить кнопки прямо в серверно
 * отрендеренные ячейки `AdminTable`, а модалку показать поверх страницы
 * (`position: fixed`).
 */

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { OrderLogisticsLineDto } from '@sewing/shared/orders';
import {
  deleteOrderLogisticsLineAction,
  initialLogisticsLineFormState,
} from '@/app/admin/orders/[id]/logistics-lines-actions';
import { OrderLogisticsLineDialog } from './order-logistics-line-dialog';

export function OrderLogisticsAddButton({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        data-testid="order-logistics-add"
        style={{ alignSelf: 'flex-start' }}
      >
        <Plus size={14} strokeWidth={1.6} aria-hidden />
        Добавить поле
      </button>
      {open && (
        <OrderLogisticsLineDialog
          orderId={orderId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function DeleteSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--ghost"
      disabled={pending}
      style={{ fontSize: '0.72rem', padding: '2px 6px', color: '#dc2626' }}
    >
      {pending ? 'Удаляем…' : 'Удалить'}
    </button>
  );
}

export function OrderLogisticsRowActions({
  orderId,
  line,
}: {
  orderId: string;
  line: OrderLogisticsLineDto;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useFormState(
    deleteOrderLogisticsLineAction.bind(null, orderId, line.id),
    initialLogisticsLineFormState,
  );

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        justifyContent: 'flex-end',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {!confirming ? (
        <>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => setEditing(true)}
            title="Изменить строку логистики"
            style={{ fontSize: '0.72rem', padding: '2px 6px' }}
          >
            <Pencil size={12} strokeWidth={1.7} aria-hidden /> Изменить
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => setConfirming(true)}
            title="Удалить строку логистики"
            style={{ fontSize: '0.72rem', padding: '2px 6px' }}
          >
            <Trash2 size={12} strokeWidth={1.7} aria-hidden />
          </button>
        </>
      ) : (
        <form action={formAction} style={{ display: 'flex', gap: 4 }}>
          <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
            Удалить?
          </span>
          <DeleteSubmit />
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => setConfirming(false)}
            style={{ fontSize: '0.72rem', padding: '2px 6px' }}
          >
            Отмена
          </button>
        </form>
      )}

      {state.error && (
        <span style={{ color: '#dc2626', fontSize: '0.72rem' }}>
          {state.error}
        </span>
      )}

      {editing && (
        <OrderLogisticsLineDialog
          orderId={orderId}
          line={line}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}
