'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { addPassportToBoxAction } from '../../actions';
import { initialPackingFormState } from '../../form-state';

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary work-big-btn"
      disabled={pending || disabled}
    >
      {pending ? 'Добавляем…' : 'Упаковать паспорт'}
    </button>
  );
}

export function AddPassportForm({
  boxId,
  disabled = false,
}: {
  boxId: string;
  disabled?: boolean;
}) {
  const action = addPassportToBoxAction.bind(null, boxId);
  const [state, formAction] = useFormState(action, initialPackingFormState);
  const [code, setCode] = useState('');

  return (
    <form
      action={(fd) => {
        formAction(fd);
        setCode('');
      }}
      className="work-scan"
    >
      {state.error && <div className="error-box">{state.error}</div>}
      {state.info && <div className="info-box">{state.info}</div>}

      <label className="work-scan__label" htmlFor="code">
        Код паспорта
      </label>
      <input
        id="code"
        name="code"
        type="text"
        inputMode="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="passport:... / P-... / id"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={disabled}
      />
      <div className="actions-row">
        <SubmitButton disabled={disabled} />
      </div>
    </form>
  );
}
