import type { OffRouteWorkPolicy } from '@prisma/client';
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
   * Сознательная граница метода: НЕ ходит через `getOrCreate()` и
   * НЕ пишет audit — это быстрый read из горячего flow. Публичный
   * `GET /api/company-settings` отдаёт то же значение через
   * `get() → toDto()` (с тем же fallback), а `PATCH` принимает его
   * в `UpdateCompanySettingsDto` и пишет audit через общий update().
   */
  async getAutoIssueMaterialsOnCutRelease(): Promise<boolean> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      select: { autoIssueMaterialsOnCutRelease: true },
    });
    return row?.autoIssueMaterialsOnCutRelease ?? false;
  }

  /**
   * Hardening-флаг: разрешать ли отрицательный `StockBalance.qty`
   * при списании материалов в `MaterialIssue.post` /
   * `AUTO_CUT_ISSUE`
   * (см. `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
   * `apps/api/src/modules/stock/stock.service.ts::applyMovementInTx`,
   * `apps/api/src/modules/material-issues/material-issues.service.ts`,
   * `docs/current-state.md §«Material issue → StockMovement OUT»`).
   *
   * Контракт:
   *   - `true`  (default) → текущее MVP-поведение: OUT может увести
   *     `StockBalance.qty` в минус; при отсутствии положительного
   *     баланса создаётся no-location negative balance.
   *   - `false` → `StockService` проверяет достаточность остатка
   *     ДО записи OUT: при нехватке бросает `MATERIAL_STOCK_INSUFFICIENT`
   *     (409), транзакция откатывается, ни OUT, ни апдейта баланса
   *     нет; `MaterialIssue` остаётся `DRAFT`.
   *   - Если строки `CompanySettings` ещё нет (свежая БД, до первого
   *     обращения к UI настроек) — возвращаем `true` и НЕ создаём
   *     singleton-row. Это безопасный default, совпадающий с
   *     SQL-default колонки и со старым поведением — переключение
   *     на жёсткую блокировку остаётся явным действием владельца
   *     проекта (после того, как UI-настройка будет утверждена).
   *
   * Сознательная граница итерации: метод НЕ ходит через
   * `getOrCreate()` и НЕ пишет audit. Публичный DTO/PATCH
   * `/api/company-settings` это поле НЕ принимает (UI ещё не
   * утверждён, см. `docs/current-state.md`).
   *
   * Флаг применяется ТОЛЬКО к OUT-движениям `MaterialIssue` (ручному
   * `post` и `AUTO_CUT_ISSUE`). `PurchaseReceipt` cancel / REVERSAL
   * OUT остаётся permissive (см.
   * `StockService.reversePurchaseReceiptInTx`).
   *
   * Сознательная граница метода: НЕ ходит через `getOrCreate()` и
   * НЕ пишет audit — это быстрый read из горячего flow. Публичный
   * `GET /api/company-settings` отдаёт то же значение через
   * `get() → toDto()` (с тем же fallback), а `PATCH` принимает его
   * в `UpdateCompanySettingsDto` и пишет audit через общий update().
   */
  async getAllowNegativeMaterialStock(): Promise<boolean> {
    const row = await this.prisma.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      select: { allowNegativeMaterialStock: true },
    });
    return row?.allowNegativeMaterialStock ?? true;
  }

  /**
   * Строгость гейта «работа мимо маршрута» (см.
   * `prisma/schema.prisma::CompanySettings.offRouteWorkPolicy`).
   *
   * Читается в горячем flow (issue / scan / complete по каждому
   * паспорту), поэтому — как и соседние hardening-геттеры — НЕ ходит
   * через `getOrCreate()` и не пишет audit.
   *
   * Fallback `WARN` совпадает с SQL-default колонки: на свежей БД, где
   * строки настроек ещё нет, гейт фиксирует нарушения, но никого не
   * блокирует. Возвращать здесь `BLOCK` нельзя — необслуженная БД
   * положила бы цех; возвращать `OFF` тоже нельзя — тогда на новой
   * инсталляции проблема снова станет невидимой.
   */
  async getOffRouteWorkPolicy(): Promise<OffRouteWorkPolicy> {
    try {
      const row = await this.prisma.companySettings.findUnique({
        where: { id: COMPANY_SETTINGS_SINGLETON_ID },
        select: { offRouteWorkPolicy: true },
      });
      return row?.offRouteWorkPolicy ?? 'WARN';
    } catch (e) {
      // Fail-soft по колонке, которой может ещё не быть: `deploy-prod.sh`
      // поднимает контейнеры (шаг 3) РАНЬШЕ `prisma migrate deploy`
      // (шаг 4), то есть новый код какое-то время работает на старой
      // схеме. Уронить здесь issue/scan швеи — цена несопоставимо выше,
      // чем пропустить проверку на пару минут после деплоя.
      // `WARN` вместо `OFF`: даже в этом окне случай попадёт в лог.
      this.logger.warn(
        `event=companySettings.offRouteWorkPolicy.unavailable reason=${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return 'WARN';
    }
  }

  // ===========================================================================
  // EFFECTIVE MATERIAL STOCK POLICY (division overrides → company defaults)
  // ===========================================================================

  /**
   * Effective политика блока «Материалы и склад» для заказа:
   * считает `autoIssueMaterialsOnCutRelease` / `allowNegativeMaterialStock`
   * с учётом per-division override
   * (см. `prisma/schema.prisma::CompanyDivision.{autoIssueMaterialsOnCutReleaseOverride, allowNegativeMaterialStockOverride}`,
   * `docs/current-state.md §«Материалы и склад — division overrides»`).
   *
   * Алгоритм:
   *   1. Читаем у заказа `companyDivisionId` (может быть `null` —
   *      старые заказы, либо карточку division снесли:
   *      `onDelete: SetNull`).
   *   2. Читаем глобальные `CompanySettings` (без `getOrCreate` —
   *      read-only горячий flow). Если строки ещё нет, используем
   *      дефолты: `autoIssueMaterialsOnCutRelease = false`,
   *      `allowNegativeMaterialStock = true` (совпадают с SQL-default
   *      и с legacy-поведением приватных getter-ов).
   *   3. Если у заказа есть `companyDivisionId` — читаем division-
   *      overrides; `null` ⇒ наследовать глобальное значение,
   *      `true`/`false` ⇒ принудительно переопределить.
   *
   * Возвращаем эффективные `boolean` плюс `source`, чтобы вызывающий
   * flow (логи / audit) мог указать, откуда пришло решение —
   * `DIVISION` или `COMPANY_DEFAULT`.
   *
   * Контракт:
   *   - READ-ONLY: сервис не пишет ни `CompanySettings`, ни
   *     `CompanyDivision`, чтобы горячий flow `issueToEmployee` /
   *     `MaterialIssue.post` не открывал побочных write-transactions;
   *   - метод ходит через основной prisma-клиент (не через tx), чтобы
   *     его можно было звать ДО открытия бизнес-транзакции
   *     (см. `MaterialIssuesService.post` — читаем флаг ДО
   *     `$transaction`);
   *   - transaction-aware sibling — {@link getEffectiveMaterialStockSettingsForOrderInTx}.
   *
   * Если заказа `orderId` не существует — возвращаем глобальные
   * дефолты с `source = COMPANY_DEFAULT`; вызывающий сам решает,
   * бросать ли `ORDER_NOT_FOUND` (мы не хотим дублировать
   * валидацию заказа в этом сервисе).
   */
  async getEffectiveMaterialStockSettingsForOrder(
    orderId: string,
  ): Promise<EffectiveMaterialStockSettings> {
    return this.computeEffectiveMaterialStockSettingsForOrder(
      this.prisma,
      orderId,
    );
  }

  /**
   * Transaction-aware версия {@link getEffectiveMaterialStockSettingsForOrder}:
   * использует тот же `Prisma.TransactionClient`, что и вызывающий
   * бизнес-flow (например, `PassportsService.issueToEmployee`). Это
   * важно, когда поведение флага должно учитывать изменения той же
   * транзакции (редкий кейс, но контракт симметричный).
   *
   * Как и не-tx sibling, метод НЕ пишет ни `CompanySettings`, ни
   * `CompanyDivision` — это read-only resolver. Возвращает тот же
   * shape.
   */
  async getEffectiveMaterialStockSettingsForOrderInTx(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<EffectiveMaterialStockSettings> {
    return this.computeEffectiveMaterialStockSettingsForOrder(tx, orderId);
  }

  private async computeEffectiveMaterialStockSettingsForOrder(
    client: Prisma.TransactionClient | PrismaService,
    orderId: string,
  ): Promise<EffectiveMaterialStockSettings> {
    const order = await client.order.findUnique({
      where: { id: orderId },
      select: { id: true, companyDivisionId: true },
    });

    const settings = await client.companySettings.findUnique({
      where: { id: COMPANY_SETTINGS_SINGLETON_ID },
      select: {
        autoIssueMaterialsOnCutRelease: true,
        allowNegativeMaterialStock: true,
      },
    });
    const companyAutoIssue = settings?.autoIssueMaterialsOnCutRelease ?? false;
    const companyAllowNegative = settings?.allowNegativeMaterialStock ?? true;

    const companyDivisionId = order?.companyDivisionId ?? null;
    if (!companyDivisionId) {
      return {
        autoIssueMaterialsOnCutRelease: companyAutoIssue,
        allowNegativeMaterialStock: companyAllowNegative,
        source: {
          companyDivisionId: null,
          autoIssueMaterialsOnCutRelease: 'COMPANY_DEFAULT',
          allowNegativeMaterialStock: 'COMPANY_DEFAULT',
        },
      };
    }

    const division = await client.companyDivision.findUnique({
      where: { id: companyDivisionId },
      select: {
        autoIssueMaterialsOnCutReleaseOverride: true,
        allowNegativeMaterialStockOverride: true,
      },
    });
    const autoIssueOverride =
      division?.autoIssueMaterialsOnCutReleaseOverride ?? null;
    const allowNegativeOverride =
      division?.allowNegativeMaterialStockOverride ?? null;

    return {
      autoIssueMaterialsOnCutRelease: autoIssueOverride ?? companyAutoIssue,
      allowNegativeMaterialStock: allowNegativeOverride ?? companyAllowNegative,
      source: {
        companyDivisionId,
        autoIssueMaterialsOnCutRelease:
          autoIssueOverride === null ? 'COMPANY_DEFAULT' : 'DIVISION',
        allowNegativeMaterialStock:
          allowNegativeOverride === null ? 'COMPANY_DEFAULT' : 'DIVISION',
      },
    };
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
    const changed: Record<
      string,
      { before: string | boolean | null; after: string | boolean | null }
    > = {};
    for (const key of UPDATABLE_STRING_FIELDS) {
      const value = dto[key];
      if (value === undefined) continue;
      const before = current[key] ?? null;
      const after = value ?? null;
      if (before === after) continue;
      (data as Record<string, string | null>)[key] = after;
      changed[key] = { before, after };
    }
    for (const key of UPDATABLE_BOOLEAN_FIELDS) {
      const value = dto[key];
      if (value === undefined) continue;
      const before = current[key];
      const after = value;
      if (before === after) continue;
      (data as Record<string, boolean>)[key] = after;
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
// Effective material stock policy (см.
// `CompanySettingsService.getEffectiveMaterialStockSettingsForOrder{InTx}`).
// ---------------------------------------------------------------------------

export type EffectiveMaterialStockSettingSource = 'DIVISION' | 'COMPANY_DEFAULT';

export interface EffectiveMaterialStockSettings {
  autoIssueMaterialsOnCutRelease: boolean;
  allowNegativeMaterialStock: boolean;
  source: {
    companyDivisionId: string | null;
    autoIssueMaterialsOnCutRelease: EffectiveMaterialStockSettingSource;
    allowNegativeMaterialStock: EffectiveMaterialStockSettingSource;
  };
}

// ---------------------------------------------------------------------------
// Field list & DTO mapper
// ---------------------------------------------------------------------------

const UPDATABLE_STRING_FIELDS = [
  'legalName',
  'shortName',
  'prefix',
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

/**
 * Boolean-флаги блока «Материалы и склад». Держим в отдельном списке,
 * чтобы в `update()` сравнивать их как boolean (а не как string|null)
 * и не писать NULL в NOT NULL-колонку.
 */
const UPDATABLE_BOOLEAN_FIELDS = [
  'autoIssueMaterialsOnCutRelease',
  'allowNegativeMaterialStock',
] as const satisfies ReadonlyArray<keyof UpdateCompanySettingsDto>;

type CompanySettingsRow = Prisma.CompanySettingsGetPayload<{}>;

function toDto(c: CompanySettingsRow): CompanySettingsDto {
  return {
    id: c.id,
    legalName: c.legalName,
    shortName: c.shortName,
    prefix: c.prefix,
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
    autoIssueMaterialsOnCutRelease: c.autoIssueMaterialsOnCutRelease,
    allowNegativeMaterialStock: c.allowNegativeMaterialStock,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
