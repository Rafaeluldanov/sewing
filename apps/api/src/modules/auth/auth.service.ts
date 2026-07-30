import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bcrypt from 'bcryptjs';
import type { Employee } from '@prisma/client';
import type { RoleWorkspaceResolution } from '@sewing/shared/app-roles';
import {
  EmployeeInactiveException,
  InvalidCredentialsException,
} from '../../common/errors.js';
import { AppRolesService } from '../app-roles/app-roles.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ControlPlaneService } from '../../prisma/control-plane.service.js';
import { TenantContext } from '../../prisma/tenant-context.js';
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
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ConfigService) config: ConfigService,
    @Inject(TenantContext) private readonly tenantContext: TenantContext,
    @Inject(ControlPlaneService)
    private readonly controlPlane: ControlPlaneService,
    @Inject(AppRolesService)
    private readonly appRoles: AppRolesService,
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
    // Рабочий экран считаем ЗДЕСЬ (login асинхронный), чтобы `ws`/`lock`
    // попали в cookie и web-middleware мог запереть кастомную роль на её
    // терминале без обращения к БД. `issueSession` остаётся синхронным —
    // им пользуются тесты (`tests/utils/app.ts`).
    const assigned =
      employee.roles.length > 0 ? employee.roles : [employee.role];
    const workspace = await this.appRoles.resolveWorkspace(assigned);
    return this.issueSession(employee, workspace);
  }

  /**
   * Создаёт session-cookie для сотрудника. Используется при логине,
   * а в тестах — для прямого получения cookie без формы.
   *
   * `workspace` опционален: без него токен выпускается без `ws`/`lock`,
   * и web-middleware откатывается на legacy-логику по системным ролям
   * (для них результат тот же). Так тестовые хелперы остаются
   * синхронными и не тянут за собой справочник ролей.
   */
  issueSession(
    employee: Pick<
      Employee,
      'id' | 'role' | 'login' | 'fullName'
    > & { roles?: string[]; activeRole?: string | null },
    workspace?: RoleWorkspaceResolution,
  ): {
    user: AuthPrincipal;
    cookie: { name: string; value: string; attrs: CookieAttributes };
  } {
    // ИНВАРИАНТ «roles содержит role»: для старых учёток без набора
    // (или если вызвали с узким Pick) откатываемся к `[role]`.
    const roles =
      employee.roles && employee.roles.length > 0
        ? employee.roles
        : [employee.role];
    const activeRole = employee.activeRole ?? null;
    // Привязываем сессию к текущему тенанту (мультитенантность). Берём из
    // TenantContext без throw: при логине вне HTTP-контекста (тесты) или в
    // single-tenant токен выпускается без `tid`, и проверка не применяется.
    const tid = this.tenantContext.getStore()?.tenantId;
    const { token, expiresAt } = signSession(
      {
        sub: employee.id,
        role: employee.role,
        roles,
        ...(tid ? { tid } : {}),
        ...(workspace
          ? { ws: workspace.workspace, lock: workspace.lockToWorkspace }
          : {}),
      },
      { secret: this.secret, ttlSeconds: this.ttlSeconds },
    );
    const attrs = buildSessionCookieAttributes({
      appUrl: this.appUrl,
      ttlSeconds: this.ttlSeconds,
      expires: expiresAt,
    });
    const user: AuthPrincipal = {
      employeeId: employee.id,
      // На выпуске токена наследование не раскрываем: `issueSession`
      // синхронный, а ответу логина эффективный набор не нужен — веб
      // сразу после входа идёт за `/api/auth/me`, где он уже посчитан.
      role: employee.role,
      roles,
      assignedRoles: roles,
      activeRole,
      workspace: workspace?.workspace ?? '/',
      singleWorkspace: workspace?.singleWorkspace ?? false,
      lockToWorkspace: workspace?.lockToWorkspace ?? false,
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
    // Tenant-binding (мультитенантность): при включённом control-plane токен
    // обязан быть привязан к ТЕКУЩЕМУ резолвнутому тенанту. Иначе — подделка
    // домена/заголовка или legacy-токен без `tid`: отвергаем ДО любого
    // обращения к БД (чтобы не трогать чужую тенант-БД). В single-tenant
    // (control-plane выключен) проверка не применяется — поведение прежнее.
    if (this.controlPlane.isEnabled()) {
      const currentTenantId = this.tenantContext.getStore()?.tenantId ?? null;
      if (!payload.tid || payload.tid !== currentTenantId) {
        return null;
      }
    }
    const employee = await this.prisma.employee.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        roles: true,
        activeRole: true,
        login: true,
        fullName: true,
        active: true,
      },
    });
    if (!employee || !employee.active) return null;
    // Свежий набор ролей из БД (не из payload) — чтобы смена ролей в
    // админке вступала в силу сразу, до перевыпуска токена. Fallback
    // `[role]` поддерживает инвариант для старых строк.
    const assignedRoles =
      employee.roles && employee.roles.length > 0
        ? employee.roles
        : [employee.role];
    // Раскрытие наследования — тоже на лету, а не из токена: правка
    // `AppRole.inherits` в админке должна догонять уже вошедших
    // сотрудников, не дожидаясь перелогина. Для учёток только с
    // системными ролями запроса в БД не будет (см. `resolveAccess`).
    const { effective, workspace } =
      await this.appRoles.resolveAccess(assignedRoles);
    return {
      employeeId: employee.id,
      role: employee.role,
      roles: effective,
      assignedRoles,
      activeRole: employee.activeRole ?? null,
      workspace: workspace.workspace,
      singleWorkspace: workspace.singleWorkspace,
      lockToWorkspace: workspace.lockToWorkspace,
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
