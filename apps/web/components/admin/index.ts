/**
 * Барелл-экспорт компонентов админки (Admin UI Polish).
 *
 * Импорт `import { AdminCard, AdminTable } from '@/components/admin'`
 * читается лучше, чем длинный список путей. Файл сознательно простой —
 * только реэкспорты, без логики.
 */
export { AdminCard } from './admin-card';
export { AdminSectionHeader } from './admin-section-header';
export { CategorySection } from './category-section';
export { GroupedOperationSelect } from './grouped-operation-select';
export { GroupedEquipmentSelect } from './grouped-equipment-select';
export { AdminStatusBadge } from './admin-status-badge';
export { AdminEmptyState } from './admin-empty-state';
export { AdminTable, type AdminTableColumn } from './admin-table';
export { AdminTechInfo } from './admin-tech-info';
export { AdminPageShell } from './admin-page-shell';
export { AdminPagination, paginate } from './admin-pagination';
export { AdminProductionHeatmap } from './admin-production-heatmap';
export { AdminRouteSteps, type AdminRouteStep } from './admin-route-steps';
export { AdminDateField, type AdminDateFieldProps } from './admin-date-field';
export {
  AdminSizeGrid,
  type AdminSizeGridProps,
  type AdminSizeGridSize,
} from './admin-size-grid';
export { PatternHeroPreview } from './pattern-hero-preview';
