import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateCompanyDivisionSchema,
  ListCompanyDivisionsQuerySchema,
  UpdateCompanyDivisionSchema,
  type CreateCompanyDivisionDto,
  type ListCompanyDivisionsQuery,
  type UpdateCompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { CurrentUser, MachineScopes, Roles } from '../auth/auth.decorators.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { CompanyDivisionsService } from './company-divisions.service.js';

/**
 * Контроллер блока «Подразделения компании» (управленческий
 * справочник, см. `prisma/schema.prisma::CompanyDivision`).
 *
 *   GET   /api/company-divisions       — список (по умолчанию активные)
 *   POST  /api/company-divisions       — создание новой карточки
 *   GET   /api/company-divisions/:id   — карточка
 *   PATCH /api/company-divisions/:id   — правка (включая мягкое
 *                                         отключение через
 *                                         `isActive = false`)
 *
 * RBAC — `SHOP_MANAGER` / `ADMIN`. Hard-delete out-of-scope.
 *
 * **Не путать** с `enum OrderDivision` (`MARKETPLACE` / `OTHER`):
 * `CompanyDivision` — структурное подразделение компании, ось,
 * независимая от заказов и shopfloor-display.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('company-divisions')
@MachineScopes('settings:read')
export class CompanyDivisionsController {
  constructor(private readonly divisions: CompanyDivisionsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(ListCompanyDivisionsQuerySchema))
    query: ListCompanyDivisionsQuery,
  ) {
    return this.divisions.list(query);
  }

  @MachineScopes('settings:write')
  @Post()
  create(
    @Body(new ZodValidationPipe(CreateCompanyDivisionSchema))
    body: CreateCompanyDivisionDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.divisions.create(body, user.employeeId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.divisions.get(id);
  }

  @MachineScopes('settings:write')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateCompanyDivisionSchema))
    body: UpdateCompanyDivisionDto,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.divisions.update(id, body, user.employeeId);
  }
}
