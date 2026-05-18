'use client';

import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { acceptConstructorTaskAction } from './admin-actions';

/**
 * Кнопка «Принять» для admin-страницы задачи в статусе `PENDING_ACCEPT`.
 * После успеха backend в одной транзакции переводит задачу в `DONE`
 * и `PatternItem.status` в `ACTIVE` — заказ можно запускать в
 * производство.
 */
export function AcceptTaskButton({ taskId }: { taskId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        className="admin-btn admin-btn--primary"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              'Принять задачу? Лекало станет активным и заказ можно будет ' +
                'запустить в производство.',
            )
          ) {
            return;
          }
          setError(null);
          startTransition(async () => {
            const result = await acceptConstructorTaskAction(taskId);
            if (!result.ok) setError(result.error ?? 'Не удалось принять');
          });
        }}
      >
        <Check size={14} strokeWidth={1.8} aria-hidden />
        {pending ? 'Принимаем…' : 'Принять'}
      </button>
      {error && (
        <span
          className="error-box__msg"
          role="alert"
          style={{ fontSize: '0.8rem' }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
