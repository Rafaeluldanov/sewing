/**
 * Типизированные обёртки вокруг `apiFetch` под эндпоинты экрана «Цех»
 * (Шаг 10 MVP).
 *
 * Серверные функции (`getServerApiUrl`) — для RSC и initial render.
 * Клиентский polling вызывает API напрямую через `fetch` относительным
 * путём `/api/...`, чтобы не тащить сюда node-only код (см. `Board`).
 */

import type { OrderDivision } from '@sewing/shared/orders';
import type {
  ShopfloorDisplayDto,
  ShopfloorEquipmentStatusDto,
  ShopfloorOrderOptionDto,
  ShopfloorStateDto,
} from '@sewing/shared/shopfloor';
import { apiFetch } from './api';

export function getShopfloorState(
  orderId?: string,
): Promise<ShopfloorStateDto> {
  return apiFetch<ShopfloorStateDto>('/shopfloor/state', {
    searchParams: { orderId },
  });
}

export function listShopfloorOrders(): Promise<ShopfloorOrderOptionDto[]> {
  return apiFetch<ShopfloorOrderOptionDto[]>('/shopfloor/orders');
}

/**
 * Производственный «production board» (`/shopfloor/display`) использует
 * этот эндпоинт, чтобы показать карточки станков с цветовой индикацией
 * статуса. Backend агрегирует `Equipment` ↔ открытая `ShiftSession` ↔
 * последний `OPERATION_SCAN` (см. `ShopfloorService.listEquipmentStatus`).
 */
export function listShopfloorEquipmentStatus(): Promise<
  ShopfloorEquipmentStatusDto[]
> {
  return apiFetch<ShopfloorEquipmentStatusDto[]>('/shopfloor/equipment', {
    cache: 'no-store',
  });
}

/**
 * Единый агрегированный срез под `/shopfloor/display` (Шаг 10b).
 *
 * Объединяет KPI, матрицу «цвет × размер × stage» и статусы оборудования
 * в один read-only DTO. Используется RSC-обёрткой `display/page.tsx`
 * для initial render и тем же URL'ом — клиентским polling'ом в
 * `display-board.tsx`. Подробнее — `docs/api.md §11`.
 */
export function getShopfloorDisplaySummary(
  division?: OrderDivision,
): Promise<ShopfloorDisplayDto> {
  return apiFetch<ShopfloorDisplayDto>('/shopfloor/display', {
    cache: 'no-store',
    // Опциональный фильтр по подразделению. Если не передан — backend
    // отдаёт прежний агрегат по всем активным заказам.
    searchParams: division ? { division } : undefined,
  });
}
