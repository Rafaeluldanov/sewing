import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  CreateWarehouseLineSchema,
  CreateWarehouseSchema,
  PrintWarehouseCellsSchema,
  UpdateWarehouseSchema,
  type CreateWarehouseDto,
  type CreateWarehouseLineDto,
  type CreateWarehouseLineResultDto,
  type PrintWarehouseCellsDto,
  type PrintWarehouseCellsResultDto,
  type UpdateWarehouseDto,
  type WarehouseDetailDto,
  type WarehouseSummaryDto,
} from '@sewing/shared/warehouses';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { resolvePublicApiBaseUrl } from '../printers/public-api-url.js';
import { WarehousesService } from './warehouses.service.js';

/**
 * Управление складами (см. `docs/api.md §15`, `docs/screens.md §10b`).
 *
 * Доступ — только `ADMIN` и `SHOP_MANAGER`. Это управленческий
 * раздел: рабочие роли (швея/раскройщик/ОТК/упаковщик) сюда не
 * ходят, и backend не должен пускать их на любую ручку — даже на
 * GET-список (см. `docs/domain.md §16`).
 *
 * Привязка ячейки к складу живёт на `PATCH /api/cells/:id` —
 * см. `CellsController`.
 */
@Controller('warehouses')
@Roles('SHOP_MANAGER', 'ADMIN')
export class WarehousesController {
  constructor(private readonly warehouses: WarehousesService) {}

  @Get()
  list(): Promise<WarehouseSummaryDto[]> {
    return this.warehouses.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateWarehouseSchema))
    dto: CreateWarehouseDto,
  ): Promise<WarehouseDetailDto> {
    return this.warehouses.create(dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<WarehouseDetailDto> {
    return this.warehouses.getOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateWarehouseSchema))
    dto: UpdateWarehouseDto,
  ): Promise<WarehouseDetailDto> {
    return this.warehouses.update(id, dto);
  }

  /**
   * Массовое создание ячеек через линию
   * (см. `docs/api.md §15`, `docs/domain.md §16`).
   *
   * Контракт:
   *   - `code` — глобально уникальный код линии (например, `A`);
   *   - `count` — сколько ячеек создать с кодами `${code}1..${code}N`.
   *
   * Все созданные ячейки сразу принадлежат складу `:id` и линии,
   * QR-payload `cell:{id}` (ADR-0008) — не меняется.
   */
  @Post(':id/lines')
  createLine(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CreateWarehouseLineSchema))
    dto: CreateWarehouseLineDto,
  ): Promise<CreateWarehouseLineResultDto> {
    return this.warehouses.createLine(id, dto);
  }

  /**
   * Массовая печать «Печать всех ячеек» (см. `docs/api.md §15`,
   * `docs/screens.md §10b`).
   *
   * Контракт:
   *   - `printerId` — обязательно (явный выбор менеджера в UI).
   *   - `copies`    — int ≥ 1, default 1.
   *   - `labelSize` — пока только `38x58` (есть один template).
   *
   * Создаёт `cellsCount × copies` PENDING-job-ов с `sourceType=CELL_LABEL`,
   * по одному на каждую копию каждой активной ячейки склада. Агент
   * рядом с принтером заберёт очередь FIFO и распечатает HTML 38×58.
   *
   * Ошибки:
   *   - 404 `WAREHOUSE_NOT_FOUND`         — склада с таким `:id` нет;
   *   - 404 `PRINTER_NOT_FOUND`           — `printerId` не существует;
   *   - 409 `PRINTER_INACTIVE`            — принтер деактивирован;
   *   - 409 `WAREHOUSE_NO_CELLS_TO_PRINT` — на складе нет активных ячеек.
   */
  @Post(':id/print-cells')
  printCells(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PrintWarehouseCellsSchema))
    dto: PrintWarehouseCellsDto,
    @Req() req: Request,
  ): Promise<PrintWarehouseCellsResultDto> {
    const apiBaseUrl = resolvePublicApiBaseUrl(req);
    return this.warehouses.printAllCells(id, dto, apiBaseUrl);
  }
}
