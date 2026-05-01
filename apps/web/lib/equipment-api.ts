/**
 * Серверные обёртки над `/api/equipment` (см. ADR-0017,
 * `docs/api.md §3a`). Используется из RSC (`/admin/equipment`) и
 * server actions редактирования набора операций оборудования.
 */
import type {
  CreateEquipmentDto,
  EquipmentDetailDto,
  EquipmentSummaryDto,
  UpdateEquipmentDto,
  UpdateEquipmentOperationsDto,
} from '@sewing/shared/equipment';
import { apiFetch } from './api';
import { buildEquipmentPrintPath } from './browser-api-paths';

export function listEquipment(): Promise<EquipmentSummaryDto[]> {
  return apiFetch<EquipmentSummaryDto[]>('/equipment', { cache: 'no-store' });
}

export function getEquipment(id: string): Promise<EquipmentDetailDto> {
  return apiFetch<EquipmentDetailDto>(
    `/equipment/${encodeURIComponent(id)}`,
    { cache: 'no-store' },
  );
}

/**
 * Создание новой единицы оборудования (роли `ADMIN`/`SHOP_MANAGER`,
 * см. `docs/api.md §3a`). Используется со страницы `/admin/equipment`.
 */
export function createEquipment(
  body: CreateEquipmentDto,
): Promise<EquipmentDetailDto> {
  return apiFetch<EquipmentDetailDto>('/equipment', {
    method: 'POST',
    body,
  });
}

export function updateEquipmentOperations(
  id: string,
  body: UpdateEquipmentOperationsDto,
): Promise<EquipmentDetailDto> {
  return apiFetch<EquipmentDetailDto>(
    `/equipment/${encodeURIComponent(id)}/operations`,
    { method: 'PATCH', body },
  );
}

/**
 * Точечное обновление карточки оборудования. На MVP используется
 * только для изменения `displayNumber` (ручной номер станка).
 * Backend разрешает `ADMIN`/`SHOP_MANAGER` (см. EquipmentController).
 */
export function updateEquipment(
  id: string,
  body: UpdateEquipmentDto,
): Promise<EquipmentDetailDto> {
  return apiFetch<EquipmentDetailDto>(
    `/equipment/${encodeURIComponent(id)}`,
    { method: 'PATCH', body },
  );
}

/**
 * Browser-facing URL печатной формы QR-этикетки оборудования. Открывается
 * на принтер-станции в новой вкладке (`@Public()`-эндпоинт API).
 *
 * Возвращаем **относительный** путь (`/api/equipment/:id/print`), потому
 * что эта ссылка попадает в HTML страницы и кликается человеком.
 * Раньше тут жил `getClientApiUrl()`, но при SSR он отдаёт
 * `INTERNAL_API_URL` (`http://127.0.0.1:3001/api`), и ссылка ломалась
 * у любого пользователя, кроме самого хоста Next.js.
 */
export function buildEquipmentPrintUrl(id: string): string {
  return buildEquipmentPrintPath(id);
}
