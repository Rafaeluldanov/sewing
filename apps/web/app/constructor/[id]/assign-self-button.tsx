'use client';

import { useState, useTransition } from 'react';
import { assignSelfAction } from '../actions';

/**
 * Кнопка «Взять в работу» для NEW-задачи без `assignedToId`. После
 * успеха задача переходит в `IN_PROGRESS` и получает текущего
 * конструктора, страница ревалидируется (см. `assignSelfAction`).
 *
 * Idempotent на бэке: если задача уже у меня в работе, возвращается
 * без изменений — UX без сюрпризов.
 */
export function AssignSelfButton({ taskId }: { taskId: string }) {
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
            const result = await assignSelfAction(taskId);
            if (!result.ok) setError(result.error ?? 'Не удалось взять задачу');
          });
        }}
      >
        {pending ? 'Берём…' : 'Взять в работу'}
      </button>
      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
