/**
 * `RoutePreview` — мини-DTO шагов шаблона маршрута для превью
 * `AdminRouteSteps` в формах заказа.
 *
 * Живёт отдельным модулем, потому что тип нужен трём независимым
 * поверхностям:
 *   - `/admin/orders/new` (мастер создания, шаг «Маршрут»);
 *   - `/admin/orders/[id]/edit` (форма правки);
 *   - серверным страницам обеих — они собирают `routePreviewMap`
 *     заранее, чтобы клиент не делал round-trip за шагами.
 *
 * Раньше тип экспортировался из `admin-create-order-form.tsx`, и
 * форма правки импортировала его из формы создания — то есть один
 * большой клиентский компонент тянулся в модульный граф другого
 * только ради типа.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import type { AdminRouteStep } from '@/components/admin';

export interface RoutePreview {
  id: string;
  name: string;
  steps: AdminRouteStep[];
}
