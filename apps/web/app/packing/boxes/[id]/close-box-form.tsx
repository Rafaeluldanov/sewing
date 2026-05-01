'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { closeBoxAction } from '../../actions';
import { initialPackingFormState } from '../../form-state';

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn"
      disabled={pending || disabled}
    >
      {pending ? 'Закрываем…' : 'Закрыть коробку'}
    </button>
  );
}

export function CloseBoxForm({
  boxId,
  disabled = false,
}: {
  boxId: string;
  disabled?: boolean;
}) {
  const action = closeBoxAction.bind(null, boxId);
  const [state, formAction] = useFormState(action, initialPackingFormState);

  return (
    <form action={formAction}>
      {state.error && <div className="error-box">{state.error}</div>}
      {state.info && <div className="info-box">{state.info}</div>}
      <SubmitButton disabled={disabled} />
    </form>
  );
}
