import { Injectable, Logger } from '@nestjs/common';
import type { TenantInfo } from './tenant.types.js';

/**
 * Реестр тенантов: резолвит входящий Host → `TenantInfo` (id + dbUrl),
 * и отдаёт дефолтного тенанта для boot-задач вне запроса.
 *
 * ФАЗА 0 (этот файл): ровно один тенант, его `dbUrl = DATABASE_URL`.
 * Любой Host резолвится в него ⇒ поведение системы не меняется.
 *
 * ФАЗА 2: реализация переедет на control-plane БД (таблицы
 * `Tenant` / `TenantDomain`), а сигнатуры (`resolveByHost` / `getDefault`
 * / `list`) останутся теми же — потребители (middleware, bootstrap) не
 * меняются. Тогда же `resolveByHost` начнёт возвращать `null` на
 * неизвестный Host (→ 404 в middleware).
 */
@Injectable()
export class TenantRegistry {
  private readonly logger = new Logger(TenantRegistry.name);
  private readonly defaultTenant: TenantInfo;

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error(
        'DATABASE_URL не задан — TenantRegistry не может определить дефолтного тенанта',
      );
    }
    this.defaultTenant = {
      id: process.env.DEFAULT_TENANT_ID ?? 'default',
      slug: process.env.DEFAULT_TENANT_SLUG ?? 'default',
      dbUrl,
    };
    this.logger.log(
      `event=tenant.registry.init mode=single-tenant default=${this.defaultTenant.slug}`,
    );
  }

  /** Дефолтный тенант — для boot-хуков и фолбэка в Фазе 0. */
  getDefault(): TenantInfo {
    return this.defaultTenant;
  }

  /**
   * Резолв тенанта по Host. Фаза 0: всегда дефолтный тенант.
   * Возвращает `null`, если Host неизвестен (в Фазе 0 не случается).
   */
  resolveByHost(_host: string | undefined): TenantInfo | null {
    return this.defaultTenant;
  }

  /** Список всех тенантов — для оркестратора миграций (Фаза 2). */
  list(): TenantInfo[] {
    return [this.defaultTenant];
  }
}
