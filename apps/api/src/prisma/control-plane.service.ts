import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
// Отдельный сгенерированный клиент control-plane схемы
// (prisma/control-plane/schema.prisma → output .prisma/control-plane-client).
import { PrismaClient as ControlPlaneClient } from '.prisma/control-plane-client';

/**
 * Доступ к control-plane БД (реестр тенантов): отдельный Postgres и
 * отдельный Prisma-клиент. Источник для `TenantRegistry` (резолв Host→тенант)
 * и `FeatureModulesService` (включённые модули тенанта).
 *
 * ОПЦИОНАЛЕН: если `CONTROL_PLANE_DATABASE_URL` не задан — control-plane
 * выключен, а потребители падают обратно в single-tenant режим (env
 * DATABASE_URL + default-on модули). Это сохраняет работу dev/одноарендных
 * инсталляций без обязательного развёртывания control-plane.
 */
@Injectable()
export class ControlPlaneService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlPlaneService.name);
  private readonly url = process.env.CONTROL_PLANE_DATABASE_URL;
  private instance: ControlPlaneClient | null = null;

  isEnabled(): boolean {
    return Boolean(this.url);
  }

  /** Клиент control-plane. Бросает, если control-plane выключен. */
  get client(): ControlPlaneClient {
    if (!this.instance) {
      throw new Error(
        'Control-plane выключен (CONTROL_PLANE_DATABASE_URL не задан) — ' +
          'проверяйте isEnabled() перед обращением к client.',
      );
    }
    return this.instance;
  }

  async onModuleInit(): Promise<void> {
    if (!this.url) {
      this.logger.log(
        'event=control-plane.disabled mode=single-tenant (CONTROL_PLANE_DATABASE_URL не задан)',
      );
      return;
    }
    this.instance = new ControlPlaneClient({
      datasources: { db: { url: this.url } },
    });
    await this.instance.$connect();
    this.logger.log('event=control-plane.connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.instance?.$disconnect().catch(() => undefined);
  }
}
