import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthPrincipal } from './auth.types.js';
import {
  generateServiceToken,
  hashEquals,
  hashServiceToken,
  previewOf,
} from './service-token.js';

/** Как часто обновляем `lastUsedAt`: без дебаунса это UPDATE на КАЖДЫЙ запрос интеграции. */
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;

/** Роли, которые машинному токену выдавать нельзя ни при каких условиях. */
const FORBIDDEN_ROLES = new Set(['ADMIN', 'SUPERADMIN']);

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
    return {
      // Синтетический id: машинного сотрудника не существует, а поле обязательное.
      // FK на Employee здесь нет ни у аудита, ни у справочников (проверено), поэтому
      // строка безопасна и сразу читается в логах как «это не человек».
      employeeId: `service-token:${row.id}`,
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
