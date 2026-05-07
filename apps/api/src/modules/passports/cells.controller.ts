import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as QRCode from 'qrcode';
import { z } from 'zod';
import {
  UpdateCellSchema,
  type UpdateCellDto,
} from '@sewing/shared/warehouses';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Public, Roles } from '../auth/auth.decorators.js';
import { WarehousesService } from '../warehouses/warehouses.service.js';
import { PassportsService } from './passports.service.js';
import { renderCellPrintHtml } from './cell-print.js';
import { buildCellQrPayload } from './qr.js';

/**
 * Query DTO `GET /api/cells`. Single optional поле `warehouseId` —
 * additive фильтр, чтобы UI формы «Переместить» получал только ячейки
 * выбранного склада (см.
 * `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`).
 * Историческое поведение (без query → все активные ячейки) не
 * меняется.
 */
const ListCellsQuerySchema = z
  .object({
    warehouseId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
type ListCellsQuery = z.infer<typeof ListCellsQuerySchema>;

/**
 * Резолв ячейки по произвольному коду (QR `cell:{id}`, человекочитаемый
 * `code` вроде `A-01`, или голый `id`). Используется на /work в
 * shelf-placement flow для CUTTER_ASSISTANT (см. `docs/flows.md §F3b`):
 * сначала помощник сканирует ячейку, мы отдаём её карточку под
 * confirm-модалку, и только после подтверждения переходим к сканированию
 * паспортов. Backend = источник истины: проверяем `active`, отдаём
 * нормализованный `CellDetailDto`.
 */
const CellByCodeSchema = z.object({
  code: z.string().trim().min(1, 'Код ячейки обязателен').max(128),
});
type CellByCodeDto = z.infer<typeof CellByCodeSchema>;

/**
 * Минимальный read-only контракт по ячейкам, нужный форме размещения
 * паспорта (Шаг 5) и shelf-placement flow помощника раскройщика
 * (Шаг 13.3). CRUD ячеек / `place` / `remove` сами по себе
 * (см. `docs/api.md §7`) — за рамками этих шагов.
 */
@Controller('cells')
export class CellsController {
  constructor(
    private readonly passports: PassportsService,
    private readonly warehouses: WarehousesService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListCellsQuerySchema)) query: ListCellsQuery,
  ) {
    return this.passports.listCells({ warehouseId: query.warehouseId });
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.passports.getCell(id);
  }

  /**
   * Резолв ячейки по произвольному коду — без побочных эффектов.
   * Симметрично `POST /api/passports/by-code` (см. ADR-0008).
   */
  @Post('by-code')
  byCode(
    @Body(new ZodValidationPipe(CellByCodeSchema)) dto: CellByCodeDto,
  ) {
    return this.passports.findCellByCode(dto.code);
  }

  /**
   * Точечное обновление ячейки. На MVP единственное поддерживаемое
   * поле — `warehouseId`: привязка к складу или сброс (`null`). См.
   * `docs/api.md §15`, `docs/domain.md §16`. Доступ — только
   * `ADMIN`/`SHOP_MANAGER`: это управленческое действие.
   */
  @Patch(':id')
  @Roles('SHOP_MANAGER', 'ADMIN')
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCellSchema)) dto: UpdateCellDto,
  ) {
    if (dto.warehouseId !== undefined) {
      await this.warehouses.setCellWarehouse(id, dto.warehouseId);
    }
    return this.passports.getCell(id);
  }

  /**
   * Печатная форма QR-этикетки ячейки (HTML A6, тот же подход, что у
   * `/api/passports/:id/print` и `/api/equipment/:id/print` — см.
   * ADR-0010). QR-payload `cell:{id}` (ADR-0008) не меняется —
   * `POST /api/cells/by-code` и shelf-placement flow работают как
   * раньше.
   *
   * `@Public()`: принтер-станция в типографии может работать без
   * сессии — той же моделью, что у equipment/паспорта.
   */
  @Public()
  @Get(':id/print')
  @Header('content-type', 'text/html; charset=utf-8')
  async print(@Param('id') id: string): Promise<string> {
    const cell = await this.passports.getCell(id);
    const qrDataUrl = await QRCode.toDataURL(buildCellQrPayload(id), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    return renderCellPrintHtml({ cell, qrDataUrl });
  }

  /** PNG QR-кода ячейки в формате `cell:{id}` (ADR-0008). */
  @Public()
  @Get(':id/qr')
  async qr(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.passports.getCell(id);
    const buf = await QRCode.toBuffer(buildCellQrPayload(id), {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      type: 'png',
    });
    res
      .status(200)
      .setHeader('content-type', 'image/png')
      .setHeader('cache-control', 'public, max-age=300')
      .send(buf);
  }
}
