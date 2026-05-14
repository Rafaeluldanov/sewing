'use client';

import { useRef, useState, useTransition } from 'react';
import { RotateCcw } from 'lucide-react';
import { REWORK_CONSTRUCTOR_TASK_FILE_FIELD } from '@sewing/shared/constructor-tasks';
import { requestReworkConstructorTaskAction } from './admin-actions';

/**
 * Форма «Вернуть на доработку» для admin-страницы задачи в статусе
 * `PENDING_ACCEPT`. По умолчанию показывает компактную кнопку «Вернуть
 * на доработку» — раскрывается до textarea + file-input при клике.
 *
 * Backend требует non-empty comment; UI запрещает submit без него.
 * Файлы — опциональны; multi-select; любой формат (валидация только
 * по размеру через `CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES`).
 */
export function RequestReworkForm({ taskId }: { taskId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={() => setOpen(true)}
        style={{ color: '#b91c1c' }}
      >
        <RotateCcw size={14} strokeWidth={1.6} aria-hidden />
        Вернуть на доработку
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const fd = new FormData(formRef.current!);
          const result = await requestReworkConstructorTaskAction(taskId, fd);
          if (result.ok) {
            // Успех — сбросим UI, состояние страницы revalidate-нул
            // server action.
            setOpen(false);
            formRef.current?.reset();
          } else {
            setError(result.error ?? 'Не удалось вернуть задачу');
          }
        });
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        padding: '0.75rem',
        border: '1px solid #fecaca',
        borderRadius: 6,
        background: '#fff7f7',
        maxWidth: 520,
      }}
    >
      <strong style={{ fontSize: '0.9rem' }}>Возврат на доработку</strong>
      <label style={{ fontSize: '0.85rem', color: '#475569' }}>
        Комментарий конструктору (обязательно)
        <textarea
          name="comment"
          rows={4}
          maxLength={4000}
          required
          placeholder="Например: размер 50 — рукав короткий на 2 см, в файле A в приложении выделено красным."
          style={{
            width: '100%',
            marginTop: 4,
            padding: '0.45rem 0.5rem',
            border: '1px solid #cbd5e1',
            borderRadius: 4,
            fontFamily: 'inherit',
            fontSize: '0.9rem',
            resize: 'vertical',
          }}
        />
      </label>
      <label style={{ fontSize: '0.85rem', color: '#475569' }}>
        Файлы замечаний (опционально)
        <input
          type="file"
          name={REWORK_CONSTRUCTOR_TASK_FILE_FIELD}
          multiple
          style={{ display: 'block', marginTop: 4, fontSize: '0.85rem' }}
        />
      </label>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="submit"
          className="admin-btn admin-btn--primary"
          disabled={pending}
          style={{ background: '#b91c1c', borderColor: '#b91c1c' }}
        >
          {pending ? 'Отправляем…' : 'Вернуть на доработку'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Отмена
        </button>
      </div>
      {error && (
        <span
          className="error-box__msg"
          role="alert"
          style={{ fontSize: '0.85rem' }}
        >
          {error}
        </span>
      )}
    </form>
  );
}
