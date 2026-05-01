'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Icon } from '@/components/icon';
import { testPrintAction } from '../actions';
import { initialActionState, type ActionState } from '../form-state';

function TestButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      <Icon name="output" size={16} />
      {pending ? 'Создаём задание…' : 'Тестовая печать'}
    </button>
  );
}

export function TestPrintForm({ printerId }: { printerId: string }) {
  const action = testPrintAction.bind(null, printerId);
  const [state, formAction] = useFormState<ActionState, FormData>(
    action,
    initialActionState,
  );

  return (
    <form action={formAction} className="detail-form">
      {state.error && (
        <div className="detail-form__error" role="alert">
          <Icon name="error" size={16} />
          <span>{state.error}</span>
        </div>
      )}
      {state.ok && (
        <div className="detail-form__success" role="status">
          <Icon name="success" size={16} />
          <span>Задание создано. Если агент онлайн — напечатает.</span>
        </div>
      )}
      <div className="detail-form__actions">
        <TestButton />
      </div>
    </form>
  );
}
