import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ListEmployeesQuerySchema,
  UpdateEmployeeSchema,
  type ListEmployeesQuery,
  type UpdateEmployeeDto,
} from '@sewing/shared/employees';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { Roles } from '../auth/auth.decorators.js';
import { EmployeesService } from './employees.service.js';

/**
 * Контроллер блока «Сотрудники» (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 *   GET   /api/employees          — список (фильтры active/role/comp/search)
 *   GET   /api/employees/:id      — карточка
 *   PATCH /api/employees/:id      — правка management-полей
 *
 * Доступ — только `SHOP_MANAGER` и `ADMIN`. Информация о сотрудниках
 * (логин, ставка, тип оплаты) чувствительна — обычный сотрудник видит
 * только себя через `/api/auth/me`. Никакого «view другого сотрудника»
 * для рабочих ролей не предусмотрено.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListEmployeesQuerySchema))
    query: ListEmployeesQuery,
  ) {
    return this.employees.list(query);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.employees.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateEmployeeSchema))
    body: UpdateEmployeeDto,
  ) {
    return this.employees.update(id, body);
  }
}
