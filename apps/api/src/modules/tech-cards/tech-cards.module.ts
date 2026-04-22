import { Module } from '@nestjs/common';
import { TechCardsController } from './tech-cards.controller.js';
import { TechCardsService } from './tech-cards.service.js';

/**
 * Tech cards MVP (см. `docs/domain.md §«Техкарты»`, ADR-0022). Модуль
 * управляет каталогом шаблонов техкарт (`TechCardTemplate` +
 * `TechCardMaterialLine` + `TechCardOutsourceLine`) и предоставляет
 * `/api/tech-cards`. Snapshot техкарты на заказе создаётся в
 * `OrdersModule` (`OrdersService.start()`); этот модуль заказы не
 * трогает, поэтому экспортирует сервис для чтения шаблона при snapshot.
 */
@Module({
  controllers: [TechCardsController],
  providers: [TechCardsService],
  exports: [TechCardsService],
})
export class TechCardsModule {}
