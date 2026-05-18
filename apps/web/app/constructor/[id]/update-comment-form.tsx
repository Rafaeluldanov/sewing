'use client';

import { useRef, useState, useTransition } from 'react';
import { updateCommentAction } from '../actions';

/**
 * Форма «Комментарий конструктора». Поле `comment` в задаче — единое
 * (общее с менеджером); UI не делает diff/append, чтобы упростить
 * MVP. Конструктор может дописать к тексту менеджера прямо в textarea.
 *
 * Сохраняет через server action `updateCommentAction` — он
 * `revalidatePath`-ит детальную страницу.
 */
export function UpdateCommentForm({
  taskId,
  initialComment,
}: {
  taskId: string;
  initialComment: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [savedFlag, setSavedFlag] = useState(false);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className="constructor-comment-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setSavedFlag(false);
        const fd = new FormData(formRef.current!);
        startTransition(async () => {
          const result = await updateCommentAction(taskId, fd);
          if (result.ok) {
            setSavedFlag(true);
          } else {
            setError(result.error ?? 'Не удалось сохранить');
          }
        });
      }}
    >
      <label className="constructor-label" htmlFor={`comment-${taskId}`}>
        Комментарий
      </label>
      <textarea
        id={`comment-${taskId}`}
        name="comment"
        defaultValue={initialComment}
        className="constructor-textarea"
        rows={5}
        maxLength={4000}
        placeholder="Заметки по работе над лекалом, вопросы менеджеру"
      />
      <div className="constructor-comment-form__footer">
        <button
          type="submit"
          className="constructor-btn constructor-btn--ghost"
          disabled={pending}
        >
          {pending ? 'Сохраняем…' : 'Сохранить комментарий'}
        </button>
        {savedFlag && (
          <span className="constructor-actions__saved">Сохранено</span>
        )}
      </div>
      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
