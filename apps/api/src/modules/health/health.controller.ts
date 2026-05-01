import { Controller, Get, Logger } from '@nestjs/common';
import type {
  HealthResponseDto,
  ReadyResponseDto,
} from '@sewing/shared/auth';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Public } from '../auth/auth.decorators.js';

/**
 * Health/Ready endpoints (MVP 1.1).
 *
 * Контракт:
 *   - `GET /api/health` — всегда отвечает 200 `ok`, если процесс жив;
 *     используется nginx/docker для liveness-проверки.
 *   - `GET /api/ready`  — 200 `ready`, если БД отвечает на запрос;
 *     иначе 200 с `status: not-ready` и `reason`. HTTP-код намеренно
 *     200 — балансировщикам/мониторингу проще читать `status`-поле,
 *     а не разводить алёрты на 5xx при кратковременном недоступе.
 *
 * См. ADR-0014 «Auth и сессии (MVP 1.1)» §4 и `docs/architecture.md §7`.
 */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  health(): HealthResponseDto {
    return { status: 'ok', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<ReadyResponseDto> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return { status: 'ready', time: new Date().toISOString() };
    } catch (err) {
      this.logger.warn(`readiness probe failed: ${(err as Error).message}`);
      return {
        status: 'not-ready',
        reason: 'database',
        time: new Date().toISOString(),
      };
    }
  }
}
