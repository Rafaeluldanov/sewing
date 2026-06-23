import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AddDomainSchema,
  CreateTenantSchema,
  SetModuleSchema,
  SetStatusSchema,
  type AddDomainDto,
  type CreateTenantDto,
  type SetModuleDto,
  type SetStatusDto,
} from '@sewing/shared/superadmin';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import { SuperadminGuard } from './superadmin.guard.js';
import { SuperadminService } from './superadmin.service.js';

/**
 * Панель супер-админа control-plane: `/api/superadmin/*`.
 * Защищён `SuperadminGuard` (роль SUPERADMIN, НЕ обычный ADMIN; control-plane
 * обязан быть включён). Работает с реестром тенантов, не с данными тенанта.
 */
@UseGuards(SuperadminGuard)
@Controller('superadmin')
export class SuperadminController {
  constructor(private readonly superadmin: SuperadminService) {}

  @Get('tenants')
  list() {
    return this.superadmin.listTenants();
  }

  @Get('tenants/:id')
  get(@Param('id') id: string) {
    return this.superadmin.getTenant(id);
  }

  @Post('tenants')
  create(
    @Body(new ZodValidationPipe(CreateTenantSchema)) body: CreateTenantDto,
  ) {
    return this.superadmin.createTenant(body);
  }

  @Post('tenants/:id/modules')
  setModule(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetModuleSchema)) body: SetModuleDto,
  ) {
    return this.superadmin.setModule(id, body);
  }

  @Post('tenants/:id/status')
  setStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SetStatusSchema)) body: SetStatusDto,
  ) {
    return this.superadmin.setStatus(id, body);
  }

  @Post('tenants/:id/domains')
  addDomain(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AddDomainSchema)) body: AddDomainDto,
  ) {
    return this.superadmin.addDomain(id, body);
  }

  @Delete('tenants/:id/domains/:domainId')
  removeDomain(
    @Param('id') id: string,
    @Param('domainId') domainId: string,
  ) {
    return this.superadmin.removeDomain(id, domainId);
  }
}
