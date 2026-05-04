import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  EmployeeQrResponseDto,
  EmployeeQrTokenPayload,
} from '@sewing/shared/employee-qr';
import { EMPLOYEE_QR_PAYLOAD_PREFIX } from '@sewing/shared/employee-qr';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EmployeeProfileNotFoundException,
  EmployeeInactiveForbiddenException,
} from '../../common/errors.js';
import {
  EMPLOYEE_QR_DEFAULT_TTL_SECONDS,
  signEmployeeQrToken,
  verifyEmployeeQrToken,
} from '../auth/employee-qr-token.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Сервис личного кабинета сотрудника (`GET /api/me/*`, MVP).
 *
 * На MVP выдаёт только «мой QR-код». Логика тривиальна, но сервис
 * вынесен отдельно из контроллера ради:
 *   1. Тестируемости (можно юнит-тестами проверить payload и TTL
 *      без HTTP-слоя);
 *   2. Повторного использования `signCurrentEmployeeQr` в смежных
 *      потоках (например, печать этикетки с подписанным токеном) —
 *      без дубля чтения `JWT_SECRET`;
 *   3. Явного централизованного места error-mapping'а
 *      (`EMPLOYEE_PROFILE_NOT_FOUND`, `EMPLOYEE_INACTIVE`).
 */
@Injectable()
export class MeService {
  private readonly logger = new Logger(MeService.name);
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    const secret = config.get<string>('JWT_SECRET') ?? '';
    if (!secret || secret === 'change-me-in-prod') {
      this.logger.warn(
        'JWT_SECRET is missing or default — QR-токены будут подписаны dev-fallback секретом',
      );
    }
    // Синхронизируем fallback с `AuthService`, чтобы один и тот же
    // секрет подписывал session-cookie и QR-токен в dev-режиме.
    this.secret = secret || 'sewing-dev-fallback-secret';
    this.ttlSeconds = EMPLOYEE_QR_DEFAULT_TTL_SECONDS;
  }

  /**
   * Выдаёт DTO ответа `GET /api/me/employee-qr`. Дополнительно
   * перепроверяет `active = true` у живой карточки — это
   * defence-in-depth на случай, если `AuthGuard` в будущем ослабят.
   *
   * Ошибки:
   *   - 404 `EMPLOYEE_PROFILE_NOT_FOUND` — карточки нет в БД
   *     (сотрудника удалили между выдачей сессии и вызовом).
   *   - 403 `EMPLOYEE_INACTIVE` — карточка есть, но `active=false`.
   */
  async buildEmployeeQr(
    principal: AuthPrincipal,
    now: Date = new Date(),
  ): Promise<EmployeeQrResponseDto> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: principal.employeeId },
      select: { id: true, fullName: true, role: true, active: true },
    });
    if (!employee) throw new EmployeeProfileNotFoundException();
    if (!employee.active) throw new EmployeeInactiveForbiddenException();

    const { token, expiresAt } = signEmployeeQrToken(
      {
        employeeId: employee.id,
        userId: employee.id,
        role: employee.role,
      },
      { secret: this.secret, ttlSeconds: this.ttlSeconds },
      now,
    );

    return {
      employee: {
        id: employee.id,
        name: employee.fullName,
        role: employee.role,
      },
      qrPayload: `${EMPLOYEE_QR_PAYLOAD_PREFIX}${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Проверка подписи QR-токена — вынесена в сервис, чтобы другие
   * модули (например, будущий `/master/scan-employee-qr`) могли
   * использовать её без дубля чтения секрета. На MVP не вызывается
   * извне, но включена в unit-тест смежного сервиса.
   */
  verifyEmployeeQrToken(
    token: string,
    now: Date = new Date(),
  ): EmployeeQrTokenPayload | null {
    return verifyEmployeeQrToken(token, { secret: this.secret }, now);
  }
}
