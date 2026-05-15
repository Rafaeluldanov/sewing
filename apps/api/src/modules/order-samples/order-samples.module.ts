import { Module } from '@nestjs/common';

import { PassportsModule } from '../passports/passports.module.js';
import { WorkshopNeedsModule } from '../workshop-needs/workshop-needs.module.js';
import {
  OrderSamplesController,
  OrderSamplesOrderController,
} from './order-samples.controller.js';
import { OrderSamplesService } from './order-samples.service.js';

/**
 * Модуль «Сигнальный образец» (MVP).
 *
 * Импортирует `PassportsModule`, чтобы переиспользовать
 * `PassportsService.create` / `.delete` (см.
 * `apps/api/src/modules/order-samples/order-samples.service.ts §2-3`):
 *   - создание sample-passport через стандартный flow (number / QR /
 *     event CREATED / immediate earnings раскройщику);
 *   - cleanup-on-failure через штатный `PassportsService.delete`
 *     если транзакция фиксации `OrderSample`+`sampleId` упала.
 *
 * Сознательно НЕ импортирует `WorkshopNeedsModule` / `MaterialIssuesModule`:
 *   - в режиме `SAMPLE_ONLY` materials остаются preview-only (UI),
 *     никаких записей в `WorkshopNeed`;
 *   - в режиме `FULL_ORDER` менеджер дёргает существующий
 *     `WorkshopNeedsService.calculateForOrder` отдельной кнопкой
 *     «Потребности цеха» — связь без нового кросс-вызова.
 *
 * Никаких новых ролей — RBAC завязан на существующие `@Roles(...)`
 * (см. `order-samples.controller.ts`).
 */
@Module({
  imports: [PassportsModule, WorkshopNeedsModule],
  controllers: [OrderSamplesController, OrderSamplesOrderController],
  providers: [OrderSamplesService],
  exports: [OrderSamplesService],
})
export class OrderSamplesModule {}
