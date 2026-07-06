import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PrismaClientManager } from './prisma-client-manager.js';
import { TenantContext } from './tenant-context.js';
import { TenantRegistry } from './tenant-registry.service.js';

/**
 * Резолвит тенанта по `Host` и устанавливает `TenantContext` на всё время
 * обработки запроса. Подключается в `PrismaModule.configure` на все маршруты,
 * выполняется до контроллеров/гардов/сервисов.
 *
 * Поток:
 *   1) Host → `TenantRegistry.resolveByHost` → `TenantInfo` (или 404).
 *   2) `PrismaClientManager.ensureClient` — подготовить (подключить +
 *      инварианты) клиент тенанта ДО обработчика, чтобы Proxy-доступ был
 *      синхронным.
 *   3) `TenantContext.run(...)` оборачивает `next()` — контекст виден во
 *      всей async-цепочке запроса.
 *
 * ФАЗА 0: `resolveByHost` всегда возвращает дефолтного тенанта ⇒ поведение
 * не меняется. В Фазе 2 неизвестный Host даст 404 `UNKNOWN_TENANT`.
 */
@Injectable()
export class TenantResolverMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantResolverMiddleware.name);

  constructor(
    private readonly registry: TenantRegistry,
    private readonly manager: PrismaClientManager,
    private readonly context: TenantContext,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Liveness (`/api/health`) НЕ должен зависеть от резолва тенанта — контракт
    // «всегда 200, если процесс жив» (health.controller, nginx/docker liveness,
    // deploy-stage health-gate). Под control-plane неизвестный Host иначе дал бы
    // 404. `/ready` сознательно НЕ исключаем: он проверяет БД и требует тенанта.
    if (req.path === '/health' || req.path.endsWith('/health')) {
      next();
      return;
    }
    // Приоритет у `x-tenant-host`: web проксирует SSR-запросы на api с
    // собственным Host (`api:3001`), поэтому пользовательский домен он
    // форвардит явным заголовком (см. apps/web/lib/api.ts). Прямые вызовы
    // (curl/healthcheck) используют обычный Host.
    const forwarded = req.headers['x-tenant-host'];
    const host =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.headers.host;
    const resolution = await this.registry.resolveByHost(host);
    // Приостановленный тенант ≠ неизвестный хост: web показывает по этим ответам
    // разные заглушки. Тело несёт и `error` (историческая форма), и
    // `code`/`message` — чтобы клиентский `apiFetch` подхватил понятный текст.
    if (resolution.outcome === 'suspended') {
      this.logger.warn(`event=tenant.suspended host=${host ?? '(none)'}`);
      res.status(403).json({
        statusCode: 403,
        error: 'TENANT_SUSPENDED',
        code: 'TENANT_SUSPENDED',
        message: 'Рабочее пространство приостановлено',
        host: host ?? null,
      });
      return;
    }
    if (resolution.outcome === 'unknown') {
      this.logger.warn(`event=tenant.unknown host=${host ?? '(none)'}`);
      res.status(404).json({
        statusCode: 404,
        error: 'UNKNOWN_TENANT',
        code: 'UNKNOWN_TENANT',
        message: 'Рабочее пространство не найдено',
        host: host ?? null,
      });
      return;
    }
    const tenant = resolution.tenant;
    try {
      await this.manager.ensureClient(tenant);
    } catch (err) {
      this.logger.error(
        `event=tenant.client.ensure_failed tenant=${tenant.slug}: ${(err as Error).message}`,
      );
      res.status(503).json({ error: 'TENANT_DB_UNAVAILABLE' });
      return;
    }
    this.context.run({ tenantId: tenant.id, slug: tenant.slug }, () => next());
  }
}
