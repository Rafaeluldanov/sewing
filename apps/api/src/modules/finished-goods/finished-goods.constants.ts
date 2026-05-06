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
 * Источник `FinishedGoodsMovement`. На MVP реализовано два источника:
 *   - `PACKED_PASSPORT` — упаковка паспорта (`Passport.status = PACKED`)
 *     или прохождение операции с `Operation.producesFinishedGoods = true`;
 *   - `FINISHED_GOODS_SHIPMENT_LINE` — отгрузка готовой продукции
 *     из карточки заказа (`type = SHIPMENT`, `direction = OUT`,
 *     см. `FinishedGoodsService.createShipmentForOrder`).
 */
export const FINISHED_GOODS_SOURCE_TYPE = {
  PACKED_PASSPORT: 'PACKED_PASSPORT',
  FINISHED_GOODS_SHIPMENT_LINE: 'FINISHED_GOODS_SHIPMENT_LINE',
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
 * `sourceKey` для движения выпуска готовой продукции при
 * прохождении паспортом операции с
 * `Operation.producesFinishedGoods = true` (см.
 * `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
 *
 * Сознательно совпадает с `buildPackedPassportSourceKey` — один
 * паспорт = один выпуск, независимо от того, чем он был
 * инициирован (operation flag → scan/complete или последующая
 * `Passport.status = PACKED` через `PackingService`). UNIQUE
 * `FinishedGoodsMovement.sourceKey` сам гарантирует идемпотентность
 * при любом из путей.
 */
export function buildPassportFinishedGoodsOutputSourceKey(
  passportId: string,
): string {
  return buildPackedPassportSourceKey(passportId);
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
/**
 * `sourceKey` для движения отгрузки готовой продукции по конкретной
 * строке shipment (см.
 * `FinishedGoodsService.createShipmentForOrder`,
 * `prisma/schema.prisma::FinishedGoodsShipmentLine`).
 *
 * Один shipment-line → одно движение `SHIPMENT OUT`. UNIQUE на
 * `FinishedGoodsMovement.sourceKey` гарантирует, что повторная
 * обработка строки (retry, replay) не создаст дублирующее списание.
 */
export function buildFinishedGoodsShipmentLineSourceKey(
  shipmentLineId: string,
): string {
  return `${FINISHED_GOODS_SOURCE_TYPE.FINISHED_GOODS_SHIPMENT_LINE}:${shipmentLineId}`;
}

/**
 * `sourceKey` для самого документа отгрузки. Формат
 * `FINISHED_GOODS_SHIPMENT:<orderId>:<clientRequestId>` гарантирует
 * идемпотентность: повторный submit формы (двойной клик / network
 * retry) с тем же `clientRequestId` возвращает существующий документ
 * и НЕ создаёт дублирующих движений / списаний.
 *
 * UI-слой обязан генерировать `clientRequestId` (UUID) и передавать
 * его в DTO; backend подстрахуется server-side cuid-ом, если поле
 * не пришло, но тогда повторный submit идёт под новым ключом и
 * идемпотентность отсутствует — это сознательный fallback на случай
 * нестандартных клиентов.
 */
export function buildFinishedGoodsShipmentSourceKey(
  orderId: string,
  clientRequestId: string,
): string {
  return `FINISHED_GOODS_SHIPMENT:${orderId}:${clientRequestId}`;
}

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
