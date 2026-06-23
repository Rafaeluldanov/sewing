import { Injectable, Logger } from '@nestjs/common';
import { ControlPlaneService } from './control-plane.service.js';
import type { TenantInfo } from './tenant.types.js';

interface CacheEntry {
  tenant: TenantInfo | null;
  expiresAt: number;
}

/**
 * Реестр тенантов: резолвит входящий Host → `TenantInfo` (id + dbUrl) и
 * отдаёт дефолтного тенанта для boot-задач вне запроса.
 *
 * ДВА РЕЖИМА:
 *   - control-plane ВЫКЛЮЧЕН (нет CONTROL_PLANE_DATABASE_URL) — single-tenant:
 *     любой Host → дефолтный тенант (dbUrl = DATABASE_URL). Поведение как в
 *     Фазе 0/1.
 *   - control-plane ВКЛЮЧЁН — резолв по таблице `TenantDomain` control-plane
 *     БД (с in-memory кэшем и TTL), неизвестный Host → `null` (404 в
 *     middleware). dbUrl берётся из `Tenant.dbUrl`.
 */
@Injectable()
export class TenantRegistry {
  private readonly logger = new Logger(TenantRegistry.name);
  private readonly defaultTenant: TenantInfo;
  private readonly cache = new Map<string, CacheEntry>();
  // Потолок записей кэша: Host приходит от клиента (Host/x-tenant-host), и без
  // лимита поток уникальных хостов рос бы Map без конца (память + нагрузка на
  // control-plane). LRU-вытеснение по порядку вставки.
  private readonly cacheMax = Number(
    process.env.TENANT_RESOLVE_CACHE_MAX ?? 1000,
  );
  // NaN-защита: кривое значение env (напр. «30s») иначе давало бы expiresAt=NaN
  // и кэш молча отключался бы (промах на каждом запросе).
  private readonly cacheTtlMs = (() => {
    const t = Number(process.env.TENANT_RESOLVE_CACHE_TTL_MS ?? 30_000);
    return Number.isFinite(t) && t >= 0 ? t : 30_000;
  })();

  constructor(private readonly controlPlane: ControlPlaneService) {
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
      `event=tenant.registry.init mode=${this.controlPlane.isEnabled() ? 'control-plane' : 'single-tenant'} default=${this.defaultTenant.slug}`,
    );
  }

  /** Дефолтный тенант — для boot-хуков (сид справочников) и single-tenant. */
  getDefault(): TenantInfo {
    return this.defaultTenant;
  }

  /**
   * Резолв тенанта по Host.
   *   - single-tenant: всегда дефолтный тенант;
   *   - control-plane: lookup в `TenantDomain` (кэш TTL), `null` если хост
   *     неизвестен или тенант не ACTIVE.
   */
  async resolveByHost(host: string | undefined): Promise<TenantInfo | null> {
    if (!this.controlPlane.isEnabled()) return this.defaultTenant;

    const key = this.normalizeHost(host);
    if (!key) return null;

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      // LRU-touch: переставляем в конец как most-recently-used.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.tenant;
    }

    const tenant = await this.lookupByHost(key);
    // Негативный результат (неизвестный/неактивный хост) кэшируем коротко,
    // чтобы только что заведённый тенант стал виден быстро; позитивный — на TTL.
    const ttl = tenant ? this.cacheTtlMs : Math.min(this.cacheTtlMs, 5_000);
    this.cache.set(key, { tenant, expiresAt: Date.now() + ttl });
    this.evictCache();
    return tenant;
  }

  /** LRU-вытеснение записей кэша резолва сверх `cacheMax` (по порядку вставки). */
  private evictCache(): void {
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** Список активных тенантов — для оркестратора миграций (скрипты). */
  async list(): Promise<TenantInfo[]> {
    if (!this.controlPlane.isEnabled()) return [this.defaultTenant];
    const tenants = await this.controlPlane.client.tenant.findMany({
      where: { status: 'ACTIVE' },
    });
    return tenants.map((t) => ({ id: t.id, slug: t.slug, dbUrl: t.dbUrl }));
  }

  private async lookupByHost(host: string): Promise<TenantInfo | null> {
    const domain = await this.controlPlane.client.tenantDomain.findUnique({
      where: { host },
      include: { tenant: true },
    });
    if (!domain || domain.tenant.status !== 'ACTIVE') {
      return null;
    }
    return {
      id: domain.tenant.id,
      slug: domain.tenant.slug,
      dbUrl: domain.tenant.dbUrl,
    };
  }

  /** Срезаем порт и приводим к нижнему регистру: `Crm1.Teeon.ru:443` → `crm1.teeon.ru`. */
  private normalizeHost(host: string | undefined): string | null {
    if (!host) return null;
    const stripped = host.split(':')[0]?.trim().toLowerCase();
    return stripped && stripped.length > 0 ? stripped : null;
  }
}
