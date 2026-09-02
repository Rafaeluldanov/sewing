import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateEquipmentSchema,
  UpdateEquipmentOperationsSchema,
  UpdateEquipmentSchema,
  type CreateEquipmentDto,
  type EquipmentDetailDto,
  type EquipmentSummaryDto,
  type UpdateEquipmentDto,
  type UpdateEquipmentOperationsDto,
} from '@sewing/shared/equipment';
import * as QRCode from 'qrcode';
import {
  BulkArchiveRequestSchema,
  type BulkArchiveRequestDto,
  type BulkArchiveResultDto,
} from '@sewing/shared/archive';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { EquipmentService } from './equipment.service.js';
import { renderEquipmentPrintHtml } from './equipment-print.js';

/**
 * Управление каталогом оборудования и его разрешённых операций
 * (см. ADR-0017, `docs/api.md §3a`).
 *
 * Доступ:
 *   - GET (list/detail) — `ADMIN`, `SHOP_MANAGER`. Это admin/manager
 *     surface для настройки. Старый /work-flow читает оборудование
 *     через `GET /api/shifts/meta` (уже расширенный
 *     `allowedOperationIds`), и там RBAC не нужен — meta открыта
 *     любой авторизованной роли.
 *   - PATCH `/operations` и PATCH `/` — те же роли (`ADMIN`,
 *     `SHOP_MANAGER`).
 *   - GET `/print` и GET `/qr` — `@Public()`, чтобы принтер-станция
 *     могла отпечатать QR-этикетку без сессии (та же модель, что у
 *     `/api/passports/:id/print` и `/api/packing/boxes/:id/label`).
 *
 * Ошибки:
 *   - `EQUIPMENT_NOT_FOUND` (404) — некорректный `id`.
 *   - `OPERATION_NOT_FOUND` (404) — один из `operationIds` не существует.
 *   - `VALIDATION_ERROR` (400) — Zod (дубликаты в `operationIds`,
 *     слишком длинный список, длинный `displayNumber` и т.п.).
 */
@Controller('equipment')
@Roles('SHOP_MANAGER', 'ADMIN')
export class EquipmentController {
  constructor(private readonly equipment: EquipmentService) {}

  @MachineScopes('equipment:read')
  @Get()
  list(): Promise<EquipmentSummaryDto[]> {
    return this.equipment.list();
  }

  /**
   * Создание новой единицы оборудования из `/admin/equipment`.
   * См. `docs/api.md §3a`, `docs/screens.md §10a`. `code` опционален —
   * backend сгенерирует slug имени, чтобы менеджер не придумывал
   * технический идентификатор.
   */
  @MachineScopes('equipment:write')
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateEquipmentSchema)) dto: CreateEquipmentDto,
  ): Promise<EquipmentDetailDto> {
    return this.equipment.create(dto);
  }

  /**
   * Массовые операции архива со списка `/admin/equipment` (контракт —
   * `@sewing/shared/archive`): `active = false` → обратно → удалить
   * навсегда (только из архива и только если у станка нет истории —
   * смен, событий паспортов, вызовов мастера).
   *
   * Объявлены ДО `@Get(':id')` для читаемости; конфликта нет —
   * одноимённого `@Post(':id')` в контроллере не существует.
   */
  @MachineScopes('equipment:write')
  @Post('archive')
  @Roles('ADMIN', 'SHOP_MANAGER')
  archiveMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.equipment.archiveMany(dto.ids, user.employeeId);
  }

  @MachineScopes('equipment:write')
  @Post('restore')
  @Roles('ADMIN', 'SHOP_MANAGER')
  restoreMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.equipment.restoreMany(dto.ids, user.employeeId);
  }

  @Post('purge')
  @Roles('ADMIN', 'SHOP_MANAGER')
  purgeMany(
    @Body(new ZodValidationPipe(BulkArchiveRequestSchema))
    dto: BulkArchiveRequestDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<BulkArchiveResultDto> {
    return this.equipment.purgeMany(dto.ids, user.employeeId);
  }

  @MachineScopes('equipment:read')
  @Get(':id')
  getOne(@Param('id') id: string): Promise<EquipmentDetailDto> {
    return this.equipment.getOne(id);
  }

  @MachineScopes('equipment:write')
  @Patch(':id/operations')
  updateOperations(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEquipmentOperationsSchema))
    dto: UpdateEquipmentOperationsDto,
  ): Promise<EquipmentDetailDto> {
    return this.equipment.updateOperations(id, dto.operationIds);
  }

  /**
   * Точечное обновление карточки оборудования. Принимает `name`
   * (переименование) и/или `displayNumber` (ручной порядковый номер
   * для физической маркировки). См. `UpdateEquipmentSchema` и ADR-0017 §5.
   */
  @MachineScopes('equipment:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEquipmentSchema)) dto: UpdateEquipmentDto,
  ): Promise<EquipmentDetailDto> {
    return this.equipment.update(id, dto);
  }

  /**
   * HTML-этикетка с QR-кодом оборудования и крупно отрисованным
   * `displayNumber`. Печать через системный диалог браузера
   * (см. ADR-0010). QR кодирует `equipment:{id}` (ADR-0008) — формат
   * не меняется, scan flow на /work остаётся совместимым.
   */
  @Public()
  @Get(':id/print')
  @Header('content-type', 'text/html; charset=utf-8')
  async print(@Param('id') id: string): Promise<string> {
    const equipment = await this.equipment.getOne(id);
    const qrDataUrl = await QRCode.toDataURL(`equipment:${id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    return renderEquipmentPrintHtml({ equipment, qrDataUrl });
  }

  /**
   * PNG QR-кода оборудования (`equipment:{id}` по ADR-0008). Полезно
   * для интеграций и для встраивания QR в произвольные печатные формы.
   */
  @Public()
  @Get(':id/qr')
  async qr(@Param('id') id: string, @Res() res: Response): Promise<void> {
    await this.equipment.getOne(id);
    const buf = await QRCode.toBuffer(`equipment:${id}`, {
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
