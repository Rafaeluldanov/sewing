'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { confirmKnowledgeReviewAction } from './actions';

/**
 * «Актуально» — подтверждение срока годности прямо из строки списка.
 *
 * В этом вся механика проверки статей: если бы подтверждение требовало
 * открыть редактор и сохранить статью, подтверждать перестали бы, а
 * подсветка просроченных превратилась бы в фоновый шум, который никто
 * не разбирает.
 *
 * `stopPropagation` обязателен: строка таблицы кликабельна целиком
 * (`rowHref`), и без него клик по кнопке уводил бы в карточку.
 */
export function ConfirmReviewButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        className="admin-btn admin-btn--sm"
        disabled={pending}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setError(null);
          startTransition(async () => {
            const res = await confirmKnowledgeReviewAction(id);
            if (!res.ok) setError(res.error ?? 'Не удалось подтвердить');
          });
        }}
      >
        <CheckCircle2 size={14} strokeWidth={1.6} aria-hidden />
        {pending ? 'Отмечаем…' : 'Актуально'}
      </button>
      {error && (
        <span className="admin-muted" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
