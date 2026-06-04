'use client';

/**
 * `OrderLogisticsLineDialog` — inline-форма добавления / редактирования
 * ручной строки логистики в таблице «Операции» карточки заказа
 * (`/admin/orders/[id]?tab=operations`).
 *
 * Рендерится inline под таблицей (по аналогии с
 * `CreateMaterialIssueDialog`) — без полноценного модального окна.
 *
 * Окно «Добавить поле» (см. ТЗ):
 *   1. Операция (`name`)            — обязательное, удалить нельзя;
 *   2. Статус (`status`)           — выбор из списка, поле можно убрать;
 *   3. Сроки доставки (`deadline`) — дата, поле можно убрать;
 *   4. Стоимость (`costRub`)       — обязательное, удалить нельзя.
 *
 * Поля 2 и 3 можно «удалить при сохранении» — крестик скрывает поле,
 * и тогда в payload улетает `null` (на строке `status`/`deliveryDeadline`
 * = `null`). Поля 1 и 4 крестика не имеют.
 *
 * Submit: строка сериализуется в hidden `payload` (JSON), server action
 * (`createOrderLogisticsLineAction` / `updateOrderLogisticsLineAction`)
 * валидирует через `CreateOrderLogisticsLineSchema`.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Plus, X, XCircle } from 'lucide-react';
import {
  ORDER_LOGISTICS_STATUSES,
  ORDER_LOGISTICS_STATUS_LABELS,
  type OrderLogisticsLineDto,
  type OrderLogisticsStatus,
} from '@sewing/shared/orders';
import {
  createOrderLogisticsLineAction,
  initialLogisticsLineFormState,
  updateOrderLogisticsLineAction,
} from '@/app/admin/orders/[id]/logistics-lines-actions';

interface Props {
  orderId: string;
  /** Если задано — режим редактирования существующей строки. */
  line?: OrderLogisticsLineDto;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  padding: '6px 8px',
  border: '1px solid var(--admin-border, #d4d4d8)',
  borderRadius: 4,
  fontFamily: 'inherit',
  width: '100%',
};

/** ISO-string → `YYYY-MM-DD` для `<input type="date">`. */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  // Берём календарную дату по московскому времени, чтобы UTC-полночь
  // не «съезжала» на день назад (см. feedback_hydration_timezone).
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  return parts; // en-CA даёт YYYY-MM-DD
}

function SubmitButton({ isEdit }: { isEdit: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : isEdit ? 'Сохранить' : 'Добавить'}
    </button>
  );
}

export function OrderLogisticsLineDialog({ orderId, line, onClose }: Props) {
  const isEdit = line != null;

  const action = isEdit
    ? updateOrderLogisticsLineAction.bind(null, orderId, line!.id)
    : createOrderLogisticsLineAction.bind(null, orderId);
  const [state, formAction] = useFormState(
    action,
    initialLogisticsLineFormState,
  );

  const [name, setName] = useState<string>(line?.name ?? '');
  const [costRub, setCostRub] = useState<string>(
    line?.costRub != null ? String(line.costRub) : '',
  );
  // Поля «Статус» и «Сроки доставки» можно убрать. По умолчанию при
  // создании оба показаны; при редактировании — показаны, если у строки
  // есть значение.
  const [statusShown, setStatusShown] = useState<boolean>(
    isEdit ? line!.status != null : true,
  );
  const [status, setStatus] = useState<OrderLogisticsStatus | ''>(
    line?.status ?? '',
  );
  const [deadlineShown, setDeadlineShown] = useState<boolean>(
    isEdit ? line!.deliveryDeadline != null : true,
  );
  const [deadline, setDeadline] = useState<string>(
    isoToDateInput(line?.deliveryDeadline),
  );

  // Автозакрытие после успешного submit (родитель перечитает таблицу
  // через revalidatePath в server action).
  useEffect(() => {
    if (state.ok && state.doneToken) {
      onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok, state.doneToken]);

  const payload = useMemo(() => {
    const body = {
      name,
      costRub,
      // Убранное поле → null (поле «удалено при сохранении»).
      status: statusShown && status !== '' ? status : null,
      deliveryDeadline: deadlineShown && deadline !== '' ? deadline : null,
    };
    return JSON.stringify(body);
  }, [name, costRub, status, statusShown, deadline, deadlineShown]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="order-logistics-dialog-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <form
        action={formAction}
        className="order-logistics-dialog"
        data-testid="order-logistics-dialog"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 16,
          width: 'min(440px, 100%)',
          marginTop: '6vh',
          border: '1px solid var(--admin-border, #d4d4d8)',
          borderRadius: 8,
          background: '#fff',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.18)',
        }}
      >
        <input type="hidden" name="payload" value={payload} />

      <div style={{ fontWeight: 600 }}>
        {isEdit ? 'Редактирование строки логистики' : 'Новая строка логистики'}
      </div>

      {/* 1. Операция — обязательное, без крестика */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Операция <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Например: Логистика"
          style={inputStyle}
        />
      </label>

      {/* 2. Статус — поле можно убрать */}
      {statusShown ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            Статус
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => {
                setStatusShown(false);
                setStatus('');
              }}
              title="Убрать поле «Статус»"
              style={{ fontSize: '0.72rem', padding: '2px 6px' }}
            >
              <X size={12} strokeWidth={1.8} aria-hidden /> Убрать
            </button>
          </span>
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as OrderLogisticsStatus | '')
            }
            style={inputStyle}
          >
            <option value="">— не выбран —</option>
            {ORDER_LOGISTICS_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_LOGISTICS_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setStatusShown(true)}
          style={{ alignSelf: 'flex-start', fontSize: '0.78rem' }}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden /> Добавить «Статус»
        </button>
      )}

      {/* 3. Сроки доставки — поле можно убрать */}
      {deadlineShown ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            Сроки доставки
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => {
                setDeadlineShown(false);
                setDeadline('');
              }}
              title="Убрать поле «Сроки доставки»"
              style={{ fontSize: '0.72rem', padding: '2px 6px' }}
            >
              <X size={12} strokeWidth={1.8} aria-hidden /> Убрать
            </button>
          </span>
          <input
            type="date"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            style={inputStyle}
          />
        </label>
      ) : (
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => setDeadlineShown(true)}
          style={{ alignSelf: 'flex-start', fontSize: '0.78rem' }}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden /> Добавить «Сроки
          доставки»
        </button>
      )}

      {/* 4. Стоимость — обязательное, без крестика */}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 500 }}>
          Стоимость, ₽ <span style={{ color: '#dc2626' }}>*</span>
        </span>
        <input
          type="text"
          inputMode="decimal"
          value={costRub}
          onChange={(e) => setCostRub(e.target.value)}
          required
          placeholder="0.00"
          style={inputStyle}
        />
      </label>

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={14} strokeWidth={1.6} aria-hidden /> {state.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <SubmitButton isEdit={isEdit} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
        </div>
      </form>
    </div>
  );
}
