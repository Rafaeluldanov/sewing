import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CompanyDivisionDto,
  CreateCompanyDivisionDto,
  ListCompanyDivisionsQuery,
  UpdateCompanyDivisionDto,
} from '@sewing/shared/company-divisions';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CompanyDivisionCodeTakenException,
  CompanyDivisionNotFoundException,
} from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис «Подразделения компании» — master-справочник подразделений
 * заказа и display screens (см. `prisma/schema.prisma::CompanyDivision`,
 * `docs/domain.md §«Подразделения заказа»`,
 * `docs/erd.md §«CompanyDivision»`).
 *
 * Скоуп MVP — list/get/create/update. Удаление out-of-scope: менеджер
 * мягко гасит карточку через PATCH `{ isActive: false }`. По умолчанию
 * `list` отдаёт только активных — селекты не должны видеть «зомби».
 *
 * PHASE 1: на этот справочник ссылаются `Order.companyDivisionId` и
 * `DisplayScreenConfig.companyDivisionId`. Базовые карточки
 * `MARKETPLACE` / `OTHER` (`code` совпадает с legacy
 * `enum OrderDivision`) гарантированно существуют в БД — их
 * upsert-ит миграция `…_link_company_divisions_to_orders` и
 * `prisma/seed.ts` / `tests/utils/seed.ts`. Backend синхронизирует
 * `code ↔ legacy enum` сервисами `OrdersService` /
 * `DisplayScreensService` до PHASE 2 (см.
 * `OrdersService.resolveCompanyDivisionForOrder`).
 *
 * Hard-delete не делаем: на FK с `Order.companyDivisionId` стоит
 * `ON DELETE SET NULL`, и физическое удаление карточки `MARKETPLACE`/
 * `OTHER` оставило бы заказы без привязки и сломало бы
 * `getCutterCompensationSchemeForDivision` для legacy-fallback. Soft-
 * delete через `isActive=false` безопасен — заказы остаются
 * привязанными.
 */
@Injectable()
export class CompanyDivisionsService {
  private readonly logger = new Logger(CompanyDivisionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListCompanyDivisionsQuery): Promise<CompanyDivisionDto[]> {
    const where: Prisma.CompanyDivisionWhereInput = {};
    if (!query.includeInactive) {
      where.isActive = true;
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.companyDivision.findMany({
      where,
      orderBy: [
        { isActive: 'desc' },
        { sortOrder: 'asc' },
        { name: 'asc' },
      ],
    });
    return rows.map(toDto);
  }

  async get(id: string): Promise<CompanyDivisionDto> {
    const row = await this.prisma.companyDivision.findUnique({ where: { id } });
    if (!row) throw new CompanyDivisionNotFoundException();
    return toDto(row);
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async create(
    dto: CreateCompanyDivisionDto,
    actorEmployeeId?: string | null,
  ): Promise<CompanyDivisionDto> {
    try {
      const created = await this.prisma.companyDivision.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 100,
          // Override-поля (см.
          // `prisma/schema.prisma::CompanyDivision.{autoIssueMaterialsOnCutReleaseOverride, allowNegativeMaterialStockOverride}`,
          // `packages/shared/src/company-divisions.ts`).
          // `undefined` ⇒ Prisma оставит `null` (дефолт колонки —
          // «наследовать глобальные настройки»); `null`/`boolean`
          // ⇒ сохраняется как есть.
          autoIssueMaterialsOnCutReleaseOverride:
            dto.autoIssueMaterialsOnCutReleaseOverride ?? null,
          allowNegativeMaterialStockOverride:
            dto.allowNegativeMaterialStockOverride ?? null,
        },
      });
      this.logger.log(
        `event=company-division.create id=${created.id} code="${created.code}"`,
      );
      await this.audit.log({
        event: 'COMPANY_DIVISION_CREATED',
        entityType: 'COMPANY_DIVISION',
        entityId: created.id,
        payload: {
          code: created.code,
          name: created.name,
          description: created.description,
          isActive: created.isActive,
          sortOrder: created.sortOrder,
          autoIssueMaterialsOnCutReleaseOverride:
            created.autoIssueMaterialsOnCutReleaseOverride,
          allowNegativeMaterialStockOverride:
            created.allowNegativeMaterialStockOverride,
        },
        employeeId: actorEmployeeId ?? null,
      });
      return toDto(created);
    } catch (e) {
      this.translateUniqueError(e);
    }
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async update(
    id: string,
    dto: UpdateCompanyDivisionDto,
    actorEmployeeId?: string | null,
  ): Promise<CompanyDivisionDto> {
    const current = await this.prisma.companyDivision.findUnique({
      where: { id },
    });
    if (!current) throw new CompanyDivisionNotFoundException();

    const data: Prisma.CompanyDivisionUpdateInput = {};
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    // Override-поля. `undefined` ⇒ не трогаем (старое значение в БД
    // сохраняется). `null` ⇒ сбрасываем в «наследовать глобальные
    // настройки компании». `true` / `false` ⇒ принудительный override
    // (см. `packages/shared/src/company-divisions.ts`,
    // `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrder`).
    if (dto.autoIssueMaterialsOnCutReleaseOverride !== undefined) {
      data.autoIssueMaterialsOnCutReleaseOverride =
        dto.autoIssueMaterialsOnCutReleaseOverride;
    }
    if (dto.allowNegativeMaterialStockOverride !== undefined) {
      data.allowNegativeMaterialStockOverride =
        dto.allowNegativeMaterialStockOverride;
    }

    try {
      const updated = await this.prisma.companyDivision.update({
        where: { id },
        data,
      });
      this.logger.log(
        `event=company-division.update id=${updated.id} code="${updated.code}" active=${updated.isActive}`,
      );
      await this.audit.log({
        event: 'COMPANY_DIVISION_UPDATED',
        entityType: 'COMPANY_DIVISION',
        entityId: updated.id,
        payload: {
          before: {
            code: current.code,
            name: current.name,
            description: current.description,
            isActive: current.isActive,
            sortOrder: current.sortOrder,
            autoIssueMaterialsOnCutReleaseOverride:
              current.autoIssueMaterialsOnCutReleaseOverride,
            allowNegativeMaterialStockOverride:
              current.allowNegativeMaterialStockOverride,
          },
          after: {
            code: updated.code,
            name: updated.name,
            description: updated.description,
            isActive: updated.isActive,
            sortOrder: updated.sortOrder,
            autoIssueMaterialsOnCutReleaseOverride:
              updated.autoIssueMaterialsOnCutReleaseOverride,
            allowNegativeMaterialStockOverride:
              updated.allowNegativeMaterialStockOverride,
          },
        },
        employeeId: actorEmployeeId ?? null,
      });
      return toDto(updated);
    } catch (e) {
      this.translateUniqueError(e);
    }
  }

  // ===========================================================================
  // helpers
  // ===========================================================================

  private translateUniqueError(e: unknown): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.includes('code')) {
        throw new CompanyDivisionCodeTakenException();
      }
    }
    throw e as Error;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type CompanyDivisionRow = Prisma.CompanyDivisionGetPayload<{}>;

function toDto(c: CompanyDivisionRow): CompanyDivisionDto {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    autoIssueMaterialsOnCutReleaseOverride:
      c.autoIssueMaterialsOnCutReleaseOverride,
    allowNegativeMaterialStockOverride: c.allowNegativeMaterialStockOverride,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}
