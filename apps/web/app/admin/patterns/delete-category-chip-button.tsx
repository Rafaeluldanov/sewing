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
 * номенклатуру в архив и отвязывает техкарты, поэтому в
 * `window.confirm` показываем оба счётчика (приходят из серверного
 * списка категорий) — см. `buildCategoryDeleteConfirmText`.
 *
 * Если backend всё же отказал (например, категория уже не архивная),
 * текст причины приходит ЗНАЧЕНИЕМ (`ActionResult.error`), а не
 * исключением: prod-сборка Next.js подменяет текст брошенной ошибки на
 * digest-заглушку. Показываем через `window.alert` — inline-места в
 * плотном ряду чипов нет; сама категория при этом остаётся на месте
 * (action откатывает транзитный архив).
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
      const res = await deleteCategoryFromPatternsAction(categoryId);
      if (!res.ok) {
        window.alert(res.error ?? 'Не удалось удалить категорию');
        return;
      }
      router.refresh();
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
