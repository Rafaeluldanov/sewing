import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  INTEGRATION_SETTINGS_SINGLETON_ID,
  type IntegrationSettingsDto,
  type UpdateIntegrationSettingsDto,
  type UpgiftsTestConnectionResult,
} from '@sewing/shared/integration';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  IntegrationSecretDecryptError,
  IntegrationSecretKeyMissingError,
  decryptSecret,
  encryptSecret,
} from './secret-box.js';
import {
  UpgiftsApiError,
  UpgiftsClient,
  type UpgiftsCredentials,
} from './upgifts-client.service.js';

type IntegrationSettingsRow = Prisma.IntegrationSettingsGetPayload<{}>;

/**
 * Сервис модуля «Интеграции» — singleton-настройки подключения к
 * внешнему ERP upgifts + проверка соединения. Полный дизайн —
 * `docs/upgifts-integration.md`.
 *
 * Дизайн зеркалит `CompanySettingsService`:
 *   - singleton-строка `id = "default"`, идемпотентный `getOrCreate`;
 *   - PATCH принимает подмножество полей (`undefined` ⇒ не трогаем);
 *   - audit через `AuditService` (событие `INTEGRATION_SETTINGS_UPDATED`),
 *     секреты в payload не пишем.
 *
 * Особенности:
 *   - пароль сервисного аккаунта хранится ЗАШИФРОВАННЫМ
 *     (`secret-box.ts`, AES-256-GCM). Наружу (DTO) не отдаётся;
 *   - включить интеграцию (`upgiftsEnabled = true`) можно только при
 *     заполненных baseUrl+tenant+email+password — иначе `BadRequest`.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly upgifts: UpgiftsClient,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async get(): Promise<IntegrationSettingsDto> {
    return toDto(await this.getOrCreate());
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    dto: UpdateIntegrationSettingsDto,
    actorEmployeeId?: string | null,
  ): Promise<IntegrationSettingsDto> {
    const current = await this.getOrCreate();

    const data: Prisma.IntegrationSettingsUpdateInput = {};
    const changed: string[] = [];

    // --- строковые поля (мягкая семантика '' → null уже применена Zod) ---
    if (dto.upgiftsBaseUrl !== undefined) {
      const next = dto.upgiftsBaseUrl
        ? UpgiftsClient.normalizeBaseUrl(dto.upgiftsBaseUrl)
        : null;
      if (next !== current.upgiftsBaseUrl) {
        data.upgiftsBaseUrl = next;
        changed.push('upgiftsBaseUrl');
      }
    }
    for (const key of ['upgiftsTenant', 'upgiftsEmail', 'upgiftsOrganizationId'] as const) {
      const value = dto[key];
      if (value === undefined) continue;
      const next = value ?? null;
      if (next !== current[key]) {
        (data as Record<string, string | null>)[key] = next;
        changed.push(key);
      }
    }

    // --- пароль: шифруем, если передан непустой ---
    if (dto.upgiftsPassword !== undefined) {
      try {
        data.upgiftsPasswordEnc = encryptSecret(dto.upgiftsPassword);
      } catch (e) {
        if (e instanceof IntegrationSecretKeyMissingError) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'INTEGRATION_SECRET_KEY_MISSING',
            message:
              'Не задан ключ шифрования INTEGRATION_SECRET_KEY — пароль ' +
              'интеграции не сохранён. Обратитесь к администратору сервера.',
          });
        }
        throw e;
      }
      changed.push('upgiftsPassword');
    }

    // --- флаг включения ---
    if (dto.upgiftsEnabled !== undefined && dto.upgiftsEnabled !== current.upgiftsEnabled) {
      data.upgiftsEnabled = dto.upgiftsEnabled;
      changed.push('upgiftsEnabled');
    }

    // --- проверка полноты для включённой интеграции ---
    const effectiveEnabled = dto.upgiftsEnabled ?? current.upgiftsEnabled;
    if (effectiveEnabled) {
      const baseUrl =
        data.upgiftsBaseUrl !== undefined
          ? (data.upgiftsBaseUrl as string | null)
          : current.upgiftsBaseUrl;
      const tenant =
        data.upgiftsTenant !== undefined
          ? (data.upgiftsTenant as string | null)
          : current.upgiftsTenant;
      const email =
        data.upgiftsEmail !== undefined
          ? (data.upgiftsEmail as string | null)
          : current.upgiftsEmail;
      const hasPassword =
        data.upgiftsPasswordEnc !== undefined
          ? Boolean(data.upgiftsPasswordEnc)
          : Boolean(current.upgiftsPasswordEnc);
      if (!baseUrl || !tenant || !email || !hasPassword) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'INTEGRATION_INCOMPLETE',
          message:
            'Чтобы включить интеграцию, заполните Base URL, тенант, email и ' +
            'пароль сервисного аккаунта upgifts.',
        });
      }
    }

    if (changed.length === 0) {
      return toDto(current);
    }

    const updated = await this.prisma.integrationSettings.update({
      where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
      data,
    });
    // Учётка могла смениться — сбросить кэш access-токена.
    this.invalidateTokenFor(updated);
    this.logger.log(
      `event=integration-settings.update fields=${changed.join(',')}`,
    );
    await this.audit.log({
      event: 'INTEGRATION_SETTINGS_UPDATED',
      entityType: 'INTEGRATION_SETTINGS',
      entityId: updated.id,
      // Секреты в audit не пишем — только список изменённых полей.
      payload: { changed },
      employeeId: actorEmployeeId ?? null,
    });
    return toDto(updated);
  }

  // ===========================================================================
  // TEST CONNECTION
  // ===========================================================================

  /**
   * Проверка соединения с upgifts: логин сервисным аккаунтом +
   * `GET /auth/me`. Никогда не бросает из-за недоступности upgifts —
   * ошибки возвращаются как `{ ok: false, message }`. Результат
   * (успех/ошибка) сохраняется в `lastConnectionOkAt`/`lastConnectionError`.
   */
  async testConnection(): Promise<UpgiftsTestConnectionResult> {
    const row = await this.getOrCreate();
    const creds = this.credentialsOf(row);
    if (!creds) {
      return {
        ok: false,
        message:
          'Заполните и сохраните Base URL, тенант, email и пароль ' +
          'сервисного аккаунта upgifts.',
      };
    }

    try {
      const me = await this.upgifts.fetchMe(creds);
      await this.recordConnectionResult(true, null);
      return {
        ok: true,
        message: 'Соединение с upgifts установлено.',
        principal: {
          tenantId: me.tenant_id ?? null,
          userId: me.user_id ?? null,
          scopesCount: me.scopes?.length ?? 0,
        },
      };
    } catch (e) {
      const message =
        e instanceof UpgiftsApiError
          ? describeUpgiftsApiError(e)
          : e instanceof IntegrationSecretKeyMissingError
            ? 'Не задан ключ шифрования INTEGRATION_SECRET_KEY на сервере.'
            : e instanceof IntegrationSecretDecryptError
              ? 'Не удалось расшифровать сохранённый пароль (сменился ключ?).'
              : `Ошибка соединения: ${String(e)}`;
      await this.recordConnectionResult(false, message);
      return { ok: false, message };
    }
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  /** Собрать учётку для клиента, расшифровав пароль. `null`, если неполная. */
  private credentialsOf(row: IntegrationSettingsRow): UpgiftsCredentials | null {
    if (
      !row.upgiftsBaseUrl ||
      !row.upgiftsTenant ||
      !row.upgiftsEmail ||
      !row.upgiftsPasswordEnc
    ) {
      return null;
    }
    return {
      baseUrl: row.upgiftsBaseUrl,
      tenant: row.upgiftsTenant,
      email: row.upgiftsEmail,
      password: decryptSecret(row.upgiftsPasswordEnc),
    };
  }

  private invalidateTokenFor(row: IntegrationSettingsRow): void {
    if (row.upgiftsBaseUrl && row.upgiftsTenant && row.upgiftsEmail) {
      this.upgifts.invalidateToken({
        baseUrl: row.upgiftsBaseUrl,
        tenant: row.upgiftsTenant,
        email: row.upgiftsEmail,
        password: '',
      });
    }
  }

  private async recordConnectionResult(
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    try {
      await this.prisma.integrationSettings.update({
        where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
        data: {
          lastConnectionOkAt: ok ? new Date() : undefined,
          lastConnectionError: ok ? null : error,
        },
      });
    } catch (e) {
      // fail-soft: не удалось записать итог проверки — не критично.
      this.logger.warn(`recordConnectionResult failed: ${String(e)}`);
    }
  }

  /**
   * Идемпотентно достаёт singleton-строку, создаёт при отсутствии.
   * Race при первом обращении защищён `singleton`-unique (P2002).
   */
  private async getOrCreate(): Promise<IntegrationSettingsRow> {
    const existing = await this.prisma.integrationSettings.findUnique({
      where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
    });
    if (existing) return existing;
    try {
      return await this.prisma.integrationSettings.create({
        data: { id: INTEGRATION_SETTINGS_SINGLETON_ID, singleton: true },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const row = await this.prisma.integrationSettings.findUnique({
          where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
        });
        if (row) return row;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// DTO mapper (пароль НИКОГДА не отдаём — только hasPassword)
// ---------------------------------------------------------------------------

function toDto(r: IntegrationSettingsRow): IntegrationSettingsDto {
  return {
    id: r.id,
    upgiftsEnabled: r.upgiftsEnabled,
    upgiftsBaseUrl: r.upgiftsBaseUrl,
    upgiftsTenant: r.upgiftsTenant,
    upgiftsEmail: r.upgiftsEmail,
    upgiftsOrganizationId: r.upgiftsOrganizationId,
    hasPassword: Boolean(r.upgiftsPasswordEnc),
    lastConnectionOkAt: r.lastConnectionOkAt
      ? r.lastConnectionOkAt.toISOString()
      : null,
    lastConnectionError: r.lastConnectionError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Человекочитаемые ошибки upgifts
// ---------------------------------------------------------------------------

/**
 * upgifts (FastAPI) кладёт причину в тело `{ "detail": ... }` и
 * переиспользует 404 для бизнес-случаев (напр. `unknown_or_inactive_tenant`
 * — тенант в логине задан неверно). Маппим status+detail в подсказку
 * «что проверить», иначе пользователь видит невнятное «404».
 */
function describeUpgiftsApiError(e: UpgiftsApiError): string {
  // Таймаут/сеть (status === null) — сообщение клиента уже осмысленно.
  if (e.status === null) return e.message;
  const detail = extractDetail(e.body);
  if (detail === 'unknown_or_inactive_tenant' || (e.status === 404 && detail)) {
    return `Тенант upgifts не найден или неактивен — проверьте поле «Тенант» (${detail ?? e.status}).`;
  }
  if (e.status === 401 || e.status === 403) {
    return `Неверный email или пароль сервисного аккаунта upgifts${
      detail ? ` (${detail})` : ''
    }.`;
  }
  if (e.status === 422) {
    return `upgifts отклонил запрос (проверьте заполнение полей): ${detail ?? '422'}.`;
  }
  return `upgifts ответил ${e.status}${detail ? `: ${detail}` : ''}.`;
}

/** Достать `detail` из тела ошибки FastAPI (или вернуть обрезанное тело). */
function extractDetail(body?: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
    if (parsed.detail != null) {
      return JSON.stringify(parsed.detail).slice(0, 200);
    }
  } catch {
    /* тело не JSON — вернём как есть */
  }
  return body.slice(0, 200);
}
