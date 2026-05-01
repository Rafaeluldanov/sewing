import { Module } from '@nestjs/common';
import { TechCardsController } from './tech-cards.controller.js';
import { TechCardsService } from './tech-cards.service.js';
import { TechCardsStorageService } from './tech-cards-storage.service.js';

/**
 * Tech cards MVP (см. `docs/domain.md §«Техкарты»`, ADR-0022). Модуль
 * управляет каталогом шаблонов техкарт (`TechCardTemplate` +
 * `TechCardMaterialLine` + `TechCardOutsourceLine`) и предоставляет
 * `/api/tech-cards`. Snapshot техкарты на заказе создаётся в
 * `OrdersModule` (`OrdersService.start()`); этот модуль заказы не
 * трогает, поэтому экспортирует сервис для чтения шаблона при snapshot.
 *
 * Этап «Изображение материала» (см. ТЗ §5, §9): добавлен
 * `TechCardsStorageService` для сохранения JPG/JPEG/PNG строк
 * материала на диск (`apps/api/uploads/tech-cards/...`). Раздача —
 * через `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`,
 * того же корня, что и у модуля «Лекала».
 */
@Module({
  controllers: [TechCardsController],
  providers: [TechCardsService, TechCardsStorageService],
  exports: [TechCardsService],
})
export class TechCardsModule {}
