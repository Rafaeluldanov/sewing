import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  CreateMaterialCharacteristicOptionSchema,
  ListMaterialCharacteristicOptionsQuerySchema,
  type CreateMaterialCharacteristicOptionDto,
  type ListMaterialCharacteristicOptionsQuery,
  type MaterialCharacteristicOptionDto,
} from '@sewing/shared/material-characteristic-options';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineClosed, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { MaterialCharacteristicOptionsService } from './material-characteristic-options.service.js';

/**
 * `/api/material-characteristic-options` — справочник значений поля
 * «Характеристика» строки материала техкарты.
 *
 *   GET    /                — список (встроенные + пользовательские);
 *   POST   /                — добавить своё значение (идемпотентно);
 *   DELETE /:id             — убрать своё значение из списка.
 *
 * RBAC — `ADMIN`/`SHOP_MANAGER` на всё, включая чтение: справочник нужен
 * ровно там, где правят техкарту (форма шаблона и спецификация заказа), а
 * оба экрана и так под этими ролями. Расширять чтение «всем авторизованным»
 * будем, когда появится читающий экран под другой ролью.
 */
@Roles('ADMIN', 'SHOP_MANAGER')
@Controller('material-characteristic-options')
@MachineScopes('patterns:read')
export class MaterialCharacteristicOptionsController {
  constructor(
    private readonly options: MaterialCharacteristicOptionsService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListMaterialCharacteristicOptionsQuerySchema))
    query: ListMaterialCharacteristicOptionsQuery,
  ): Promise<MaterialCharacteristicOptionDto[]> {
    return this.options.list(query);
  }

  @MachineClosed()
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateMaterialCharacteristicOptionSchema))
    body: CreateMaterialCharacteristicOptionDto,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<MaterialCharacteristicOptionDto> {
    return this.options.create(body, user.employeeId);
  }

  @MachineClosed()
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<{ ok: true }> {
    await this.options.remove(id, user.employeeId);
    return { ok: true };
  }
}
