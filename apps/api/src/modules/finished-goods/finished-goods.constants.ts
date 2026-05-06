/**
 * Foundation готовой продукции — типы движений и направления (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
 * `prisma/schema.prisma::FinishedGoodsMovement`,
 * `docs/current-state.md §«Готовая продукция»`).
 *
 * **Отдельный контур от материалов** — ничего общего с
 * `apps/api/src/modules/stock/stock.constants.ts`. Хранятся строкой в
 * БД, расширение без миграции.
 *
 * На MVP-итерации реализован только `PRODUCTION_RECEIPT` (`IN`).
 * Остальные типы (`REVERSAL`, `ADJUSTMENT`, `SHIPMENT`, `TRANSFER`)
 * зарезервированы для следующих итераций — список держим в одном
 * месте, чтобы тесты и DTO `list-finished-goods-movements` ссылались
 * на тот же набор.
 */
export const FINISHED_GOODS_MOVEMENT_TYPE = {
  PRODUCTION_RECEIPT: 'PRODUCTION_RECEIPT',
  REVERSAL: 'REVERSAL',
  ADJUSTMENT: 'ADJUSTMENT',
  SHIPMENT: 'SHIPMENT',
  TRANSFER: 'TRANSFER',
} as const;
export type FinishedGoodsMovementType =
  (typeof FINISHED_GOODS_MOVEMENT_TYPE)[keyof typeof FINISHED_GOODS_MOVEMENT_TYPE];

export const FINISHED_GOODS_MOVEMENT_DIRECTION = {
  IN: 'IN',
  OUT: 'OUT',
} as const;
export type FinishedGoodsMovementDirection =
  (typeof FINISHED_GOODS_MOVEMENT_DIRECTION)[keyof typeof FINISHED_GOODS_MOVEMENT_DIRECTION];

export const FINISHED_GOODS_MOVEMENT_TYPES = Object.values(
  FINISHED_GOODS_MOVEMENT_TYPE,
);
export const FINISHED_GOODS_MOVEMENT_DIRECTIONS = Object.values(
  FINISHED_GOODS_MOVEMENT_DIRECTION,
);

/**
 * Источник `FinishedGoodsMovement`. На MVP единственный реальный
 * источник — упаковка паспорта (`Passport.status = PACKED`).
 */
export const FINISHED_GOODS_SOURCE_TYPE = {
  PACKED_PASSPORT: 'PACKED_PASSPORT',
} as const;
export type FinishedGoodsSourceType =
  (typeof FINISHED_GOODS_SOURCE_TYPE)[keyof typeof FINISHED_GOODS_SOURCE_TYPE];

/**
 * `sourceKey` для движения выпуска по упаковке паспорта.
 *
 * Один паспорт → одно движение `PRODUCTION_RECEIPT IN`. UNIQUE на
 * `FinishedGoodsMovement.sourceKey` гарантирует, что повторная
 * обработка `PACKED` (retry, дубль box-close handler, replay) не
 * задвоит движение и не удвоит `FinishedGoodsBalance.qty`.
 */
export function buildPackedPassportSourceKey(passportId: string): string {
  return `${FINISHED_GOODS_SOURCE_TYPE.PACKED_PASSPORT}:${passportId}`;
}

/**
 * Детерминированный ключ остатка готовой продукции:
 *
 *   `${orderId}:${productId}:${sizeId}:${color}:${warehouseId|NO_WAREHOUSE}:${cellId|NO_CELL}`
 *
 * Аналог `buildStockBalanceKey` для материалов: избегает
 * нескольких строк с `(orderId, productId, sizeId, color, NULL, NULL)`
 * в SQL UNIQUE — Postgres трактует `NULL != NULL` и без явного ключа
 * UNIQUE-индекс по optional FK не сработает.
 */
export function buildFinishedGoodsBalanceKey(params: {
  orderId: string;
  productId: string;
  sizeId: string;
  color: string;
  warehouseId?: string | null;
  cellId?: string | null;
}): string {
  const wh = params.warehouseId ?? 'NO_WAREHOUSE';
  const cl = params.cellId ?? 'NO_CELL';
  return `${params.orderId}:${params.productId}:${params.sizeId}:${params.color}:${wh}:${cl}`;
}
