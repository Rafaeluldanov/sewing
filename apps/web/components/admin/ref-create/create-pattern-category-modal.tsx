'use client';

import type { PatternCategoryDto } from '@sewing/shared/pattern-categories';
import { CreateCategoryWindow } from '@/app/admin/orders/new/create-category-window';

/**
 * Адаптер контракта ref-create поверх готового окна «Создать группу
 * номенклатуры» из формы создания заказа. Окно самодостаточно
 * (собственный оверлей DraggableWindow с z-index 9400+ — поверх любых
 * модалок, поэтому `zIndex` игнорируется) и уже возвращает свежий
 * `PatternCategoryDto` через `onCreated`. Дублировать его поля в новой
 * модалке не стали: группа без параметров бесполезна для расчётов.
 */
export function CreatePatternCategoryModal({
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: PatternCategoryDto) => void;
}) {
  return <CreateCategoryWindow onCancel={onCancel} onCreated={onCreated} />;
}
