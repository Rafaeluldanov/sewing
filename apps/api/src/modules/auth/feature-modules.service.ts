import { Injectable } from '@nestjs/common';
import {
  FEATURE_MODULE_KEYS,
  isModuleEnabledValue,
  type FeatureModuleKey,
  type ModuleFlags,
} from '@sewing/shared/auth';

/** Имя env-переменной API для каждого модуля (Фаза 1, runtime-источник). */
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
 * ФАЗА 1 (этот файл): источник — runtime-env API (`FEATURE_*`), договор
 * default-on (`isModuleEnabledValue`). Ключевое отличие от прежней схемы:
 * флаги больше НЕ зашиты в web-билд (`NEXT_PUBLIC_FEATURE_*`), а приходят
 * с сервера в рантайме через `/api/auth/me`. Один web-билд обслуживает
 * тенантов с разным набором модулей.
 *
 * ФАЗА 2: источник сменится на control-plane (таблица `TenantModule`),
 * ключом станет `TenantContext.requireTenantId()`. Сигнатура `resolve()`
 * для потребителей (auth.controller) при этом не изменится.
 */
@Injectable()
export class FeatureModulesService {
  resolve(): ModuleFlags {
    const flags = {} as ModuleFlags;
    for (const key of FEATURE_MODULE_KEYS) {
      flags[key] = isModuleEnabledValue(process.env[ENV_BY_KEY[key]]);
    }
    return flags;
  }
}
