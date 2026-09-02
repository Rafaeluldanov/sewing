import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from './auth.types.js';
import {
  generateServiceToken,
  hashEquals,
  hashServiceToken,
  previewOf,
} from './service-token.js';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

/** Как часто обновляем `lastUsedAt`: без дебаунса это UPDATE на КАЖДЫЙ запрос интеграции. */
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;

/** Роли, которые машинному токену выдавать нельзя ни при каких условиях. */
const FORBIDDEN_ROLES = new Set(['ADMIN', 'SUPERADMIN']);
/** Логин служебного сотрудника машинных токенов — один на тенанта. */
export const SERVICE_EMPLOYEE_LOGIN = 'erp-integration';
export const SERVICE_EMPLOYEE_NAME = 'Интеграция ERP';

@Injectable()
export class ServiceTokenService {
  private readonly logger = new Logger(ServiceTokenService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Резолв машинного принципала по плейнтексту токена.
   *
   * ⛔ Намеренно НЕ ходит в `AuthService.resolvePrincipal`: там политика сессий сотрудника
   * (idle-TTL и рубильник «Завершить все сеансы»), от которой интеграция и уходит.
   */
  async resolvePrincipal(raw: string): Promise<AuthPrincipal | null> {
    const hash = hashServiceToken(raw);
    const row = await this.prisma.serviceToken.findUnique({ where: { tokenHash: hash } });
    if (!row) return null;
    // Сверка явная и за постоянное время (поиск по индексу уже нашёл строку — это
    // защита от подсказки по таймингу, а не от коллизии).
    if (!hashEquals(row.tokenHash, hash)) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    void this.touch(row.id, row.lastUsedAt);

    const roles = row.roles.filter((r) => !FORBIDDEN_ROLES.has(r));
    // Служебный сотрудник вместо синтетического id (правило §0.1): у заявок КБ, расчёта заказа
    // и файлов лекал поля автора ссылаются на Employee внешним ключом, и строка
    // `service-token:<id>` ронял бы запись из ERP на ключе. Кто из людей нажал — в аудите.
    const employeeId = row.employeeId ?? (await this.ensureServiceEmployee(row.id, roles));
    return {
      employeeId,
      role: roles[0] ?? 'SHOP_MANAGER',
      roles,
      assignedRoles: roles,
      activeRole: null,
      workspace: 'admin',
      singleWorkspace: false,
      lockToWorkspace: false,
      login: `service:${row.name}`,
      fullName: `Интеграция: ${row.name}`,
      kind: 'MACHINE',
      scopes: row.scopes,
      serviceTokenId: row.id,
    };
  }

  /**
   * Служебный сотрудник «Интеграция ERP» — один на тенанта, создаётся при первом запросе
   * любого машинного токена и переиспользуется всеми. Логин фиксированный, PIN — случайный
   * и никому не известен: войти этой учёткой с терминала нельзя, она существует только
   * ради внешних ключей. Гонка двух первых запросов ловится на уникальности логина.
   */
  private async ensureServiceEmployee(tokenId: string, roles: string[]): Promise<string> {
    const login = SERVICE_EMPLOYEE_LOGIN;
    let employee = await this.prisma.employee.findUnique({ where: { login }, select: { id: true } });
    if (!employee) {
      const pinHash = await bcrypt.hash(randomBytes(24).toString('base64url'), 10);
      try {
        employee = await this.prisma.employee.create({
          data: {
            fullName: SERVICE_EMPLOYEE_NAME,
            login,
            pinHash,
            role: roles[0] ?? 'SHOP_MANAGER',
            roles: roles.length ? roles : ['SHOP_MANAGER'],
            active: true,
          },
          select: { id: true },
        });
      } catch (err) {
        // Параллельный первый запрос успел раньше — берём его результат.
        employee = await this.prisma.employee.findUnique({ where: { login }, select: { id: true } });
        if (!employee) throw err;
      }
    }
    try {
      await this.prisma.serviceToken.update({
        where: { id: tokenId },
        data: { employeeId: employee.id },
      });
    } catch (err) {
      this.logger.warn(`event=service-token.employee-link.failed id=${tokenId} err=${String(err)}`);
    }
    return employee.id;
  }

  /** Отметка «токен жив» с дебаунсом; ошибка записи не должна ронять сам запрос. */
  private async touch(id: string, lastUsedAt: Date | null): Promise<void> {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_DEBOUNCE_MS) return;
    try {
      await this.prisma.serviceToken.update({
        where: { id },
        data: { lastUsedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`не удалось обновить lastUsedAt токена ${id}: ${String(err)}`);
    }
  }

  /**
   * Выпустить токен. Плейнтекст возвращается ОДИН раз и больше не восстановим:
   * в БД лежит только sha256.
   */
  async issue(params: {
    name: string;
    scopes: string[];
    roles?: string[];
    expiresAt?: Date | null;
    createdById?: string | null;
  }): Promise<{ token: string; id: string; tokenPrefix: string }> {
    const roles = (params.roles ?? ['SHOP_MANAGER']).filter((r) => !FORBIDDEN_ROLES.has(r));
    const raw = generateServiceToken();
    const row = await this.prisma.serviceToken.create({
      data: {
        name: params.name,
        tokenHash: hashServiceToken(raw),
        tokenPrefix: previewOf(raw),
        roles: roles.length ? roles : ['SHOP_MANAGER'],
        scopes: params.scopes,
        expiresAt: params.expiresAt ?? null,
        createdById: params.createdById ?? null,
      },
    });
    this.logger.log(`event=service_token.issued id=${row.id} name=${row.name}`);
    return { token: raw, id: row.id, tokenPrefix: row.tokenPrefix };
  }

  async list() {
    return this.prisma.serviceToken.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, tokenPrefix: true, roles: true, scopes: true,
        createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true,
      },
    });
  }

  /** Отзыв — простановка даты, не DELETE: история нужна для расследования. */
  async revoke(id: string, revokedById?: string | null) {
    const row = await this.prisma.serviceToken.update({
      where: { id },
      data: { revokedAt: new Date(), revokedById: revokedById ?? null },
      select: { id: true, name: true, revokedAt: true },
    });
    this.logger.log(`event=service_token.revoked id=${row.id}`);
    return row;
  }
}
