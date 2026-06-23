import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { TenantInfo } from './tenant.types.js';

const DEFAULT_CACHE_MAX = 25;
const DEFAULT_CONNECTION_LIMIT = 5;

/**
 * LRU-пул `PrismaClient` по тенанту (DB-per-tenant).
 *
 * Каждый тенант — отдельная БД (отдельный connection string), поэтому на
 * тенанта свой клиент. Создание клиента + `$connect` дороги, поэтому
 * клиенты кэшируются, вытесняются по LRU при превышении `cacheMax` и
 * дисконнектятся при вытеснении / остановке модуля.
 *
 * КОННЕКТЫ (риск №2 плана мультитенантности): каждый клиент держит свой
 * пул коннектов к Postgres; N_тенантов × connection_limit не должно
 * превышать `max_connections`. Лимит на клиента задаётся в URL
 * (`?connection_limit=...`). При росте числа тенантов — PgBouncer.
 *
 * ИНВАРИАНТЫ: partial unique indexes, которые нельзя выразить в
 * `schema.prisma` (нет `@@unique(where:)`), раньше применялись в
 * `PrismaService.onModuleInit`. Теперь — на тенанта при первом
 * подключении (идемпотентно). В Фазе 2 переедут в оркестратор миграций
 * (применять на provision/migrate deploy, а не лениво).
 */
@Injectable()
export class PrismaClientManager implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaClientManager.name);
  /** Map сохраняет порядок вставки → используем его как LRU. */
  private readonly clients = new Map<string, PrismaClient>();
  private readonly invariantsApplied = new Set<string>();
  private readonly cacheMax = Number(
    process.env.TENANT_CLIENT_CACHE_MAX ?? DEFAULT_CACHE_MAX,
  );

  /**
   * Идемпотентно вернуть ГОТОВЫЙ (подключённый, с применёнными
   * инвариантами) клиент тенанта. Вызывается в middleware ДО обработчика,
   * чтобы `getReadyClient` в Proxy оставался синхронным.
   */
  async ensureClient(tenant: TenantInfo): Promise<PrismaClient> {
    const cached = this.touch(tenant.id);
    if (cached) return cached;

    const client = new PrismaClient({
      datasources: { db: { url: this.withConnectionLimit(tenant.dbUrl) } },
    });
    await client.$connect();
    this.clients.set(tenant.id, client);
    this.evictIfNeeded();
    await this.applyInvariants(tenant.id, client);
    this.logger.log(
      `event=tenant.client.created tenant=${tenant.slug} cache.size=${this.clients.size}`,
    );
    return client;
  }

  /** Синхронный доступ к уже подготовленному клиенту. Бросает, если не ensure-нут. */
  getReadyClient(tenantId: string): PrismaClient {
    const client = this.touch(tenantId);
    if (!client) {
      throw new Error(
        `PrismaClient тенанта '${tenantId}' не подготовлен. ` +
          'ensureClient(...) должен вызываться в TenantResolverMiddleware ' +
          'до обработчика запроса.',
      );
    }
    return client;
  }

  /** LRU-touch: переставить ключ в конец (most-recently-used). */
  private touch(tenantId: string): PrismaClient | undefined {
    const client = this.clients.get(tenantId);
    if (client) {
      this.clients.delete(tenantId);
      this.clients.set(tenantId, client);
    }
    return client;
  }

  private evictIfNeeded(): void {
    while (this.clients.size > this.cacheMax) {
      const oldestId = this.clients.keys().next().value as string | undefined;
      if (!oldestId) break;
      const victim = this.clients.get(oldestId);
      this.clients.delete(oldestId);
      this.invariantsApplied.delete(oldestId);
      if (victim) {
        void victim.$disconnect().catch((err) =>
          this.logger.warn(
            `Ошибка disconnect вытесненного клиента ${oldestId}: ${(err as Error).message}`,
          ),
        );
      }
      this.logger.log(`event=tenant.client.evicted tenant=${oldestId}`);
    }
  }

  private withConnectionLimit(url: string): string {
    if (url.includes('connection_limit=')) return url;
    const sep = url.includes('?') ? '&' : '?';
    const limit =
      process.env.TENANT_CONNECTION_LIMIT ?? String(DEFAULT_CONNECTION_LIMIT);
    return `${url}${sep}connection_limit=${limit}`;
  }

  /**
   * DB-инварианты (partial unique indexes). Идемпотентны (`IF NOT EXISTS`),
   * не валят запрос — при ошибке только warn (как раньше в PrismaService).
   */
  private async applyInvariants(
    tenantId: string,
    client: PrismaClient,
  ): Promise<void> {
    if (this.invariantsApplied.has(tenantId)) return;
    const statements = [
      // «Один открытый shift на сотрудника» (ADR-0015).
      `CREATE UNIQUE INDEX IF NOT EXISTS "shift_session_active_employee_uniq"
         ON "ShiftSession" ("employeeId") WHERE "endedAt" IS NULL`,
      // По одной активной (REQUESTED) и одной подтверждённой (APPROVED)
      // заявке на закрытие раскроя на (orderId, productId, sizeId) (ADR-0018).
      `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_active_uniq"
         ON "CuttingClosureRequest" ("orderId", "productId", "sizeId")
         WHERE "status" = 'REQUESTED'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_approved_uniq"
         ON "CuttingClosureRequest" ("orderId", "productId", "sizeId")
         WHERE "status" = 'APPROVED'`,
    ];
    for (const sql of statements) {
      try {
        await client.$executeRawUnsafe(sql);
      } catch (err) {
        this.logger.warn(
          `Не удалось применить DB-инвариант для тенанта ${tenantId}: ${(err as Error).message}`,
        );
      }
    }
    this.invariantsApplied.add(tenantId);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map((c) =>
        c.$disconnect().catch(() => undefined),
      ),
    );
    this.clients.clear();
  }
}
