-- Признак «операция выпускает готовую продукцию» (см.
--   prisma/schema.prisma::Operation.producesFinishedGoods,
--   apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx,
--   apps/api/src/modules/passports/passports.service.ts::scanOnOperation /
--     completeOperationByEmployee,
--   docs/current-state.md §«Готовая продукция»).
--
-- При прохождении паспорта через операцию с `producesFinishedGoods = true`
-- создаётся `FinishedGoodsMovement` `type = PRODUCTION_RECEIPT IN` на
-- склад `Order.finishedGoodsWarehouseId` (или «no-warehouse»).
-- Идемпотентно по `FinishedGoodsMovement.sourceKey = PACKED_PASSPORT:<passportId>`
-- — повторный complete/scan и последующая упаковка не задвоят движение.
--
-- Default `false`: ни одна существующая операция не помечена как
-- выпускающая до тех пор, пока менеджер явно не включит признак в
-- `/admin/operations/[id]`. Это сохраняет текущее поведение
-- (выпуск создаётся при `Passport.status = PACKED` через
-- `PackingService.addPassport`).

ALTER TABLE "Operation"
  ADD COLUMN "producesFinishedGoods" BOOLEAN NOT NULL DEFAULT false;
