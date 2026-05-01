/**
 * Общий справочник «Роль материала» — единственный источник истины
 * для модулей «Лекала» (`PatternMaterialArea.materialRole`) и
 * «Техкарты» (`TechCardMaterialLine.materialRole`).
 *
 * Цель — связка для будущей «Потребности цеха» (см.
 * `docs/recon-soft-integration.md §«Этап 3»`):
 * `PatternMaterialArea.materialRole` ↔ `TechCardMaterialLine.materialRole`
 * образует общий ключ, по которому в будущем расчёте соединяются
 * площадь полотна на размере и плотность/ширина из техкарты:
 *
 *     чистый вес, кг = площадь_м² × плотность_г_м² × количество / 1000
 *
 * На этом этапе сама формула НЕ реализована — здесь только структура
 * данных и список ролей.
 *
 * Хранится в БД как свободная строка (без Prisma enum), чтобы
 * расширение списка ролей не требовало миграции схемы. Валидация —
 * Zod-схема ниже.
 *
 * Обратная совместимость:
 *   - `@sewing/shared/patterns` продолжает экспортировать
 *     `MATERIAL_ROLES`, `MaterialRoleSchema`, `MaterialRole` и
 *     `MATERIAL_ROLE_LABELS` (re-export из этого файла);
 *   - `@sewing/shared/tech-cards` импортирует те же значения отсюда.
 */

import { z } from 'zod';

/**
 * Допустимые роли материала. Список сознательно расширяется без
 * Prisma enum:
 *
 * - `MAIN_FABRIC`  — основной материал (футер, кулир, сатин, ...);
 * - `RIB`          — рибана / доп. материал (манжеты, воротник);
 * - `LINING`       — подклад;
 * - `THREAD`       — нитки;
 * - `PACKAGING`    — упаковка (пакет, бирка, плёнка);
 * - `APPLICATION`  — нанесение / услуга (принт, шелкография, нашивка).
 */
export const MATERIAL_ROLES = [
  'MAIN_FABRIC',
  'RIB',
  'LINING',
  'THREAD',
  'PACKAGING',
  'APPLICATION',
] as const;

export const MaterialRoleSchema = z.enum(MATERIAL_ROLES);
export type MaterialRole = z.infer<typeof MaterialRoleSchema>;

/**
 * Человекочитаемые лейблы ролей материала для UI:
 *   - таблица «Площади материалов» лекала
 *     (`apps/web/app/admin/patterns/[id]/material-areas-form.tsx`);
 *   - select «Роль материала» в строке техкарты
 *     (`apps/web/app/admin/tech-cards/tech-card-form.tsx`).
 *
 * Расширение: добавить значение в `MATERIAL_ROLES` и лейбл сюда.
 * Никакой миграции БД.
 */
export const MATERIAL_ROLE_LABELS: Record<MaterialRole, string> = {
  MAIN_FABRIC: 'Основной материал',
  RIB: 'Рибана / доп. материал',
  LINING: 'Подклад',
  THREAD: 'Нитки',
  PACKAGING: 'Упаковка',
  APPLICATION: 'Нанесение / услуга',
};

/**
 * Узкий хелпер: считаем строку валидной материал-ролью только если
 * она ровно в `MATERIAL_ROLES`. Используется в shared Zod-схемах,
 * которые принимают `string | null | undefined` от форм/JSON и
 * нормализуют пустые значения в null.
 */
export function isMaterialRole(value: unknown): value is MaterialRole {
  return (
    typeof value === 'string' &&
    (MATERIAL_ROLES as readonly string[]).includes(value)
  );
}
