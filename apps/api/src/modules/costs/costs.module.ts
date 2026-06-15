/**
 * Модуль «Себестоимость выпуска» (`/api/costs/production`).
 *
 * Read-only управленческий модуль (см. `docs/domain.md §17`,
 * `docs/api.md §17`, `docs/screens.md §17`).
 *
 * Не вводит ни новых таблиц, ни новых событий: всё считается на
 * существующих `OperationEntry` (сдельщина), `SalaryEntry`/
 * `ShiftSession` (оклад) и `PassportEvent` (длительности стадий).
 */
import { Module } from '@nestjs/common';
import { CostsController } from './costs.controller.js';
import { CostsService } from './costs.service.js';
import { PassportDurationsService } from './passport-durations.service.js';
import { ProductionCostV2Controller } from './production-cost-v2.controller.js';
import { ProductionCostV2Service } from './production-cost-v2.service.js';
import { OrderActualMaterialsController } from './order-actual-materials.controller.js';
import { OrderActualMaterialsService } from './order-actual-materials.service.js';

@Module({
  controllers: [
    CostsController,
    ProductionCostV2Controller,
    OrderActualMaterialsController,
  ],
  providers: [
    CostsService,
    PassportDurationsService,
    ProductionCostV2Service,
    OrderActualMaterialsService,
  ],
  exports: [CostsService, PassportDurationsService, ProductionCostV2Service],
})
export class CostsModule {}
