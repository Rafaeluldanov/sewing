'use client';

/**
 * `OrderSamplesCard` — карточка «Сигнальный образец» в карточке заказа
 * `/admin/orders/[id]?tab=signalSample`. Список запущенных образцов
 * + кнопка «Запустить образец» (открывает `StartOrderSampleModal` —
 * overlay-модалку в стиле `ClonePatternModal`).
 *
 * Серверный компонент-обёртка готовит данные (samples, sizes, routes)
 * и передаёт сюда; вся интерактивная часть — клиентская.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import type { OrderSampleListItemDto } from '@sewing/shared/order-samples';
import { OrderSampleStatusBadge } from './order-sample-status-badge';
import {
  StartOrderSampleModal,
  type StartOrderSampleRouteOption,
  type StartOrderSampleSizeOption,
} from './start-order-sample-modal';
import {
  approveOrderSampleAction,
  cancelOrderSampleAction,
  rejectOrderSampleAction,
} from '@/app/admin/orders/[id]/order-samples-actions';
import { initialOrderSampleFormState } from '@/lib/order-samples-domain';

export interface OrderSamplesCardProps {
  orderId: string;
  samples: OrderSampleListItemDto[];
  sizes: StartOrderSampleSizeOption[];
  routeTemplates: StartOrderSampleRouteOption[];
  canManage: boolean;
}

function ActionButton({ label }: { label: string }): React.ReactElement {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="admin-btn admin-btn--ghost"
    >
      {pending ? '...' : label}
    </button>
  );
}

function ApproveButton({
  orderId,
  sampleId,
}: {
  orderId: string;
  sampleId: string;
}): React.ReactElement {
  const [, formAction] = useFormState(
    approveOrderSampleAction.bind(null, orderId, sampleId),
    initialOrderSampleFormState,
  );
  return (
    <form action={formAction} style={{ display: 'inline' }}>
      <ActionButton label="Согласовать" />
    </form>
  );
}

function CancelButton({
  orderId,
  sampleId,
}: {
  orderId: string;
  sampleId: string;
}): React.ReactElement {
  const [, formAction] = useFormState(
    cancelOrderSampleAction.bind(null, orderId, sampleId),
    initialOrderSampleFormState,
  );
  return (
    <form action={formAction} style={{ display: 'inline' }}>
      <ActionButton label="Отменить" />
    </form>
  );
}

function RejectButton({
  orderId,
  sampleId,
}: {
  orderId: string;
  sampleId: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [, formAction] = useFormState(
    rejectOrderSampleAction.bind(null, orderId, sampleId),
    initialOrderSampleFormState,
  );
  if (!open) {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
      >
        Отклонить
      </button>
    );
  }
  return (
    <form action={formAction} style={{ display: 'inline-flex', gap: 4 }}>
      <input
        type="text"
        name="reason"
        placeholder="Причина отклонения"
        required
        minLength={1}
        maxLength={1000}
      />
      <ActionButton label="Подтвердить" />
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(false)}
      >
        Закрыть
      </button>
    </form>
  );
}

export function OrderSamplesCard({
  orderId,
  samples,
  sizes,
  routeTemplates,
  canManage,
}: OrderSamplesCardProps): React.ReactElement {
  const [openModal, setOpenModal] = useState(false);

  return (
    <section className="admin-card" style={{ padding: 16 }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h2 style={{ margin: 0 }}>Сигнальный образец</h2>
        {canManage ? (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={() => setOpenModal(true)}
          >
            Запустить образец
          </button>
        ) : null}
      </header>

      {openModal ? (
        <StartOrderSampleModal
          orderId={orderId}
          sizes={sizes}
          routeTemplates={routeTemplates}
          onClose={() => setOpenModal(false)}
        />
      ) : null}

      {samples.length === 0 ? (
        <p style={{ marginTop: 16, color: '#666' }}>
          Образцы по этому заказу пока не запускались.
        </p>
      ) : (
        <table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Статус</th>
              <th align="left">Изделие / размер</th>
              <th align="left">Кол-во</th>
              <th align="left">Материалы</th>
              <th align="left">В тираж</th>
              <th align="left">Паспорт</th>
              <th align="left">Эффект на тираж</th>
              <th align="left">Действия</th>
            </tr>
          </thead>
          <tbody>
            {samples.map((s) => (
              <tr key={s.id}>
                <td>
                  <OrderSampleStatusBadge status={s.status} />
                </td>
                <td>
                  {s.product.name} · {s.size.code}
                </td>
                <td>{s.qty}</td>
                <td>
                  {s.materialMode === 'SAMPLE_ONLY'
                    ? 'Только на образец'
                    : 'На весь заказ'}
                </td>
                <td>{s.countsTowardOrderQty ? 'Да' : 'Нет'}</td>
                <td>
                  {s.passport ? (
                    <Link href={`/passports/${s.passport.id}`}>
                      {s.passport.number}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {s.status === 'APPROVED' && s.countsTowardOrderQty
                    ? `Засчитан в тираж: −${s.qty} по размеру ${s.size.code}`
                    : s.status === 'APPROVED'
                      ? 'Не входит в тираж'
                      : s.countsTowardOrderQty
                        ? `После согласования: −${s.qty} по ${s.size.code}`
                        : `Сверху: +${s.qty}`}
                </td>
                <td>
                  {canManage && s.status === 'IN_PROGRESS' ? (
                    <>
                      <ApproveButton orderId={orderId} sampleId={s.id} />{' '}
                      <RejectButton orderId={orderId} sampleId={s.id} />{' '}
                      <CancelButton orderId={orderId} sampleId={s.id} />
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
