import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Что хранится в контексте текущего запроса.
 */
export interface TenantContextStore {
  /** id тенанта (ключ для PrismaClientManager). */
  tenantId: string;
  /** slug — только для логов/диагностики. */
  slug: string;
}

/**
 * Контекст текущего тенанта на время обработки запроса.
 *
 * Реализован на встроенном `AsyncLocalStorage` (без внешних пакетов, чтобы
 * не плодить drift node_modules в dev-контейнерах). Middleware
 * (`TenantResolverMiddleware`) оборачивает обработку запроса в `run(...)`,
 * а Proxy-`PrismaService` читает `requireTenantId()`, чтобы выбрать БД.
 *
 * Контекст «протекает» через все async-границы, начатые внутри `run`,
 * поэтому виден во всех контроллерах/сервисах запроса без проброса
 * параметра.
 */
@Injectable()
export class TenantContext {
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  /** Выполнить `fn` в контексте тенанта. Возвращает результат `fn` (в т.ч. Promise). */
  run<T>(store: TenantContextStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  /** Текущий контекст или `null` (вне запроса / без `run`). */
  getStore(): TenantContextStore | null {
    return this.als.getStore() ?? null;
  }

  /**
   * tenantId текущего запроса. Бросает, если контекст не установлен —
   * это значит, что к Prisma обратились вне HTTP-запроса без явного
   * `TenantContext.run(...)` (например, boot-хук). Такие места должны
   * сами обернуть работу в контекст нужного тенанта.
   */
  requireTenantId(): string {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        'TenantContext не установлен: обращение к Prisma вне HTTP-запроса. ' +
          'Оберните работу в TenantContext.run({ tenantId, slug }, ...). ' +
          'См. apps/api/src/prisma/tenant-context.ts.',
      );
    }
    return store.tenantId;
  }
}
