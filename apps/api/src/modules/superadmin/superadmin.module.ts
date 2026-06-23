import { Module } from '@nestjs/common';
import { SuperadminController } from './superadmin.controller.js';
import { SuperadminService } from './superadmin.service.js';
import { SuperadminGuard } from './superadmin.guard.js';

/**
 * Панель супер-админа control-plane (мультитенантность, Фаза 4).
 * `ControlPlaneService` / `TenantRegistry` берутся из @Global `PrismaModule`.
 */
@Module({
  controllers: [SuperadminController],
  providers: [SuperadminService, SuperadminGuard],
})
export class SuperadminModule {}
