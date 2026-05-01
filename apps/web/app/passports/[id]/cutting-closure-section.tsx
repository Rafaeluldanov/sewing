'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useState } from 'react';
import {
  CUTTING_CLOSURE_REQUEST_STATUS_LABELS,
  type CuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { Icon } from '@/components/icon';
import {
  approveCuttingClosureAction,
  rejectCuttingClosureAction,
  requestCuttingClosureAction,
  type CuttingClosureFormState,
} from './cutting-closure-actions';

interface PassportLite {
  id: string;
  orderId: string;
  productId: string;
  sizeId: string;
  sizeCode: string;
  qtyCut: number;
  qtyPlan: number;
}

interface PlanFactFallback {
  qtyPlan: number;
  qtyCut: number;
  qtyRemaining: number;
}

interface Props {
  passport: PassportLite;
  request: CuttingClosureRequestDto | null;
  /** Скрываем секцию полностью для ролей вне cutter-assistant/manager. */
  canRequest: boolean;
  canReview: boolean;
  /** План/факт/остаток, посчитанный на сервере (страница `/passports/[id]`). */
  fallbackPlanFact?: PlanFactFallback;
}

const initialState: CuttingClosureFormState = {};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU');
}

export function CuttingClosureSection({
  passport,
  request,
  canRequest,
  canReview,
  fallbackPlanFact,
}: Props) {
  const planFact =
    request?.planFact ??
    fallbackPlanFact ?? {
      qtyPlan: passport.qtyPlan,
      qtyCut: passport.qtyCut,
      qtyRemaining: Math.max(passport.qtyPlan - passport.qtyCut, 0),
    };

  const status = request?.status ?? null;
  const isApproved = status === 'APPROVED';
  const isRequested = status === 'REQUESTED';
  const isRejected = status === 'REJECTED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <PlanFactGrid sizeCode={passport.sizeCode} planFact={planFact} />

      {status && <StatusBadge status={status} />}
      {request && (request.reason || request.reviewerNote) && (
        <RequestMeta request={request} />
      )}

      {/* Помощник раскройщика: подача заявки */}
      {canRequest && !isApproved && !isRequested && (
        <RequestForm
          passportId={passport.id}
          orderId={passport.orderId}
          productId={passport.productId}
          sizeId={passport.sizeId}
          allowResubmit={isRejected}
        />
      )}

      {/* Мастер цеха: approve / reject — только когда есть REQUESTED */}
      {canReview && request && isRequested && (
        <ReviewButtons
          request={request}
          passportId={passport.id}
          orderId={passport.orderId}
        />
      )}

      {/* Подсказка, чтобы помощник понял, почему кнопки нет */}
      {canRequest && isRequested && !canReview && (
        <p className="meta-line" style={{ margin: 0 }}>
          <Icon name="idle" size={14} /> Дождитесь решения мастера. Повторно
          подать заявку нельзя.
        </p>
      )}
      {isApproved && (
        <p className="meta-line" style={{ margin: 0 }}>
          <Icon name="success" size={14} /> Раскрой по этому размеру закрыт —
          выпускать новые паспорта запрещено.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function PlanFactGrid({
  sizeCode,
  planFact,
}: {
  sizeCode: string;
  planFact: PlanFactFallback;
}) {
  return (
    <div className="qc-summary">
      <div className="qc-summary__cell">
        <div className="qc-summary__label">Размер</div>
        <div className="qc-summary__value">{sizeCode}</div>
      </div>
      <div className="qc-summary__cell">
        <div className="qc-summary__label">План</div>
        <div className="qc-summary__value">{planFact.qtyPlan}</div>
      </div>
      <div className="qc-summary__cell qc-summary__cell--good">
        <div className="qc-summary__label">Выпущено</div>
        <div className="qc-summary__value">{planFact.qtyCut}</div>
      </div>
      <div className="qc-summary__cell qc-summary__cell--defect">
        <div className="qc-summary__label">Остаток</div>
        <div className="qc-summary__value">{planFact.qtyRemaining}</div>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
}) {
  const cls = status.toLowerCase();
  return (
    <p style={{ margin: 0 }}>
      <span className={`status-badge ${cls}`}>
        {CUTTING_CLOSURE_REQUEST_STATUS_LABELS[status]}
      </span>
    </p>
  );
}

function RequestMeta({ request }: { request: CuttingClosureRequestDto }) {
  return (
    <div className="meta-line" style={{ margin: 0 }}>
      Заявку подал <strong>{request.requestedByEmployeeName}</strong> в{' '}
      {formatDateTime(request.requestedAt)}.
      {request.reason && (
        <>
          {' '}
          Причина: <em>{request.reason}</em>
        </>
      )}
      {request.reviewedAt && (
        <>
          {' '}
          · Решение принял{' '}
          <strong>{request.reviewedByEmployeeName ?? '—'}</strong> в{' '}
          {formatDateTime(request.reviewedAt)}.
        </>
      )}
      {request.reviewerNote && (
        <>
          {' '}
          Комментарий мастера: <em>{request.reviewerNote}</em>
        </>
      )}
    </div>
  );
}

function SubmitButton({
  label,
  pendingLabel,
  variant = 'btn-primary',
  iconName,
}: {
  label: string;
  pendingLabel: string;
  variant?: string;
  iconName?: 'save' | 'success' | 'error';
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn ${variant}`} disabled={pending}>
      {iconName && <Icon name={iconName} size={16} />}
      {pending ? pendingLabel : label}
    </button>
  );
}

function RequestForm({
  passportId,
  orderId,
  productId,
  sizeId,
  allowResubmit,
}: {
  passportId: string;
  orderId: string;
  productId: string;
  sizeId: string;
  allowResubmit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const action = requestCuttingClosureAction.bind(
    null,
    passportId,
    orderId,
    productId,
    sizeId,
  );
  const [state, formAction] = useFormState(action, initialState);

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
      >
        <Icon name="cutting" size={16} />
        {allowResubmit
          ? 'Подать заявку повторно'
          : 'Подать заявку на закрытие'}
      </button>
    );
  }

  return (
    <form action={formAction} className="detail-form">
      <div className="detail-form__field">
        <label htmlFor="closure-reason">Причина (необязательно)</label>
        <textarea
          id="closure-reason"
          name="reason"
          rows={2}
          maxLength={280}
          placeholder="Например: рулон закончился, ткани больше нет"
        />
      </div>
      <div className="detail-form__actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Отмена
        </button>
        <SubmitButton
          label="Отправить заявку"
          pendingLabel="Отправляем…"
          iconName="save"
        />
      </div>
      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}
    </form>
  );
}

function ReviewButtons({
  request,
  passportId,
  orderId,
}: {
  request: CuttingClosureRequestDto;
  passportId: string;
  orderId: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);

  async function run(kind: 'approve' | 'reject', noteLabel?: string) {
    setError(null);
    let note: string | null = '';
    if (kind === 'reject') {
      note = window.prompt('Комментарий к отказу (необязательно)') ?? '';
    } else {
      const ok = window.confirm(
        'Подтвердить закрытие раскроя по этому размеру? После этого выпускать новые паспорта будет нельзя.',
      );
      if (!ok) return;
    }
    setPending(kind);
    try {
      const fd = new FormData();
      if (note) fd.set('note', note);
      const result =
        kind === 'approve'
          ? await approveCuttingClosureAction(
              request.id,
              passportId,
              orderId,
              fd,
            )
          : await rejectCuttingClosureAction(
              request.id,
              passportId,
              orderId,
              fd,
            );
      if (result.error) setError(result.error);
    } finally {
      setPending(null);
    }
    void noteLabel;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{error}</span>
        </div>
      )}
      <div className="detail-form__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending !== null}
          onClick={() => run('approve')}
        >
          <Icon name="success" size={16} />
          {pending === 'approve' ? 'Подтверждаем…' : 'Подтвердить закрытие'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={pending !== null}
          onClick={() => run('reject')}
        >
          <Icon name="error" size={16} />
          {pending === 'reject' ? 'Отклоняем…' : 'Отклонить'}
        </button>
      </div>
    </div>
  );
}
