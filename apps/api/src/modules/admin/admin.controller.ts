import { Controller, Get } from '@nestjs/common';
import type { AdminOverviewDto } from '@sewing/shared/admin';
import { Roles } from '../auth/auth.decorators.js';
import { AdminService } from './admin.service.js';

/**
 * Admin / monitoring (Шаг 12 — Pilot Rollout / Bugfix Sprint).
 *
 *   GET /api/admin/overview
 *
 * Лёгкий операционный обзор для начальника цеха. См. контракт в
 * `docs/api.md §11a` и UI в `apps/web/app/admin/overview`.
 */
@Roles('SHOP_MANAGER', 'ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview(): Promise<AdminOverviewDto> {
    return this.admin.getOverview();
  }
}
