'use client';

import type { TechCardTemplateDetailDto } from '@sewing/shared/tech-cards';
import { CreateTechCardWindow } from '@/app/admin/orders/new/create-tech-card-window';

/**
 * Адаптер контракта ref-create поверх готового окна «Создать техкарту»
 * из формы создания заказа. Окно самодостаточно (DraggableWindow,
 * z-index 9400+ — `zIndex` игнорируется) и возвращает полный
 * `TechCardTemplateDetailDto` через `onCreated`.
 *
 * Данные-пропы окна (patternItems/patternCategories для «подтянуть»)
 * здесь не передаются — окно штатно деградирует до ручных строк
 * материалов. Хосты, у которых номенклатура уже загружена
 * (`admin-edit-order-form`), монтируют окно напрямую с полным набором.
 */
export function CreateTechCardModal({
  onCancel,
  onCreated,
}: {
  zIndex?: number;
  onCancel: () => void;
  onCreated: (dto: TechCardTemplateDetailDto) => void;
}) {
  return <CreateTechCardWindow onCancel={onCancel} onCreated={onCreated} />;
}
