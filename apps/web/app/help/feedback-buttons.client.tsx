'use client';

import { useState, useTransition } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import type { KnowledgeFeedbackKind } from '@sewing/shared/knowledge';
import { sendHelpFeedbackAction } from './actions';

/**
 * Оценка статьи в читалке.
 *
 * Три кнопки, а не две: «это не то» отделено от 👎 намеренно. Первое
 * значит «поиск привёл не туда» и лечится заголовком и ключевыми
 * словами; второе — «статья про то, но плохая» и лечится текстом.
 * Слепив их в один палец вниз, мы потеряли бы различие ровно там, где
 * оно подсказывает, что чинить.
 *
 * После нажатия кнопки исчезают: повторно оценивать одну статью
 * незачем, а «спасибо» без действия — самое честное завершение.
 */
export function HelpFeedbackButtons({
  slug,
  query,
}: {
  slug: string;
  query?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<KnowledgeFeedbackKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <p className="help-feedback__thanks">
        {done === 'HELPFUL'
          ? 'Спасибо, отметили.'
          : 'Спасибо — мастер увидит, что статью надо поправить.'}
      </p>
    );
  }

  const send = (kind: KnowledgeFeedbackKind) => {
    setError(null);
    startTransition(async () => {
      const res = await sendHelpFeedbackAction(slug, kind, query);
      if (res.ok) setDone(kind);
      else setError(res.error ?? 'Не удалось отправить');
    });
  };

  return (
    <div className="help-feedback">
      <span className="help-feedback__label">Помогло?</span>
      <button
        type="button"
        className="help-feedback__btn"
        disabled={pending}
        onClick={() => send('HELPFUL')}
        aria-label="Статья помогла"
      >
        <ThumbsUp size={16} strokeWidth={1.6} aria-hidden />
      </button>
      <button
        type="button"
        className="help-feedback__btn"
        disabled={pending}
        onClick={() => send('NOT_HELPFUL')}
        aria-label="Статья не помогла"
      >
        <ThumbsDown size={16} strokeWidth={1.6} aria-hidden />
      </button>
      <button
        type="button"
        className="help-feedback__btn help-feedback__btn--wide"
        disabled={pending}
        onClick={() => send('NOT_WHAT_I_MEANT')}
      >
        Это не то
      </button>
      {error && <span className="help-feedback__error">{error}</span>}
    </div>
  );
}
