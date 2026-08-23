import { Controller, Get, Query } from '@nestjs/common';
import {
  ProductionBoardDrillQuerySchema,
  ProductionBoardQuerySchema,
  type ProductionBoardDrillQuery,
  type ProductionBoardDrillDto,
  type ProductionBoardDto,
  type ProductionBoardQuery,
  type RouteDebtsDto,
  type RouteDivergencesDto,
} from '@sewing/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { ProductionBoardService } from './production-board.service.js';

/**
 * «Доска движения тиража» — кабинет мастера (вкладка «Движение
 * тиража», `apps/web/app/master`).
 *
 *   GET /api/master/production-board?days=7|14|30
 *   GET /api/master/production-board/drill?issueDate&stage[&employeeId]
 *   GET /api/master/production-board/divergences
 *   GET /api/master/production-board/unclosed-work
 *
 * RBAC: `SHOPFLOOR_MASTER`, `SHOP_MANAGER`, `ADMIN` — тот же доступ,
 * что у экрана `/master` (`canSeeMasterPage`). Read-only: контроллер
 * не делает мутаций.
 */
@Roles('SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN')
@Controller('master/production-board')
export class ProductionBoardController {
  constructor(private readonly service: ProductionBoardService) {}

  @Get()
  board(
    @Query(new ZodValidationPipe(ProductionBoardQuerySchema))
    query: ProductionBoardQuery,
  ): Promise<ProductionBoardDto> {
    return this.service.getBoard(query);
  }

  @Get('drill')
  drill(
    @Query(new ZodValidationPipe(ProductionBoardDrillQuerySchema))
    query: ProductionBoardDrillQuery,
  ): Promise<ProductionBoardDrillDto> {
    return this.service.getDrill(query);
  }

  /**
   * Вкладка «Расхождения»: работа, закрытая мимо маршрута заказа.
   *
   * Параметров нет сознательно — окно фиксировано (см.
   * `DIVERGENCE_WINDOW_DAYS`). Экран должен отвечать на один вопрос
   * утренней пятиминутки мастера: «есть ли сегодня то, что надо
   * разобрать». Настройки глубины превратили бы его в аналитический
   * инструмент, в который перестанут заходить.
   */
  @Get('divergences')
  divergences(): Promise<RouteDivergencesDto> {
    return this.service.getRouteDivergences();
  }

  /**
   * Секция «Незакрытая работа» той же вкладки: швейные шаги маршрута,
   * оставшиеся позади паспорта без закрытия.
   *
   * Отдельным запросом, а не полем в `divergences`: расчёты независимы
   * (один смотрит закрытия за окно, другой — текущие позиции
   * паспортов), и падение любого из них не должно прятать второй.
   */
  @Get('unclosed-work')
  unclosedWork(): Promise<RouteDebtsDto> {
    return this.service.getRouteDebts();
  }
}
