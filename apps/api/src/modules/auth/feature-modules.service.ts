import { Injectable } from '@nestjs/common';
import {
  FEATURE_MODULE_KEYS,
  isModuleEnabledValue,
  type FeatureModuleKey,
  type ModuleFlags,
} from '@sewing/shared/auth';
import { ControlPlaneService } from '../../prisma/control-plane.service.js';
import { TenantContext } from '../../prisma/tenant-context.js';

/** Имя env-переменной API для каждого модуля (single-tenant fallback). */
const ENV_BY_KEY: Record<FeatureModuleKey, string> = {
  patterns: 'FEATURE_PATTERNS',
  workshopNeeds: 'FEATURE_WORKSHOP_NEEDS',
  suppliers: 'FEATURE_SUPPLIERS',
  purchaseOrders: 'FEATURE_PURCHASE_ORDERS',
  purchaseReceipts: 'FEATURE_PURCHASE_RECEIPTS',
  treasury: 'FEATURE_TREASURY',
};

/**
 * Резолвер включённых модулей для текущего тенанта.
 *
 *   - control-plane ВКЛЮЧЁН — источник истины таблица `TenantModule`
 *     (ключ — `TenantContext.requireTenantId()`); отсутствие строки =
 *     default-on. Так у каждого тенанта свой набор модулей.
 *   - control-plane ВЫКЛЮЧЕН — single-tenant fallback: runtime-env API
 *     (`FEATURE_*`), договор default-on (`isModuleEnabledValue`).
 *
 * В обоих случаях набор отдаётся фронту через `GET /api/auth/me` (поле
 * `modules`), а не зашивается в web-билд.
 */
@Injectable()
export class FeatureModulesService {
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly tenantContext: TenantContext,
  ) {}

  async resolve(): Promise<ModuleFlags> {
    if (!this.controlPlane.isEnabled()) {
      return this.fromEnv();
    }
    const tenantId = this.tenantContext.requireTenantId();
    const rows = await this.controlPlane.client.tenantModule.findMany({
      where: { tenantId },
    });
    const overrides = new Map(rows.map((r) => [r.moduleKey, r.enabled]));
    const flags = {} as ModuleFlags;
    for (const key of FEATURE_MODULE_KEYS) {
      // default-on: нет строки в TenantModule → модуль включён.
      flags[key] = overrides.has(key) ? Boolean(overrides.get(key)) : true;
    }
    return flags;
  }

  private fromEnv(): ModuleFlags {
    const flags = {} as ModuleFlags;
    for (const key of FEATURE_MODULE_KEYS) {
      flags[key] = isModuleEnabledValue(process.env[ENV_BY_KEY[key]]);
    }
    return flags;
  }
}
