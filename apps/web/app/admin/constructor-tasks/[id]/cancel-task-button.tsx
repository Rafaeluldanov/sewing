'use client';

import { useState, useTransition } from 'react';
import { Ban } from 'lucide-react';
import type { ConstructorTaskStatus } from '@sewing/shared/constructor-tasks';
import { cancelConstructorTaskAction } from '../actions';

interface Props {
  taskId: string;
  currentStatus: ConstructorTaskStatus;
}

/**
 * Кнопка «Отменить заявку» на детальной странице задачи конструктору.
 *
 * Отображается только если статус позволяет отмену (`NEW` или
 * `IN_PROGRESS`). На `DONE` / `CANCELLED` — рендерим disabled-кнопку
 * с tooltip-объяснением, чтобы менеджер видел почему она недоступна.
 *
 * Семантика отмены — soft: запись `ConstructorTask` остаётся в БД,
 * только меняется `status='CANCELLED'`. DRAFT-pattern сохраняется
 * (может быть привязан к заказу).
 */
export function CancelTaskButton({ taskId, currentStatus }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const disabledReason =
    currentStatus === 'DONE'
      ? 'Лекало уже передано — отменять нечего'
      : currentStatus === 'CANCELLED'
        ? 'Заявка уже отменена'
        : null;

  const onClick = () => {
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        'Отменить заявку конструктору? Сама запись останется в истории, ' +
          'но конструктор её больше не получит. Чёрновое лекало останется ' +
          'в номенклатуре — заархивируйте его отдельно, если нужно.',
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await cancelConstructorTaskAction(taskId);
      if (!result.ok) setError(result.error ?? 'Не удалось отменить');
    });
  };

  return (
    <div
      style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}
    >
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={onClick}
        disabled={pending || disabledReason !== null}
        title={disabledReason ?? 'Отменить заявку'}
        style={{
          color: disabledReason ? undefined : '#b91c1c',
        }}
      >
        <Ban size={14} strokeWidth={1.6} aria-hidden />
        {pending ? 'Отменяем…' : 'Отменить заявку'}
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
