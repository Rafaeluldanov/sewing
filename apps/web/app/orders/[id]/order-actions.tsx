'use client';

import Link from 'next/link';
import { useTransition, useState } from 'react';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  cancelOrderAction,
  completeOrderAction,
  startOrderAction,
} from '../actions';

interface Props {
  id: string;
  status: OrderStatus;
}

export function OrderActions({ id, status }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>, confirmMsg?: string) => () => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось выполнить действие');
      }
    });
  };

  return (
    <div>
      {error && <div className="error-box">{error}</div>}
      <div className="actions-row">
        {status === 'DRAFT' && (
          <>
            <Link className="btn" href={`/orders/${id}/edit`}>
              Редактировать
            </Link>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={run(() => startOrderAction(id), 'Запустить заказ в производство? После этого план редактировать нельзя.')}
            >
              {pending ? 'Запускаем…' : 'Запустить в производство'}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={run(() => cancelOrderAction(id), 'Отменить заказ?')}
            >
              Отменить
            </button>
          </>
        )}
        {status === 'IN_PRODUCTION' && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={run(() => completeOrderAction(id), 'Завершить заказ? Это ручной перевод в статус Завершён.')}
            >
              Завершить
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={pending}
              onClick={run(() => cancelOrderAction(id), 'Отменить заказ?')}
            >
              Отменить
            </button>
          </>
        )}
      </div>
    </div>
  );
}
