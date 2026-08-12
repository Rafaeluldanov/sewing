'use client';

/**
 * `DeletePatternCategoryButton` — кнопка «Удалить навсегда» на карточке
 * `/admin/pattern-categories/[id]`. Hard-delete строки, в отличие от
 * soft-архива (`status=ARCHIVED`).
 *
 * Видна ТОЛЬКО для архивной категории (`status === 'ARCHIVED'`).
 *
 * Содержимое группы удаление НЕ блокирует: номенклатура каскадом
 * уезжает в архив, техкарты остаются без группы. Про это обязательно
 * предупреждаем — и в `window.confirm`, и inline над кнопкой
 * (формулировка общая с чипом на `/admin/patterns`, см.
 * `buildCategoryDeleteConfirmText` / `describeCategoryContents`).
 *
 * Причину отказа backend отдаёт ЗНАЧЕНИЕМ (`ActionResult.error`), а не
 * исключением: prod-сборка Next.js подменяет текст брошенной из server
 * action ошибки на digest-заглушку. Показываем inline.
 *
 * После успеха карточки больше нет — уводим на список (`router.push`).
 */
import { AlertTriangle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  buildCategoryDeleteConfirmText,
  describeCategoryContents,
} from '@/lib/pattern-category-delete-confirm';
import { deletePatternCategoryPageAction } from './actions';

interface Props {
  categoryId: string;
  categoryName: string;
  status: string;
  /** Сколько номенклатуры уедет в архив вместе с группой. */
  patternsCount: number;
  /** Сколько техкарт останется без группы. */
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

  const contents = describeCategoryContents(patternsCount);

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
      const res = await deletePatternCategoryPageAction(categoryId);
      if (!res.ok) {
        setError(res.error ?? 'Не удалось удалить категорию');
        return;
      }
      router.push('/admin/patterns');
      router.refresh();
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
      {contents && (
        <div className="admin-muted" style={{ fontSize: '0.85rem' }}>
          <AlertTriangle
            size={14}
            strokeWidth={1.7}
            aria-hidden
            style={{ verticalAlign: '-2px', marginRight: 6 }}
          />
          При удалении группы: {contents}. Заданные по параметрам группы
          площади и нормы пропадут.
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
