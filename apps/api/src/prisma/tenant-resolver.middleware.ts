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
    const host = req.headers.host;
    const tenant = this.registry.resolveByHost(host);
    if (!tenant) {
      this.logger.warn(`event=tenant.unknown host=${host ?? '(none)'}`);
      res.status(404).json({ error: 'UNKNOWN_TENANT', host: host ?? null });
      return;
    }
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
