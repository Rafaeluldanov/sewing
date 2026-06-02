'use client';

import { useState, useTransition } from 'react';
import { startCuttingTaskAction } from '../actions';

/**
 * Кнопка «Принять задание» для NEW-задачи. После успеха задача
 * переходит в IN_PROGRESS, фиксируется текущий раскройщик, страница
 * ревалидируется. Идемпотентно на бэке.
 */
export function StartButton({ taskId }: { taskId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="constructor-actions">
      <button
        type="button"
        className="constructor-btn constructor-btn--primary"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startCuttingTaskAction(taskId);
            if (!result.ok) {
              setError(result.error ?? 'Не удалось принять задание');
            }
          });
        }}
      >
        {pending ? 'Принимаем…' : 'Принять задание'}
      </button>
      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
