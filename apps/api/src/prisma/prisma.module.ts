import {
  Global,
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { PrismaService, prismaServiceProvider } from './prisma.service.js';
import { PrismaClientManager } from './prisma-client-manager.js';
import { TenantContext } from './tenant-context.js';
import { TenantRegistry } from './tenant-registry.service.js';
import { TenantResolverMiddleware } from './tenant-resolver.middleware.js';

/**
 * Глобальный модуль доступа к БД под DB-per-tenant.
 *
 * Провайдит шов мультитенантности:
 *   - `TenantContext`        — ALS-контекст текущего тенанта;
 *   - `TenantRegistry`       — резолв Host → TenantInfo (Фаза 0: один тенант);
 *   - `PrismaClientManager`  — LRU-пул PrismaClient по тенанту;
 *   - `PrismaService`        — Proxy-делегатор (фабрика `prismaServiceProvider`).
 *
 * И подключает `TenantResolverMiddleware` на все маршруты — он ставит
 * контекст тенанта до обработчиков.
 */
@Global()
@Module({
  providers: [
    TenantContext,
    TenantRegistry,
    PrismaClientManager,
    prismaServiceProvider,
  ],
  exports: [
    PrismaService,
    TenantContext,
    TenantRegistry,
    PrismaClientManager,
  ],
})
export class PrismaModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantResolverMiddleware).forRoutes('*');
  }
}
