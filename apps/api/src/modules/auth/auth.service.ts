import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type { Employee, Role } from '@prisma/client';
import {
  EmployeeInactiveException,
  InvalidCredentialsException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { signSession, verifySession, type SessionPayload } from './session.js';
import {
  buildSessionCookieAttributes,
  type CookieAttributes,
} from './cookie.js';
import type { AuthPrincipal } from './auth.types.js';

const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly appUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const secret = config.get<string>('JWT_SECRET') ?? '';
    if (!secret || secret === 'change-me-in-prod') {
      // Не падаем — иначе сломаем dev-окружение, где `.env.example`
      // содержит дефолт. Но громко предупреждаем: на prod секрет
      // обязан быть переопределён.
      this.logger.warn(
        'JWT_SECRET is missing or default — set a strong value in production .env',
      );
    }
    this.secret = secret || 'sewing-dev-fallback-secret';
    this.ttlSeconds = parseTtl(config.get<string>('JWT_EXPIRES_IN'));
    this.appUrl = config.get<string>('APP_URL') ?? null;
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(
    login: string,
    password: string,
  ): Promise<{
    user: AuthPrincipal;
    cookie: { name: string; value: string; attrs: CookieAttributes };
  }> {
    const employee = await this.prisma.employee.findUnique({
      where: { login },
    });
    if (!employee) throw new InvalidCredentialsException();
    if (!employee.active) throw new EmployeeInactiveException();
    const ok = await bcrypt.compare(password, employee.pinHash);
    if (!ok) throw new InvalidCredentialsException();

    // Шаг 12 / Pilot Rollout — структурированный лог входа.
    this.logger.log(
      `event=auth.login employeeId=${employee.id} login=${employee.login} role=${employee.role}`,
    );
    return this.issueSession(employee);
  }

  /**
   * Создаёт session-cookie для сотрудника. Используется при логине,
   * а в тестах — для прямого получения cookie без формы.
   */
  issueSession(employee: Pick<Employee, 'id' | 'role' | 'login' | 'fullName'>): {
    user: AuthPrincipal;
    cookie: { name: string; value: string; attrs: CookieAttributes };
  } {
    const { token, expiresAt } = signSession(
      { sub: employee.id, role: employee.role },
      { secret: this.secret, ttlSeconds: this.ttlSeconds },
    );
    const attrs = buildSessionCookieAttributes({
      appUrl: this.appUrl,
      ttlSeconds: this.ttlSeconds,
      expires: expiresAt,
    });
    const user: AuthPrincipal = {
      employeeId: employee.id,
      role: employee.role,
      login: employee.login,
      fullName: employee.fullName,
    };
    return { user, cookie: { name: SESSION_COOKIE_NAME, value: token, attrs } };
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /**
   * Возвращает cookie-инструкцию на затирание сессии. Сервер не хранит
   * stateful-сессии, поэтому «выход» — это очистка cookie на клиенте.
   */
  buildLogoutCookie(): {
    name: string;
    attrs: CookieAttributes;
  } {
    const attrs = buildSessionCookieAttributes({
      appUrl: this.appUrl,
      ttlSeconds: 0,
      expires: new Date(0),
    });
    return { name: SESSION_COOKIE_NAME, attrs };
  }

  // ---------------------------------------------------------------------------
  // Verify (для AuthGuard)
  // ---------------------------------------------------------------------------

  /**
   * Проверяет cookie-токен и подгружает «свежие» поля Employee
   * (для UI-шапки). Возвращает `null`, если токен невалиден или
   * сотрудник деактивирован.
   *
   * Важно: роль/login/fullName берём из БД, а не из payload — иначе
   * после деактивации или смены роли пользователь продолжал бы
   * пользоваться старыми правами до окончания TTL.
   */
  async resolvePrincipal(token: string): Promise<AuthPrincipal | null> {
    const payload = verifySession(token, { secret: this.secret });
    if (!payload) return null;
    const employee = await this.prisma.employee.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, login: true, fullName: true, active: true },
    });
    if (!employee || !employee.active) return null;
    return {
      employeeId: employee.id,
      role: employee.role as Role,
      login: employee.login,
      fullName: employee.fullName,
    };
  }

  /**
   * Лёгкая offline-проверка только подписи и срока. Используется для
   * health-эндпоинтов и тестов — без обращения в БД. Не делает rbac.
   */
  verifyTokenOffline(token: string): SessionPayload | null {
    return verifySession(token, { secret: this.secret });
  }
}

// ---------------------------------------------------------------------------

import { SESSION_COOKIE_NAME } from './cookie.js';

/**
 * Парсер `JWT_EXPIRES_IN` в секунды. Поддерживаем суффиксы `h`/`m`/`s`/`d`
 * и голое число (секунды). По умолчанию — 12 часов.
 */
function parseTtl(raw: string | undefined): number {
  if (!raw) return DEFAULT_TTL_SECONDS;
  const trimmed = raw.trim();
  const match = /^(\d+)\s*([smhd])?$/.exec(trimmed);
  if (!match) return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  switch (unit) {
    case 's':
      return n;
    case 'm':
      return n * 60;
    case 'h':
      return n * 60 * 60;
    case 'd':
      return n * 24 * 60 * 60;
    default:
      return DEFAULT_TTL_SECONDS;
  }
}
