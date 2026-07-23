'use client';

/**
 * Вкладка «Операция» drawer-а «Изменить заказ в производстве» (фича
 * `FEATURE_ORDER_AMENDMENTS`, ФАЗА 3): добавить операцию в маршрут заказа.
 *
 * Контракт:
 *   - выбор операции из справочника (кроме уже присутствующих в маршруте);
 *   - позиция: «в конец» или «после шага N» — только шаги ВПЕРЕДИ фронта
 *     (`ahead`), т.е. которые ещё не прошёл ни один паспорт (чисто
 *     аддитивно, без возврата уже сделанной работы);
 *   - обязательна «Причина». План стоимости/времени пересчитается с
 *     учётом новой операции.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle, Info, XCircle } from 'lucide-react';
import type { OperationAmendmentStateDto } from '@sewing/shared';
import {
  applyOperationAmendmentAction,
  initialOperationAmendmentFormState,
} from '@/app/admin/orders/[id]/amendment-actions';

interface Props {
  orderId: string;
  state: OperationAmendmentStateDto;
  onClose: () => void;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
    >
      <CheckCircle size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Добавляем…' : 'Добавить операцию'}
    </button>
  );
}

export function OperationAmendmentTab({ orderId, state, onClose }: Props) {
  const [operationId, setOperationId] = useState('');
  // 'append' | index-строка шага, ПОСЛЕ которого вставить.
  const [position, setPosition] = useState('append');
  const [reason, setReason] = useState('');

  const [formState, formAction] = useFormState(
    applyOperationAmendmentAction.bind(null, orderId),
    initialOperationAmendmentFormState,
  );

  useEffect(() => {
    if (formState.ok) onClose();
  }, [formState.ok, onClose]);

  // После какого шага можно вставлять — только «впереди фронта».
  const aheadSteps = useMemo(
    () => state.steps.filter((s) => s.ahead),
    [state.steps],
  );

  const afterIndex = position === 'append' ? null : Number(position);
  const reasonTrimmed = reason.trim();
  const canSubmit = operationId !== '' && reasonTrimmed.length > 0;

  const payload = JSON.stringify({
    operationId,
    afterIndex,
    reason: reasonTrimmed,
  });

  const noAvailable = state.availableOperations.length === 0;

  return (
    <form action={formAction} className="admin-form">
      <input type="hidden" name="payload" value={payload} />

      <div className="amend-note amend-note--info">
        <Info size={16} strokeWidth={1.7} aria-hidden />
        Операцию можно вставить только после шага, который ещё не прошёл ни
        один паспорт (или в конец). Уже сделанную работу это не трогает.
      </div>

      <div className="admin-field">
        <label htmlFor="amendOperationId">Операция</label>
        <select
          id="amendOperationId"
          value={operationId}
          onChange={(e) => setOperationId(e.target.value)}
          disabled={noAvailable}
        >
          <option value="">
            {noAvailable
              ? 'Все операции справочника уже в маршруте'
              : '— выберите операцию —'}
          </option>
          {state.availableOperations.map((op) => (
            <option key={op.id} value={op.id}>
              {op.name} ({op.code})
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field" style={{ marginTop: 8 }}>
        <label htmlFor="amendOperationPos">Куда вставить</label>
        <select
          id="amendOperationPos"
          value={position}
          onChange={(e) => setPosition(e.target.value)}
        >
          <option value="append">В конец маршрута</option>
          {aheadSteps.map((s) => (
            <option key={s.index} value={String(s.index)}>
              После шага {s.index + 1}. {s.operationName}
            </option>
          ))}
        </select>
      </div>

      <div className="admin-field" style={{ marginTop: 8 }}>
        <label htmlFor="amendOperationReason">Причина правки *</label>
        <input
          id="amendOperationReason"
          type="text"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Например, добавили ОТК-контроль по требованию клиента"
        />
      </div>

      {formState.error && (
        <div role="alert" className="amend-note amend-note--bad">
          <XCircle size={14} strokeWidth={1.6} aria-hidden />
          {formState.error}
        </div>
      )}

      <div className="admin-actions-row">
        <SubmitButton disabled={!canSubmit} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onClose}
        >
          Отмена
        </button>
        <span className="admin-muted amend-foot">
          Добавит шаг в маршрут заказа и пересчитает плановую стоимость и
          время. Расценку операции можно уточнить в блоке «Операции».
        </span>
      </div>
    </form>
  );
}
