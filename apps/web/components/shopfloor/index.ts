/**
 * Unified entry-point рабочих мест сотрудников (`shopfloor`).
 *
 * Этот namespace — НЕ новая дизайн-система: канонические компоненты
 * рабочих экранов уже существуют (`<RoleHeaderCard>`,
 * `<MobileActionCard>`, `<StatusBadge>`, `<AppSectionCard>` и т.д.) и
 * описаны в [`docs/ui-mobile.md`](../../../../docs/ui-mobile.md).
 *
 * Здесь мы:
 *   1. ре-экспортим эти компоненты под единым префиксом
 *      `@/components/shopfloor`, чтобы новый код имел одну очевидную
 *      точку входа («что использовать на рабочем месте сотрудника»);
 *   2. добавляем тонкие функциональные обёртки
 *      (`ShopfloorShell`, `ScanPanel`, `ProductionEmptyState`,
 *      `ProductionErrorState`, `ProductionLoadingState`) над уже
 *      существующими CSS-классами `globals.css` — **без новых
 *      стилей**.
 *
 * Все ре-экспорты семантические — мы НЕ оборачиваем компоненты в
 * новые имена-двойники, чтобы не плодить два API одного и того же
 * компонента (см. `docs/design-cleanup-recon.md §5`).
 */

export { ShopfloorShell } from './shopfloor-shell';
export type { ShopfloorShellProps } from './shopfloor-shell';

export { ScanPanel } from './scan-panel';
export type { ScanPanelProps } from './scan-panel';

export {
  ProductionEmptyState,
  ProductionErrorState,
  ProductionLoadingState,
} from './production-states';
export type {
  ProductionEmptyStateProps,
  ProductionErrorStateProps,
  ProductionLoadingStateProps,
} from './production-states';

// ---------------------------------------------------------------------
// Re-exports канонических компонентов рабочего места (без дублирования)
// ---------------------------------------------------------------------

/**
 * Шапка-профиль сотрудника на рабочем экране (имя, роль, поля смены,
 * статус). Канонический источник — `RoleHeaderCard`. Пере-экспортим
 * под двумя именами:
 *   - `RoleHeaderCard` — историческое имя, уже используется в
 *     `/work`, `/qc`, `/wto`, `/packing`;
 *   - `WorkerStatusCard` / `ShopfloorPageTitle` — алиасы из ТЗ для
 *     новых экранов; ровно тот же компонент.
 */
export { RoleHeaderCard } from '../role-header-card';
export { RoleHeaderCard as WorkerStatusCard } from '../role-header-card';
export { RoleHeaderCard as ShopfloorPageTitle } from '../role-header-card';
export type {
  RoleHeaderCardProps,
  RoleHeaderShiftField,
} from '../role-header-card';
export type {
  RoleHeaderCardProps as WorkerStatusCardProps,
} from '../role-header-card';

/**
 * Pill-бейдж статуса. Источник — `StatusBadge` (по `OrderStatus`).
 * Алиас `ProductionStatusBadge` повторяет имя из ТЗ.
 */
export { StatusBadge } from '../status-badge';
export { StatusBadge as ProductionStatusBadge } from '../status-badge';

/**
 * Action-карточка (icon + title + hint + variant). Используется в
 * двух-action layout помощника раскройщика и на главной для
 * менеджеров. Канонический источник — `MobileActionCard`.
 */
export { MobileActionCard } from '../mobile-action-card';
export type { MobileActionCardProps } from '../mobile-action-card';

/**
 * Тонкая контентная секция (серый фон, заголовок + хинт). Источник —
 * `AppSectionCard` (используется в `/passports/[id]` и подобных
 * сборных экранах).
 */
export { AppSectionCard } from '../app-section-card';
export type { AppSectionCardProps } from '../app-section-card';

/**
 * Иконография — единственный набор inline-SVG в проекте.
 */
export { Icon } from '../icon';

/**
 * Кнопка «Мой QR-код» (см. `docs/screens.md §«Мой QR-код»`,
 * `apps/web/lib/rbac.ts canSeeEmployeeQrButton`). Сама кнопка не
 * проверяет RBAC — это задача вызывающего layout'а; здесь её
 * пере-экспортим, чтобы новые экраны могли импортировать её из
 * единой точки.
 */
export { EmployeeQrButton } from '../employees/employee-qr-button';
export type { EmployeeQrButtonProps } from '../employees/employee-qr-button';
