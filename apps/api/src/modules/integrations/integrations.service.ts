import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AssistantKeySource } from '@sewing/shared/assistant';
import {
  INTEGRATION_SETTINGS_SINGLETON_ID,
  type AssistantTestKeyResult,
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
    const row = await this.getOrCreate();
    return toDto(row, await this.assistantStats());
  }

  /**
   * Расход ассистента с начала календарного месяца — показывается в
   * карточке настроек рядом с потолком. Лимит, расход по которому не
   * видно, никто не настраивает осмысленно.
   */
  private async assistantStats(): Promise<AssistantStats> {
    const from = new Date();
    const monthStart = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1),
    );
    const [agg, questions] = await Promise.all([
      this.prisma.assistantMessage.aggregate({
        where: { createdAt: { gte: monthStart } },
        _sum: { costUsdMicros: true },
      }),
      this.prisma.assistantMessage.count({
        where: { createdAt: { gte: monthStart }, role: 'USER' },
      }),
    ]);
    return {
      // Микродоллары → центы: $0,03 = 30000 микро = 3 цента.
      spentThisMonthCents: Math.round((agg._sum.costUsdMicros ?? 0) / 10_000),
      questionsThisMonth: questions,
      platformKeyAvailable: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    };
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

    // --- ассистент (ИИ) -----------------------------------------------------
    this.applyAssistantPatch(dto, current, data, changed);

    if (changed.length === 0) {
      return toDto(current, await this.assistantStats());
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
    return toDto(updated, await this.assistantStats());
  }

  /**
   * Патч полей ассистента. Вынесен из `update`, чтобы тело метода не
   * превратилось в простыню: логика та же (undefined ⇒ не трогаем), плюс
   * одна проверка полноты — включить можно только когда ключ реально
   * доступен, иначе пользователь включит фичу и получит молчащее окно.
   */
  private applyAssistantPatch(
    dto: UpdateIntegrationSettingsDto,
    current: IntegrationSettingsRow,
    data: Prisma.IntegrationSettingsUpdateInput,
    changed: string[],
  ): void {
    if (dto.assistantApiKey !== undefined) {
      try {
        data.assistantApiKeyEnc = encryptSecret(dto.assistantApiKey);
      } catch (e) {
        if (e instanceof IntegrationSecretKeyMissingError) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'INTEGRATION_SECRET_KEY_MISSING',
            message:
              'Не задан ключ шифрования INTEGRATION_SECRET_KEY — ключ ' +
              'Anthropic не сохранён. Обратитесь к администратору сервера.',
          });
        }
        throw e;
      }
      changed.push('assistantApiKey');
    }

    const scalarKeys = [
      'assistantKeySource',
      'assistantModel',
      'assistantDailyLimitPerUser',
      'assistantMonthlyBudgetCents',
      'assistantScopeProduction',
      'assistantScopeSupply',
      'assistantScopeMoney',
      'assistantScopePayroll',
      'assistantEnabled',
    ] as const;
    for (const key of scalarKeys) {
      const value = dto[key];
      if (value === undefined) continue;
      if (value !== current[key]) {
        (data as Record<string, unknown>)[key] = value;
        changed.push(key);
      }
    }

    // Проверка полноты для включённого ассистента.
    const enabled = dto.assistantEnabled ?? current.assistantEnabled;
    if (!enabled) return;

    const keySource = dto.assistantKeySource ?? current.assistantKeySource;
    const hasOwnKey =
      data.assistantApiKeyEnc !== undefined
        ? Boolean(data.assistantApiKeyEnc)
        : Boolean(current.assistantApiKeyEnc);

    if (keySource === 'OWN' && !hasOwnKey) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ASSISTANT_KEY_MISSING',
        message:
          'Чтобы включить ассистента со своим ключом, сохраните ключ Anthropic.',
      });
    }
    if (keySource === 'PLATFORM' && !process.env.ANTHROPIC_API_KEY?.trim()) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ASSISTANT_PLATFORM_KEY_MISSING',
        message:
          'На сервере не задан ANTHROPIC_API_KEY. Попросите администратора ' +
          'добавить его или переключитесь на свой ключ Anthropic.',
      });
    }
  }

  // ===========================================================================
  // ПРОВЕРКА КЛЮЧА АССИСТЕНТА
  // ===========================================================================

  /**
   * Проверка ключа Anthropic: самый дешёвый из возможных запросов —
   * список моделей. Никогда не бросает: причина приезжает текстом,
   * как и у `testConnection` для upgifts.
   */
  async testAssistantKey(): Promise<AssistantTestKeyResult> {
    const row = await this.getOrCreate();
    let apiKey: string | null = null;

    if (row.assistantKeySource === 'OWN') {
      if (!row.assistantApiKeyEnc) {
        return { ok: false, message: 'Ключ Anthropic компании не сохранён.' };
      }
      try {
        apiKey = decryptSecret(row.assistantApiKeyEnc);
      } catch {
        return {
          ok: false,
          message: 'Не удалось расшифровать сохранённый ключ (сменился INTEGRATION_SECRET_KEY?).',
        };
      }
    } else {
      apiKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
      if (!apiKey) {
        return {
          ok: false,
          message: 'На сервере не задан ANTHROPIC_API_KEY.',
        };
      }
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const message =
          res.status === 401
            ? 'Ключ отклонён Anthropic (401) — проверьте значение.'
            : `Anthropic ответил ${res.status}.`;
        await this.recordAssistantCheck(false, message);
        return { ok: false, message };
      }
      await this.recordAssistantCheck(true, null);
      return { ok: true, message: 'Ключ рабочий, модель доступна.' };
    } catch (e) {
      const message =
        e instanceof Error && e.name === 'TimeoutError'
          ? 'Anthropic не ответил за 15 секунд.'
          : `Не удалось связаться с Anthropic: ${String(e)}`;
      await this.recordAssistantCheck(false, message);
      return { ok: false, message };
    }
  }

  private async recordAssistantCheck(
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    try {
      await this.prisma.integrationSettings.update({
        where: { id: INTEGRATION_SETTINGS_SINGLETON_ID },
        data: {
          assistantLastCheckOkAt: ok ? new Date() : undefined,
          assistantLastCheckError: ok ? null : error,
        },
      });
    } catch (e) {
      this.logger.warn(`recordAssistantCheck failed: ${String(e)}`);
    }
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

/** Счётчики ассистента, которые не хранятся в строке настроек. */
interface AssistantStats {
  spentThisMonthCents: number;
  questionsThisMonth: number;
  platformKeyAvailable: boolean;
}

function toDto(
  r: IntegrationSettingsRow,
  assistant: AssistantStats,
): IntegrationSettingsDto {
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

    assistantEnabled: r.assistantEnabled,
    assistantKeySource: r.assistantKeySource as AssistantKeySource,
    hasOwnAssistantKey: Boolean(r.assistantApiKeyEnc),
    platformAssistantKeyAvailable: assistant.platformKeyAvailable,
    assistantModel: r.assistantModel,
    assistantDailyLimitPerUser: r.assistantDailyLimitPerUser,
    assistantMonthlyBudgetCents: r.assistantMonthlyBudgetCents,
    assistantScopeProduction: r.assistantScopeProduction,
    assistantScopeSupply: r.assistantScopeSupply,
    assistantScopeMoney: r.assistantScopeMoney,
    assistantScopePayroll: r.assistantScopePayroll,
    assistantLastCheckOkAt: r.assistantLastCheckOkAt
      ? r.assistantLastCheckOkAt.toISOString()
      : null,
    assistantLastCheckError: r.assistantLastCheckError,
    assistantSpentThisMonthCents: assistant.spentThisMonthCents,
    assistantQuestionsThisMonth: assistant.questionsThisMonth,

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
