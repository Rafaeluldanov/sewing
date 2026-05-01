import { Module } from '@nestjs/common';
import { PatternsController } from './patterns.controller.js';
import { PatternsService } from './patterns.service.js';
import { PatternsStorageService } from './patterns-storage.service.js';

/**
 * Модуль «Лекала» (Patterns MVP-1, изолированный).
 *
 * Контракт — `patterns.controller.ts`, бизнес-логика — `patterns.service.ts`,
 * локальный файловый storage — `patterns-storage.service.ts`. Раздача
 * статических файлов из upload-каталога настраивается в `main.ts`
 * (`app.useStaticAssets(uploadsRoot, { prefix: '/uploads' })`).
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER`, проверяется в контроллере.
 *
 * Этот модуль НЕ зависит ни от `OrdersModule`, ни от `TechCardsModule`,
 * ни от `RoutesModule` — soft-интеграция с заказом откладывается на
 * следующий этап (см. `docs/recon-soft-integration.md`).
 */
@Module({
  controllers: [PatternsController],
  providers: [PatternsService, PatternsStorageService],
  exports: [PatternsService, PatternsStorageService],
})
export class PatternsModule {}
