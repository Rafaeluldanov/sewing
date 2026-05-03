import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  COMPANY_SETTINGS_SINGLETON_ID,
  type CompanySettingsDto,
  type UpdateCompanySettingsDto,
} from '@sewing/shared/company-settings';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис «Настройки компании» — singleton-карточка реквизитов
 * организации (см. `prisma/schema.prisma::CompanySettings`,
 * `docs/domain.md §«Настройки компании»`).
 *
 * Дизайн:
 *   - таблица singleton: ровно одна строка с `id = "default"`,
 *     `singleton = true @unique`. Если строки нет — сервис её
 *     идемпотентно создаёт при первом GET (см. `getOrCreate`).
 *   - race-condition при первом обращении защищён уникальностью
 *     `singleton`: параллельный create словит P2002, после чего мы
 *     повторно читаем уже существующую строку.
 *   - PATCH принимает только переданные поля (`undefined` ⇒ не
 *     трогаем); `null` ⇒ очищаем поле.
 *
 * Audit пишется в `AuditLog` глобальным `AuditService` под
 * `entityType = COMPANY_SETTINGS`, `entityId = "default"`.
 * Аналогично `ClientsService` — без транзакции (одна строка),
 * `audit.log` идёт fail-soft.
 */
@Injectable()
export class CompanySettingsService {
  private readonly logger = new Logger(CompanySettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async get(): Promise<CompanySettingsDto> {
    const row = await this.getOrCreate();
    return toDto(row);
  }

  // ===========================================================================
  // FEATURE FLAGS (backend-only, ещё не выставлены в публичный DTO)
  // ===========================================================================

  /**
   * Hardening-флаг автосписания материалов при выдаче кроя
   * (см. `prisma/schema.prisma::CompanySettings.autoIssueMaterialsOnCutRelease`,
   * `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`,
   * `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
   * `docs/current-state.md §«Auto cut issue»`).
   *
   * Контракт:
   *   - `false` (default) → `PassportsService.issueToEmployee` НЕ
   *     вызывает `createAutoCutIssueForPassport`; остальная
   *     транзакционная логика выдачи (события паспорта, статус,
   *     currentEmployee, `CutReleasePolicy` / `OrderCutIssueRule`-учёт)
   *     работает штатно.
   *   - `true`  → `issueToEmployee` вызывает auto-helper в той же
   *     транзакции.
   *   - Если singleton-строки `CompanySettings` ещё нет (свежая БД,
   *     первый вызов) — считаем `false` и НЕ создаём строку
   *     "по дороге": настройка читается из live-flow и не должна
   *     открывать сторонний write. Это безопаснее «idempotent
   *     getOrCreate», который можно встроить как только настройка
   *     получит UI.
   *
   * Сознательная граница итерации: метод НЕ ходит через
   * `getOrCreate()` и НЕ пишет audit. Публичный DTO/PATCH
   * `/api/company-settings` это поле НЕ принимает (UI ещё не
   * утверждён, см. `docs/current-state.md`).
   */
  async getAutoIssueMaterialsOnCutRelease(): Promise<boolean> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      select: { autoIssueMaterialsOnCutRelease: true },
    });
    return row?.autoIssueMaterialsOnCutRelease ?? false;
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    dto: UpdateCompanySettingsDto,
    actorEmployeeId?: string | null,
  ): Promise<CompanySettingsDto> {
    const current = await this.getOrCreate();

    const data: Prisma.CompanySettingsUpdateInput = {};
    const changed: Record<string, { before: string | null; after: string | null }> = {};
    for (const key of UPDATABLE_FIELDS) {
      const value = dto[key];
      if (value === undefined) continue;
      const before = current[key] ?? null;
      const after = value ?? null;
      if (before === after) continue;
      (data as Record<string, string | null>)[key] = after;
      changed[key] = { before, after };
    }

    if (Object.keys(changed).length === 0) {
      // Нечего менять — лишний UPDATE и аудит-строку не пишем.
      return toDto(current);
    }

    const updated = await this.prisma.companySettings.update({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      data,
    });
    this.logger.log(
      `event=company-settings.update fields=${Object.keys(changed).join(',')}`,
    );
    await this.audit.log({
      event: 'COMPANY_SETTINGS_UPDATED',
      entityType: 'COMPANY_SETTINGS',
      entityId: updated.id,
      payload: { changed },
      employeeId: actorEmployeeId ?? null,
    });
    return toDto(updated);
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  /**
   * Идемпотентно достаёт singleton-строку. Если её ещё нет — создаёт.
   * При параллельном create словит `P2002` на `singleton`-unique и
   * перечитает строку.
   */
  private async getOrCreate(): Promise<Prisma.CompanySettingsGetPayload<{}>> {
    const existing = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
    });
    if (existing) return existing;

    try {
      return await this.prisma.companySettings.create({
        data: {
          id: COMPANY_SETTINGS_SINGLETON_ID,
          singleton: true,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const row = await this.prisma.companySettings.findUnique({
          where: { id: COMPANY_SETTINGS_SINGLETON_ID },
        });
        if (row) return row;
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Field list & DTO mapper
// ---------------------------------------------------------------------------

const UPDATABLE_FIELDS = [
  'legalName',
  'shortName',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'actualAddress',
  'phone',
  'email',
  'directorName',
  'accountantName',
  'bankName',
  'bik',
  'correspondentAccount',
  'settlementAccount',
] as const satisfies ReadonlyArray<keyof UpdateCompanySettingsDto>;

type CompanySettingsRow = Prisma.CompanySettingsGetPayload<{}>;

function toDto(c: CompanySettingsRow): CompanySettingsDto {
  return {
    id: c.id,
    legalName: c.legalName,
    shortName: c.shortName,
    inn: c.inn,
    kpp: c.kpp,
    ogrn: c.ogrn,
    legalAddress: c.legalAddress,
    actualAddress: c.actualAddress,
    phone: c.phone,
    email: c.email,
    directorName: c.directorName,
    accountantName: c.accountantName,
    bankName: c.bankName,
    bik: c.bik,
    correspondentAccount: c.correspondentAccount,
    settlementAccount: c.settlementAccount,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
