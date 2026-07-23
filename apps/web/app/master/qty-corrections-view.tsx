'use client';

/**
 * Вкладка «Корректировки» кабинета мастера (`/master`).
 *
 * Presentational: получает очередь открытых заявок и колбэки
 * подтверждения/отклонения от `MasterPageClient` (который поллит их в
 * общем refresh-цикле). Мастер видит суть — паспорт, было→стало,
 * причину, кто подал — и подтверждает или отклоняет. См.
 * `PassportQtyCorrectionsService`, `@sewing/shared/passport-qty-corrections`.
 */

import type { PassportQtyCorrectionDto } from '@sewing/shared/passport-qty-corrections';

interface Props {
  items: PassportQtyCorrectionDto[];
  busyId: string | null;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function QtyCorrectionsView({
  items,
  busyId,
  onApprove,
  onReject,
}: Props) {
  if (items.length === 0) {
    return (
      <div className="master-page__empty">
        <p>Корректировок на согласовании нет</p>
        <p>ОТК предлагает поправку количества — она появится здесь.</p>
      </div>
    );
  }

  return (
    <>
      {items.map((c) => (
        <QtyCorrectionCard
          key={c.id}
          correction={c}
          busy={busyId === c.id}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </>
  );
}

function QtyCorrectionCard({
  correction: c,
  busy,
  onApprove,
  onReject,
}: {
  correction: PassportQtyCorrectionDto;
  busy: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const deltaLabel = c.delta > 0 ? `+${c.delta}` : String(c.delta);
  const deltaClass =
    c.delta > 0
      ? 'qty-correction-card__delta--up'
      : 'qty-correction-card__delta--down';

  return (
    <article className="master-call-card qty-correction-card">
      <div className="master-call-card__top">
        <div>
          <h2 className="master-call-card__name">{c.passportNumber}</h2>
          <div className="master-call-card__meta-row">
            <span>Заказ</span>
            <span>{c.orderNumber}</span>
          </div>
        </div>
        <div className={`qty-correction-card__delta ${deltaClass}`}>
          {c.qtyBefore} → <strong>{c.qtyAfter}</strong>
          <span className="qty-correction-card__delta-badge">{deltaLabel}</span>
        </div>
      </div>

      <div className="master-call-card__meta">
        <div className="master-call-card__meta-row">
          <span>Изделие</span>
          <span>
            {c.productName} · {c.sizeCode}
            {c.color ? ` · ${c.color}` : ''}
          </span>
        </div>
        <div className="master-call-card__meta-row">
          <span>Подал</span>
          <span>
            {c.requestedByEmployeeName} · {formatDateTime(c.requestedAt)}
          </span>
        </div>
      </div>

      {c.reason && (
        <div className="qty-correction-card__reason">
          <span className="qty-correction-card__reason-label">Причина</span>
          {c.reason}
        </div>
      )}

      <div className="master-call-card__actions">
        <button
          type="button"
          className="btn btn-success"
          onClick={() => onApprove(c.id)}
          disabled={busy}
        >
          {busy ? 'Применяем…' : '✓ Подтвердить'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => onReject(c.id)}
          disabled={busy}
        >
          Отклонить
        </button>
      </div>
    </article>
  );
}
