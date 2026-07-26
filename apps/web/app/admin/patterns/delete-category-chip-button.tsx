'use client';

/**
 * `DeleteCategoryChipButton` — маленькая кнопка-«корзина» на чипе
 * категории в фильтре `/admin/patterns`. Удаляет категорию «в один
 * клик» (см. `deleteCategoryFromPatternsAction`): для активной
 * категории сервер сначала архивирует её, затем удаляет навсегда.
 *
 * Появляется только при hover/focus родительского чипа (CSS
 * `.pattern-category-filter__actions`), как и кнопка-карандаш
 * редактирования — чтобы строка фильтра оставалась чистой.
 *
 * ПРЕДУПРЕЖДЕНИЕ ОБЯЗАТЕЛЬНО: удаление группы каскадом уводит ВСЮ её
 * номенклатуру в архив, поэтому в `window.confirm` показываем счётчик
 * карточек (`patternsCount` приходит из серверного списка категорий) —
 * см. `buildCategoryDeleteConfirmText`.
 *
 * Backend блокирует удаление, если категорию используют техкарты, —
 * текст 409 показываем через `window.alert` (inline-место в плотном
 * ряду чипов нет), сама категория при этом остаётся на месте (action
 * откатывает транзитный архив).
 */
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { buildCategoryDeleteConfirmText } from '@/lib/pattern-category-delete-confirm';
import { deleteCategoryFromPatternsAction } from './actions';

interface Props {
  categoryId: string;
  categoryName: string;
  /** Сколько номенклатуры уедет в архив вместе с группой. */
  patternsCount: number;
}

export function DeleteCategoryChipButton({
  categoryId,
  categoryName,
  patternsCount,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    if (
      !window.confirm(
        buildCategoryDeleteConfirmText(categoryName, patternsCount),
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await deleteCategoryFromPatternsAction(categoryId);
        router.refresh();
      } catch (e) {
        window.alert(
          e instanceof Error ? e.message : 'Не удалось удалить категорию',
        );
      }
    });
  };

  return (
    <button
      type="button"
      className="pattern-category-filter__act pattern-category-filter__act--danger"
      onClick={handleClick}
      disabled={pending}
      aria-busy={pending}
      aria-label={`Удалить категорию: ${categoryName}`}
      title={`Удалить категорию: ${categoryName}`}
    >
      <Trash2 size={12} strokeWidth={1.7} aria-hidden />
    </button>
  );
}
