-- Order: finished goods warehouse (см.
--   prisma/schema.prisma::Order.finishedGoodsWarehouseId,
--   apps/api/src/modules/orders/orders.service.ts::create / update,
--   docs/current-state.md §«Склад выпуска готовой продукции»).
--
-- Управленческое поле: на какой склад менеджер планирует выпустить
-- готовую продукцию по заказу. Это НЕ склад материалов — поле НЕ
-- влияет на StockBalance / StockMovement / MaterialIssue /
-- PurchaseReceipt и существует только на уровне Order.
--
-- onDelete SET NULL: деактивация / удаление карточки склада не
-- сносит заказ — live-связь обнуляется, UI показывает «Не выбран».

-- AlterTable
ALTER TABLE "Order"
  ADD COLUMN "finishedGoodsWarehouseId" TEXT;

-- CreateIndex
CREATE INDEX "Order_finishedGoodsWarehouseId_idx"
  ON "Order"("finishedGoodsWarehouseId");

-- AddForeignKey
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_finishedGoodsWarehouseId_fkey"
  FOREIGN KEY ("finishedGoodsWarehouseId")
  REFERENCES "Warehouse"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
