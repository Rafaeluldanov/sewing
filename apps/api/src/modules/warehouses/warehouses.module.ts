import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrintersModule } from '../printers/printers.module.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';

/**
 * Управление складами и привязкой ячеек к складу
 * (см. `docs/domain.md §16`, `docs/api.md §15`).
 *
 * `WarehousesService` экспортируется, чтобы `CellsController`
 * (модуль паспортов) мог дёрнуть `setCellWarehouse` из ручки
 * `PATCH /api/cells/:id` — единый `WarehousesService` остаётся
 * источником истины для всей логики складской привязки.
 *
 * `PrintersModule` импортируется, чтобы `WarehousesService.printAllCells`
 * мог создать batch-job-ы через `PrintJobsService.createBatch` для
 * UI «Печать всех ячеек» (см. `docs/api.md §15`).
 */
@Module({
  imports: [PrismaModule, PrintersModule],
  controllers: [WarehousesController],
  providers: [WarehousesService],
  exports: [WarehousesService],
})
export class WarehousesModule {}
