/**
 * Foundation полуфабриката (крой) — типы движений, направления и
 * source-key builders (см.
 * `apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
 * `prisma/schema.prisma::WorkInProgressMovement`).
 *
 * **Отдельный контур** от материалов (`stock.constants.ts`) и готовой
 * продукции (`finished-goods.constants.ts`). Хранятся строкой в БД,
 * расширение без миграции.
 */
import { normalizeColor } from '@sewing/shared/colors';

export const WORK_IN_PROGRESS_MOVEMENT_TYPE = {
  /** Размещение паспорта в ячейку (`PassportsService.place`). */
  PLACE: 'PLACE',
  /** Выдача паспорта швее из ячейки (`PassportsService.issueToEmployee`). */
  ISSUE: 'ISSUE',
  /**
   * Возврат паспорта в ячейку master-action'ом
   * (`MasterActionsService.returnToCell` /
   * `MasterActionsService.setRouteStep` backward c cell-hint'ом).
   */
  RETURN: 'RETURN',
  /** Удаление паспорта, лежавшего в ячейке (`PassportsService.delete`). */
  DELETE: 'DELETE',
  /**
   * Упаковка паспорта прямо из ячейки (defensive edge-case в
   * `PackingService.addPassport`). Нормальный flow проходит через
   * `issueToEmployee` сначала, и `currentCellId` уже null на момент
   * pack-а — но если паспорт всё-таки в ячейке (например, master
   * вернул в ячейку IN_PROGRESS-паспорт, и затем packer его упаковал
   * без re-issue), мы списываем остаток через `PACK_OUT`.
   */
  PACK_OUT: 'PACK_OUT',
} as const;
export type WorkInProgressMovementType =
  (typeof WORK_IN_PROGRESS_MOVEMENT_TYPE)[keyof typeof WORK_IN_PROGRESS_MOVEMENT_TYPE];

export const WORK_IN_PROGRESS_MOVEMENT_DIRECTION = {
  IN: 'IN',
  OUT: 'OUT',
} as const;
export type WorkInProgressMovementDirection =
  (typeof WORK_IN_PROGRESS_MOVEMENT_DIRECTION)[keyof typeof WORK_IN_PROGRESS_MOVEMENT_DIRECTION];

export const WORK_IN_PROGRESS_MOVEMENT_TYPES = Object.values(
  WORK_IN_PROGRESS_MOVEMENT_TYPE,
);
export const WORK_IN_PROGRESS_MOVEMENT_DIRECTIONS = Object.values(
  WORK_IN_PROGRESS_MOVEMENT_DIRECTION,
);

/**
 * Источник `WorkInProgressMovement.sourceType`.
 *
 *   - `PASSPORT_EVENT` — основной источник: PassportEvent.id используется
 *     как `sourceId` для PLACE / ISSUE-движений (естественный event-trigger);
 *   - `MASTER_AUDIT` — для RETURN-движений (master-action логирует
 *     audit-event, его id используем как sourceId);
 *   - `PASSPORT_DELETE` — для DELETE-движений (passportId как sourceId,
 *     паспорт удаляется → ключ уникален навсегда).
 */
export const WORK_IN_PROGRESS_SOURCE_TYPE = {
  PASSPORT_EVENT: 'PASSPORT_EVENT',
  MASTER_AUDIT: 'MASTER_AUDIT',
  PASSPORT_DELETE: 'PASSPORT_DELETE',
  PASSPORT_PACK: 'PASSPORT_PACK',
} as const;
export type WorkInProgressSourceType =
  (typeof WORK_IN_PROGRESS_SOURCE_TYPE)[keyof typeof WORK_IN_PROGRESS_SOURCE_TYPE];

/**
 * `sourceKey` для движения типа `<TYPE>` с источником-событием.
 * Формат: `WIP_<TYPE>:<sourceId>`. UNIQUE на
 * `WorkInProgressMovement.sourceKey` гарантирует, что повторная
 * обработка того же события (retry, replay) не задвоит движение и не
 * удвоит баланс.
 */
export function buildWorkInProgressSourceKey(
  type: WorkInProgressMovementType,
  sourceId: string,
): string {
  return `WIP_${type}:${sourceId}`;
}

/**
 * Детерминированный ключ остатка полуфабриката (по аналогии с
 * `buildFinishedGoodsBalanceKey`):
 *
 *   `${orderId}:${productId}:${sizeId}:${color}:${warehouseId|NO_WAREHOUSE}:${cellId|NO_CELL}`
 *
 * `color` приводится к каноническому виду через `normalizeColor`
 * (`lower+trim+collapse-spaces`), чтобы один и тот же остаток ловился
 * независимо от регистра входа (`Белый` / `белый` / ` Белый `).
 * Это страховка от рассинхрона между `Passport.color` (всегда
 * нормализован при создании паспорта) и balance-row (см. инцидент
 * 27.05.2026: миграция normalize_color_lower_trim понизила color, но
 * balanceKey остался в старом регистре, и lookup перестал находить
 * существующие балансы — `WIP_INSUFFICIENT_BALANCE: доступно 0`).
 */
export function buildWorkInProgressBalanceKey(params: {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
}): string {
  const wh = params.warehouseId ?? 'NO_WAREHOUSE';
  const cl = params.cellId ?? 'NO_CELL';
  return `${params.orderId}:${params.productId}:${params.sizeId}:${normalizeColor(params.color)}:${wh}:${cl}`;
}
