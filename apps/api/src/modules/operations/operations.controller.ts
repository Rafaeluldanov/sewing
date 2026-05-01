import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateOperationSchema,
  UpdateOperationSchema,
  type CreateOperationDto,
  type OperationDetailDto,
  type OperationSummaryDto,
  type UpdateOperationDto,
} from '@sewing/shared/operations';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { OperationsService } from './operations.service.js';

/**
 * Управление операциями (см. `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Доступ — только `ADMIN` и `SHOP_MANAGER`. Это управленческий
 * раздел: сдельные ставки задаются здесь, и рабочие роли сюда не
 * ходят. Backend режет любые рабочие роли через `@Roles(...)`,
 * фронт дополнительно скрывает пункт меню (`canSeeAdmin` в
 * `apps/web/lib/rbac.ts`).
 *
 * Перечень операций для сменного flow (`/work`, `EquipmentService`)
 * остаётся прежним — он читает `Operation.active = true` через
 * собственные сервисы и не зависит от этого контроллера.
 */
@Controller('operations')
@Roles('SHOP_MANAGER', 'ADMIN')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  list(): Promise<OperationSummaryDto[]> {
    return this.operations.list();
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(CreateOperationSchema))
    dto: CreateOperationDto,
  ): Promise<OperationDetailDto> {
    return this.operations.create(dto);
  }

  @Get(':id')
  getOne(@Param('id') id: string): Promise<OperationDetailDto> {
    return this.operations.getOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateOperationSchema))
    dto: UpdateOperationDto,
  ): Promise<OperationDetailDto> {
    return this.operations.update(id, dto);
  }
}
