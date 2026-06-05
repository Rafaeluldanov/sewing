'use client';

/**
 * Таблица строк PO с inline-редактированием.
 *
 * На каждой строке — отдельный `<form action={...}>` со своим
 * `useFormState`, чтобы менеджер мог сохранять строки независимо.
 * Поля:
 *   - qty / price / currency / expectedDeliveryDate;
 *   - confirmedQty / confirmedPrice / confirmedDeliveryDate;
 *   - comment.
 *
 * Статус строки тут не правим — он каскадно меняется кнопками
 * `Send`/`Confirm`/`Cancel` на шапке. Для крайних случаев (CANCEL
 * одной строки без отмены всего PO) backend поддерживает PATCH с
 * `status`, но из UI это не выводим — путаное поведение для
 * бухгалтерии («отменена половина строк») лучше отложить.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Save, XCircle } from 'lucide-react';
import {
  PURCHASE_ORDER_LINE_STATUS_LABELS,
  type PurchaseOrderLineDto,
  type PurchaseOrderLineStatus,
} from '@sewing/shared/purchase-orders';
import { AdminEmptyState, AdminStatusBadge } from '@/components/admin';
import type { AdminStatusTone } from '@/lib/admin-labels';
import { updatePurchaseOrderLineAction } from '../actions';
import { initialUpdatePurchaseOrderLineState } from '../form-state';

/**
 * Тон/лейбл статуса строки считаем тут, внутри клиентского
 * компонента. Раньше эти функции прокидывались пропсами из RSC —
 * но функции нельзя сериализовать в Client Component, и в prod-сборке
 * это валило страницу карточки PO server-side исключением
 * (digest 1250889687).
 */
function lineStatusTone(status: string): AdminStatusTone {
  switch (status as PurchaseOrderLineStatus) {
    case 'DRAFT':
      return 'info';
    case 'SENT':
      return 'warning';
    case 'CONFIRMED':
      return 'success';
    case 'PARTIALLY_RECEIVED':
      return 'warning';
    case 'RECEIVED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'muted';
  }
}

function formatLineStatus(status: string): string {
  return (
    PURCHASE_ORDER_LINE_STATUS_LABELS[status as PurchaseOrderLineStatus] ??
    status
  );
}

function SmallSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn" disabled={pending}>
      <Save size={14} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface Props {
  orderId: string;
  lines: PurchaseOrderLineDto[];
}

export function PurchaseOrderLinesTable({ orderId, lines }: Props) {
  if (lines.length === 0) {
    return (
      <AdminEmptyState title="В заказе пока нет строк" hint="Это странно — обычно строки создаются вместе с PO. Проверьте лог." />
    );
  }
  return (
    <div className="admin-stack" style={{ gap: 12 }}>
      {lines.map((line) => (
        <LineCard key={line.id} orderId={orderId} line={line} />
      ))}
    </div>
  );
}

function LineCard({
  orderId,
  line,
}: {
  orderId: string;
  line: PurchaseOrderLineDto;
}) {
  const [state, action] = useFormState(
    updatePurchaseOrderLineAction.bind(null, orderId, line.id),
    initialUpdatePurchaseOrderLineState,
  );

  const amount =
    line.price != null && Number.isFinite(Number(line.price))
      ? (Number(line.qty) * Number(line.price)).toFixed(2)
      : null;

  return (
    <div
      className="admin-card"
      style={{
        padding: 12,
        border: '1px solid rgba(0,0,0,0.08)',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600 }}>
            {line.itemNameSnapshot}
            {line.supplierArticleSnapshot && (
              <>
                {' '}
                <code style={{ fontSize: '0.75rem' }}>
                  {line.supplierArticleSnapshot}
                </code>
              </>
            )}
          </div>
          {(line.workshopNeedDescription || line.customerOrderNumber) && (
            <div
              className="admin-muted"
              style={{ fontSize: '0.78rem', marginTop: 2 }}
            >
              {line.customerOrderNumber && (
                <>Заказ {line.customerOrderNumber}</>
              )}
              {line.customerOrderNumber && line.workshopNeedDescription && (
                <> · </>
              )}
              {line.workshopNeedDescription}
            </div>
          )}
        </div>
        <AdminStatusBadge tone={lineStatusTone(line.status)}>
          {formatLineStatus(line.status)}
        </AdminStatusBadge>
      </div>

      <form action={action} className="admin-form">
        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-qty`}>
              Количество ({line.unitSnapshot})
            </label>
            <input
              id={`line-${line.id}-qty`}
              name="qty"
              type="text"
              inputMode="decimal"
              defaultValue={line.qty}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-price`}>Цена</label>
            <input
              id={`line-${line.id}-price`}
              name="price"
              type="text"
              inputMode="decimal"
              defaultValue={line.price ?? ''}
              placeholder={
                line.catalogLastPriceSnapshot
                  ? `каталог: ${line.catalogLastPriceSnapshot}`
                  : '0.00'
              }
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-currency`}>Валюта</label>
            <input
              id={`line-${line.id}-currency`}
              name="currency"
              type="text"
              maxLength={16}
              defaultValue={line.currency ?? ''}
              placeholder="RUB"
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-eta`}>Ожидается</label>
            <input
              id={`line-${line.id}-eta`}
              name="expectedDeliveryDate"
              type="date"
              defaultValue={isoToDateInput(line.expectedDeliveryDate)}
            />
          </div>
        </div>

        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-cqty`}>
              Подтв. количество
            </label>
            <input
              id={`line-${line.id}-cqty`}
              name="confirmedQty"
              type="text"
              inputMode="decimal"
              defaultValue={line.confirmedQty ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-cprice`}>Подтв. цена</label>
            <input
              id={`line-${line.id}-cprice`}
              name="confirmedPrice"
              type="text"
              inputMode="decimal"
              defaultValue={line.confirmedPrice ?? ''}
            />
          </div>
          <div className="admin-field">
            <label htmlFor={`line-${line.id}-ceta`}>Подтв. дата</label>
            <input
              id={`line-${line.id}-ceta`}
              name="confirmedDeliveryDate"
              type="date"
              defaultValue={isoToDateInput(line.confirmedDeliveryDate)}
            />
          </div>
          <div className="admin-field">
            <label>Сумма</label>
            <div className="admin-muted" style={{ paddingTop: 6 }}>
              {amount ?? '—'}
            </div>
          </div>
        </div>

        <div className="admin-field">
          <label htmlFor={`line-${line.id}-comment`}>Комментарий</label>
          <textarea
            id={`line-${line.id}-comment`}
            name="comment"
            rows={2}
            maxLength={1000}
            defaultValue={line.comment ?? ''}
          />
        </div>

        {state.error && (
          <div className="error-box" role="alert">
            <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
          </div>
        )}
        {state.ok && state.successMessage && (
          <div className="success-box" role="status">
            <CheckCircle size={16} strokeWidth={1.6} aria-hidden />{' '}
            {state.successMessage}
          </div>
        )}

        <div className="admin-actions-row">
          <SmallSubmit />
        </div>
      </form>
    </div>
  );
}
