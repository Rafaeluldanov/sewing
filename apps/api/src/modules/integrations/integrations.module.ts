import { Module } from '@nestjs/common';

import { CostsModule } from '../costs/costs.module.js';
import { ErpConsumptionController } from './erp-consumption.controller.js';
import { ErpFinishedGoodsController } from './erp-finished-goods.controller.js';
import { ErpOrderCostService } from './erp-order-cost.service.js';
import { ErpProductionController } from './erp-production.controller.js';
import { ErpProductionService } from './erp-production.service.js';
import { ErpFinishedGoodsService } from './erp-finished-goods.service.js';
import { ErpConsumptionService } from './erp-consumption.service.js';
import { ErpStockController } from './erp-stock.controller.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { UpgiftsClient } from './upgifts-client.service.js';

/**
 * Модуль «Интеграции» — связь швейного ERP с внешним ERP upgifts
 * (erp.upgifts.ru). Фаза 1: настройки подключения (сервисный аккаунт
 * per-org) + проверка соединения. Полный дизайн + фазы —
 * `docs/upgifts-integration.md`.
 *
 * Топология v1: sewing — клиент REST API upgifts (JWT). Своя inbound-API
 * не поднимается. Пароль сервисного аккаунта шифруется at-rest
 * (`secret-box.ts`). `AuditService` берётся из глобального `AuditModule`.
 */
@Module({
  // Себестоимость сдачи считает движок цеха (`PassportRealCostService`): второй расчёт тех же
  // денег разъехался бы с первым — у одной цифры один хозяин.
  imports: [CostsModule],
  controllers: [
    IntegrationsController,
    ErpStockController,
    ErpConsumptionController,
    ErpFinishedGoodsController,
    ErpProductionController,
  ],
  providers: [
    IntegrationsService,
    UpgiftsClient,
    ErpConsumptionService,
    ErpFinishedGoodsService,
    ErpProductionService,
    ErpOrderCostService,
  ],
  exports: [IntegrationsService, UpgiftsClient],
})
export class IntegrationsModule {}
