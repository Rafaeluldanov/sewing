import { Controller, Get, Query } from '@nestjs/common';
import {
  ShopfloorStateQuerySchema,
  type ShopfloorStateQuery,
} from '@sewing/shared/shopfloor';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { ShopfloorService } from './shopfloor.service.js';

/**
 * REST-вход для экрана «Цех». См. `docs/api.md §11`.
 *
 *   GET /api/shopfloor/state?orderId=...   — менеджерский /shopfloor
 *   GET /api/shopfloor/orders              — выпадающий список заказов
 *   GET /api/shopfloor/equipment           — статусы оборудования
 *   GET /api/shopfloor/display             — единый агрегат для
 *                                            большого монитора
 *                                            `/shopfloor/display`
 */
@Controller('shopfloor')
export class ShopfloorController {
  constructor(private readonly shopfloor: ShopfloorService) {}

  @Get('state')
  state(
    @Query(new ZodValidationPipe(ShopfloorStateQuerySchema))
    query: ShopfloorStateQuery,
  ) {
    return this.shopfloor.getState(query);
  }

  @Get('orders')
  orders() {
    return this.shopfloor.listActiveOrders();
  }

  /**
   * Список оборудования с агрегированным статусом «онлайн/предупреждение/
   * оффлайн» по открытым сменам. Используется production board на
   * `/shopfloor/display`. Сознательно не вынесен в `EquipmentController`,
   * потому что тот закрыт `@Roles(SHOP_MANAGER, ADMIN)` (см. ADR-0017),
   * а DISPLAY-роль должна видеть статус станков без доступа к админскому
   * CRUD оборудования. Подробности маппинга — в `ShopfloorService`.
   */
  @Get('equipment')
  equipment() {
    return this.shopfloor.listEquipmentStatus();
  }

  /**
   * Единый агрегированный срез под `/shopfloor/display` (Шаг 10b).
   *
   * Read-only DTO, объединяющий KPI «выпущено/в работе/ждёт/ОТК/ВТО/
   * упаковка/готово/брак», матрицу `цвет × размер × stage` и статусы
   * оборудования. Введён, чтобы:
   *   - большой монитор слал 1 polling-запрос вместо 4;
   *   - агрегация по цветам считалась на backend (а не в браузере
   *     планшета на крыше цеха);
   *   - KPI и матрица всегда были одного «снимка» (нет рассинхрона).
   *
   * RBAC — общий для всего контроллера: открыто любой авторизованной
   * роли (включая DISPLAY). Никаких мутаций ни здесь, ни в
   * `getDisplaySummary` — только проекция живых данных.
   */
  @Get('display')
  display() {
    return this.shopfloor.getDisplaySummary();
  }
}
