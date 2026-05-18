import { Module } from '@nestjs/common';
import { ConstructorTasksController } from './constructor-tasks.controller.js';
import { ConstructorTasksService } from './constructor-tasks.service.js';
import { ConstructorTasksStorageService } from './constructor-tasks-storage.service.js';
import { PatternsModule } from '../patterns/patterns.module.js';
import { OrdersModule } from '../orders/orders.module.js';

/**
 * «Заявка конструктору» (этап «Отправить изделие конструктору»).
 * См.:
 *   - `prisma/schema.prisma::ConstructorTask` и связанные модели;
 *   - `apps/web/app/admin/orders/new/create-product-inline.tsx`
 *     (вкладка `constructor` — модалка «Изделие»);
 *   - `apps/web/app/admin/constructor-tasks/*` — админский список/детали;
 *   - `apps/web/app/constructor/*` — кабинет конструктора (роль
 *     `CONSTRUCTOR`): assignSelf / updateComment / complete.
 *
 * Файлы вложений лежат в `apps/api/uploads/constructor-tasks/<taskId>/...`
 * (от менеджера) и `apps/api/uploads/patterns/<patternId>/sizes/...`
 * (готовые лекала от конструктора). Раздаются через
 * `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`.
 *
 * Зависимость на `PatternsModule` нужна для `PatternsStorageService`
 * (в `ConstructorTasksService.complete` мы кладём готовые DXF в тот
 * же storage, что использует ручная загрузка через `/admin/patterns/[id]`
 * — единый storage, единый формат имён, единый upload-каталог).
 */
@Module({
  imports: [PatternsModule, OrdersModule],
  controllers: [ConstructorTasksController],
  providers: [ConstructorTasksService, ConstructorTasksStorageService],
  exports: [ConstructorTasksService],
})
export class ConstructorTasksModule {}
