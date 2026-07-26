'use client';

/**
 * `DeletePatternCategoryButton` — кнопка «Удалить навсегда» на карточке
 * `/admin/pattern-categories/[id]`. Hard-delete строки, в отличие от
 * soft-архива (`status=ARCHIVED`).
 *
 * Видна ТОЛЬКО для архивной категории (`status === 'ARCHIVED'`).
 * Backend блокирует удаление, если на категорию ссылаются техкарты
 * (`PATTERN_CATEGORY_DELETE_FORBIDDEN`) — текст ошибки показываем
 * inline.
 *
 * Номенклатура группы удаление НЕ блокирует: она каскадом уезжает в
 * архив. Про это обязательно предупреждаем в `window.confirm` со
 * счётчиком карточек (`patternsCount`) — формулировка общая с чипом на
 * `/admin/patterns` (`buildCategoryDeleteConfirmText`).
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 */
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  buildCategoryDeleteConfirmText,
  pluralPatterns,
} from '@/lib/pattern-category-delete-confirm';
import { deletePatternCategoryPageAction } from './actions';

interface Props {
  categoryId: string;
  categoryName: string;
  status: string;
  /** Сколько номенклатуры уедет в архив вместе с группой. */
  patternsCount: number;
}

export function DeletePatternCategoryButton({
  categoryId,
  categoryName,
  status,
  patternsCount,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Удалять навсегда можно только архивную категорию.
  if (status !== 'ARCHIVED') return null;

  const handleClick = () => {
    if (
      !window.confirm(
        buildCategoryDeleteConfirmText(categoryName, patternsCount),
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
      {/* Предупреждение видно ДО клика — на карточке есть место, в
          отличие от плотного ряда чипов на /admin/patterns. */}
      {patternsCount > 0 && (
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          <AlertTriangle
            size={14}
            strokeWidth={1.7}
            aria-hidden
            style={{ verticalAlign: '-2px', marginRight: 6 }}
          />
          Внутри группы {patternsCount} {pluralPatterns(patternsCount)} — при
          удалении группы вся она уйдёт в архив «Номенклатуры», а заданные по
          параметрам группы площади и нормы пропадут.
        </div>
      )}
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
