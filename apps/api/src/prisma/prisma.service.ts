import type { Provider } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaClientManager } from './prisma-client-manager.js';
import { TenantContext } from './tenant-context.js';

/**
 * Единая точка инжекта Prisma для всех ~84 сервисов.
 *
 * Исторически это был singleton `PrismaClient`. Под DB-per-tenant это
 * больше НЕ один клиент: реальный объект под токеном `PrismaService` —
 * Proxy, который на каждое обращение (`.order`, `.$transaction`,
 * `.$queryRaw`, ...) форвардит вызов на `PrismaClient` ТЕКУЩЕГО тенанта
 * (id берётся из `TenantContext`, клиент — из `PrismaClientManager`).
 *
 * Благодаря Proxy все сервисы продолжают писать `this.prisma.order
 * .findMany(...)` без изменений — выбор БД скрыт здесь.
 *
 * Класс оставлен как DI-токен и тип (структурно = `PrismaClient`).
 * `abstract` — потому что он НЕ инстанцируется через `new`: инстанс
 * создаёт фабрика `prismaServiceProvider` (Proxy). Lifecycle-хуки
 * ($connect / $disconnect / инварианты) переехали в `PrismaClientManager`
 * и `TenantResolverMiddleware`.
 */
export abstract class PrismaService extends PrismaClient {}

/**
 * Служебные свойства, которые фреймворк/рантайм читают с инстанса
 * провайдера ВНЕ контекста запроса (на старте/остановке), когда тенант
 * ещё не выбран:
 *   - `then` — NestJS делает `await factoryReturnValue` (await читает
 *     `.then`); Proxy не должен притворяться thenable;
 *   - lifecycle-хуки — NestJS проверяет их наличие на каждом провайдере.
 * На такие пробы (и на symbol-интроспекцию) вне контекста отдаём
 * `undefined`, НЕ резолвя тенанта. Реальные же обращения к Prisma
 * (`.order`, `.$transaction`, ...) вне контекста по-прежнему дают
 * громкую понятную ошибку из `requireTenantId()`.
 */
const FRAMEWORK_PROBES = new Set<string>([
  'then',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'beforeApplicationShutdown',
]);

/**
 * Proxy, делегирующий все обращения на клиент текущего тенанта.
 * Функции биндятся на реальный клиент (чтобы `this` в `$transaction`/raw
 * указывал на него); делегаты моделей (`client.order`) — объекты,
 * возвращаются как есть и работают со своим `this`.
 */
export function createTenantPrismaProxy(
  manager: PrismaClientManager,
  context: TenantContext,
): PrismaService {
  return new Proxy({} as PrismaService, {
    get(_target, prop) {
      if (
        (typeof prop === 'symbol' || FRAMEWORK_PROBES.has(prop)) &&
        !context.getStore()
      ) {
        return undefined;
      }
      const tenantId = context.requireTenantId();
      const client = manager.getReadyClient(tenantId);
      const value = Reflect.get(client, prop, client);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(client)
        : value;
    },
  });
}

export const prismaServiceProvider: Provider = {
  provide: PrismaService,
  useFactory: (manager: PrismaClientManager, context: TenantContext) =>
    createTenantPrismaProxy(manager, context),
  inject: [PrismaClientManager, TenantContext],
};
