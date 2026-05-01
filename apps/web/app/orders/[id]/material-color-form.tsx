/**
 * Legacy re-export для inline-формы «Сохранить цвет позиции» (этап
 * «Указать в заказе», см. ТЗ §4).
 *
 * Реальный код формы переехал в
 * `apps/web/components/orders/materials/material-color-form.tsx`,
 * чтобы её мог импортировать новый view-tree
 * (`/admin/orders/[id]?tab=plan`). Этот файл оставлен только ради
 * существующего импорта `import { MaterialColorForm } from
 * './material-color-form'` в legacy-странице `/orders/[id]/page.tsx`
 * — без него пришлось бы менять route-level импорт, а легаси-роут
 * мы намеренно не перетряхиваем.
 *
 * Никакой логики здесь нет — только барелл-реэкспорт. Двух
 * параллельных копий формы быть не должно.
 */
export { MaterialColorForm } from '@/components/orders/materials/material-color-form';
