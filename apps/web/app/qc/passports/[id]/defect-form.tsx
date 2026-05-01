'use client';

import { useFormState, useFormStatus } from 'react-dom';
import type { DefectTypeDto } from '@sewing/shared/qc';
import { recordDefectAction } from '../../actions';
import { initialQcDefectState } from '../../form-state';

interface Props {
  passportId: string;
  defectTypes: DefectTypeDto[];
  remaining: number;
  disabled?: boolean;
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || disabled}
    >
      {pending ? 'Запись…' : 'Зафиксировать брак'}
    </button>
  );
}

export function DefectForm({
  passportId,
  defectTypes,
  remaining,
  disabled = false,
}: Props) {
  const action = recordDefectAction.bind(null, passportId);
  const [state, formAction] = useFormState(action, initialQcDefectState);

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}
      {state.info && <div className="info-box">{state.info}</div>}

      <div className="form-row">
        <label htmlFor="defectTypeId">Вид брака</label>
        <div>
          <select
            id="defectTypeId"
            name="defectTypeId"
            defaultValue=""
            required
            disabled={disabled || defectTypes.length === 0}
          >
            <option value="">— выбрать —</option>
            {defectTypes.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.code}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="qty">Количество, шт.</label>
        <div>
          <input
            id="qty"
            name="qty"
            type="number"
            min={1}
            max={Math.max(remaining, 1)}
            step={1}
            defaultValue={1}
            required
            disabled={disabled || remaining === 0}
          />
          <div className="hint">
            Доступно к фиксации: <strong>{remaining}</strong> шт.
            (qtyCut − уже зафиксированный брак).
          </div>
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="comment">Комментарий</label>
        <div>
          <textarea
            id="comment"
            name="comment"
            rows={3}
            maxLength={500}
            placeholder="Опционально, до 500 символов"
            disabled={disabled}
          />
        </div>
      </div>

      <div className="actions-row">
        <SubmitButton disabled={disabled || remaining === 0} />
      </div>
    </form>
  );
}
