import { Module } from '@nestjs/common';
import { WorkshopNeedsController } from './workshop-needs.controller.js';
import { WorkshopNeedsOrderController } from './workshop-needs.order-controller.js';
import { WorkshopNeedsService } from './workshop-needs.service.js';

/**
 * Workshop needs MVP (Этап 4А, см.
 * `docs/recon-soft-integration.md §«Этап 4А»`).
 *
 * Рабочее место закупщика и расчёт чистой потребности заказа в
 * материалах. Модуль изолирован от закупочного контура (нет
 * Supplier / PurchaseOrder / приёмки / складских ячеек) — это
 * сознательная граница MVP.
 *
 * Два контроллера:
 *   - `WorkshopNeedsController` — `/api/workshop-needs/*` (CRUD-light
 *     для отдельной потребности);
 *   - `WorkshopNeedsOrderController` — `/api/orders/:id/workshop-needs/*`
 *     (расчёт + чтение по конкретному заказу). Вынесен в отдельный
 *     контроллер, чтобы не пересекаться с RBAC `OrdersController`
 *     (`@Roles('SHOP_MANAGER')` на классе) и не таскать orders-роуты
 *     в этот модуль.
 *
 * Сервис связан с `OrdersService` / `TechCardsService` / `PatternsService`
 * только на уровне чтения через `PrismaService` (как и
 * `assertPatternUsable` в `OrdersService`) — никаких циркулярных
 * зависимостей не вводим.
 */
@Module({
  controllers: [WorkshopNeedsController, WorkshopNeedsOrderController],
  providers: [WorkshopNeedsService],
  exports: [WorkshopNeedsService],
})
export class WorkshopNeedsModule {}
