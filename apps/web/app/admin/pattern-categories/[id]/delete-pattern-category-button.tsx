'use client';

/**
 * `DeletePatternCategoryButton` — кнопка «Удалить навсегда» на карточке
 * `/admin/pattern-categories/[id]`. Hard-delete строки, в отличие от
 * soft-архива (`status=ARCHIVED`).
 *
 * Видна ТОЛЬКО для архивной категории (`status === 'ARCHIVED'`).
 * Backend блокирует удаление, если на категорию ссылаются
 * лекала/техкарты (`PATTERN_CATEGORY_DELETE_FORBIDDEN`) — текст ошибки
 * показываем inline.
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { deletePatternCategoryPageAction } from './actions';

interface Props {
  categoryId: string;
  categoryName: string;
  status: string;
}

export function DeletePatternCategoryButton({
  categoryId,
  categoryName,
  status,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Удалять навсегда можно только архивную категорию.
  if (status !== 'ARCHIVED') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        `Удалить категорию «${categoryName}» НАВСЕГДА? Действие необратимо: пропадут параметры категории.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await deletePatternCategoryPageAction(categoryId);
        router.push('/admin/patterns');
        router.refresh();
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Не удалось удалить категорию',
        );
      }
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        marginTop: 12,
      }}
    >
      <button
        type="button"
        className="admin-btn admin-btn--danger"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending}
      >
        <Trash2 size={16} strokeWidth={1.6} aria-hidden />
        {pending ? 'Удаляем…' : 'Удалить навсегда'}
      </button>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
