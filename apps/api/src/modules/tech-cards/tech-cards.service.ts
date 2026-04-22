import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateTechCardDto,
  ListTechCardsQuery,
  TechCardMaterialLineDto,
  TechCardMaterialLineInputDto,
  TechCardOutsourceLineDto,
  TechCardOutsourceLineInputDto,
  TechCardTemplateDetailDto,
  TechCardTemplateSummaryDto,
  UpdateTechCardDto,
} from '@sewing/shared/tech-cards';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  TechCardCodeTakenException,
  TechCardInactiveException,
  TechCardNotFoundException,
} from '../../common/errors.js';

/**
 * CRUD шаблонов техкарт. По духу аналогичен `RoutesService`:
 *   - admin создаёт `TechCardTemplate` со списками строк
 *     (`materialLines` + `outsourceLines`);
 *   - `sortOrder` нормализуется по позиции в массиве как `(i + 1) * 10`,
 *     UI работает с обычным порядком и не передаёт его явно;
 *   - PATCH со строками выполняет full-replace в одной транзакции —
 *     как `RoutesService.update` и `EquipmentOperationsService`;
 *   - snapshot заказа (`OrderMaterialRequirement[]` /
 *     `OrderOutsourceRequirement[]`) этот сервис не трогает: его
 *     создаёт `OrdersService.start()` (ADR-0022).
 *
 * Snapshot заказа независим от шаблона: FK
 * `OrderMaterial/OutsourceRequirement.sourceTechCardLineId` имеет
 * `ON DELETE SET NULL`, поэтому удаление строки техкарты не ломает
 * фиксированный план уже запущенных заказов.
 */
@Injectable()
export class TechCardsService {
  private readonly logger = new Logger(TechCardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(query: ListTechCardsQuery): Promise<TechCardTemplateSummaryDto[]> {
    const where: Prisma.TechCardTemplateWhereInput = {};
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.techCardTemplate.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      include: {
        _count: { select: { materialLines: true, outsourceLines: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      materialLinesCount: row._count.materialLines,
      outsourceLinesCount: row._count.outsourceLines,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<TechCardTemplateDetailDto> {
    const row = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      include: {
        materialLines: { orderBy: { sortOrder: 'asc' } },
        outsourceLines: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!row) throw new TechCardNotFoundException();
    return this.toDetailDto(row);
  }

  /**
   * Используется `OrdersService.start()` для построения snapshot-а
   * техкарты. По смыслу аналог `RoutesService.getActiveStepsForSnapshot`.
   * Активность шаблона здесь не проверяем: это уже делает
   * `assertTechCardUsable` при `create`/`update` заказа; в `start()`
   * допустимо запустить заказ с уже деактивированной техкартой
   * (план зафиксируется как был).
   */
  async getLinesForSnapshot(techCardId: string): Promise<{
    materialLines: {
      id: string;
      sortOrder: number;
      name: string;
      unit: string;
      qtyPerUnit: Prisma.Decimal;
      note: string | null;
    }[];
    outsourceLines: {
      id: string;
      sortOrder: number;
      name: string;
      unit: string | null;
      qtyPerUnit: Prisma.Decimal | null;
      vendorName: string | null;
      note: string | null;
    }[];
  }> {
    const tpl = await this.prisma.techCardTemplate.findUnique({
      where: { id: techCardId },
      include: {
        materialLines: { orderBy: { sortOrder: 'asc' } },
        outsourceLines: { orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!tpl) throw new TechCardNotFoundException();
    return {
      materialLines: tpl.materialLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit,
        note: l.note,
      })),
      outsourceLines: tpl.outsourceLines.map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit,
        vendorName: l.vendorName,
        note: l.note,
      })),
    };
  }

  /**
   * Soft-protection для `OrdersService.create`/`update`: 404 если
   * техкарты нет, 409 если деактивирована. UI обычно прячет неактивные
   * в селекте, но прямой POST/PATCH `/api/orders` мы не доверяем.
   */
  async assertTechCardUsable(id: string): Promise<void> {
    const tpl = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
    if (!tpl) throw new TechCardNotFoundException();
    if (!tpl.isActive) throw new TechCardInactiveException();
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateTechCardDto): Promise<TechCardTemplateDetailDto> {
    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.techCardTemplate.create({
          data: {
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive ?? true,
          },
        });
        if (dto.materialLines.length > 0) {
          await tx.techCardMaterialLine.createMany({
            data: dto.materialLines.map((l, i) =>
              this.materialLineCreateData(created.id, l, i),
            ),
          });
        }
        if (dto.outsourceLines.length > 0) {
          await tx.techCardOutsourceLine.createMany({
            data: dto.outsourceLines.map((l, i) =>
              this.outsourceLineCreateData(created.id, l, i),
            ),
          });
        }
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=tech_card.create id=${createdId} code=${dto.code} ` +
        `materials=${dto.materialLines.length} outsource=${dto.outsourceLines.length}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // UPDATE (full-replace для строк)
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateTechCardDto,
  ): Promise<TechCardTemplateDetailDto> {
    const existing = await this.prisma.techCardTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new TechCardNotFoundException();

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.TechCardTemplateUpdateInput = {};
        if (dto.code !== undefined) data.code = dto.code;
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;
        if (Object.keys(data).length > 0) {
          await tx.techCardTemplate.update({ where: { id }, data });
        }

        if (dto.materialLines !== undefined) {
          await tx.techCardMaterialLine.deleteMany({
            where: { techCardId: id },
          });
          if (dto.materialLines.length > 0) {
            await tx.techCardMaterialLine.createMany({
              data: dto.materialLines.map((l, i) =>
                this.materialLineCreateData(id, l, i),
              ),
            });
          }
        }

        if (dto.outsourceLines !== undefined) {
          await tx.techCardOutsourceLine.deleteMany({
            where: { techCardId: id },
          });
          if (dto.outsourceLines.length > 0) {
            await tx.techCardOutsourceLine.createMany({
              data: dto.outsourceLines.map((l, i) =>
                this.outsourceLineCreateData(id, l, i),
              ),
            });
          }
        }
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=tech_card.update id=${id} fields=${Object.keys(dto).join(',')}`,
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private materialLineCreateData(
    techCardId: string,
    line: TechCardMaterialLineInputDto,
    index: number,
  ): Prisma.TechCardMaterialLineCreateManyInput {
    return {
      techCardId,
      sortOrder: (index + 1) * 10,
      name: line.name,
      unit: line.unit,
      // Zod гарантирует "положительная строка-Decimal"; null здесь
      // невозможен (поле required в схеме), но TS-сужение требует
      // проверки.
      qtyPerUnit: new Prisma.Decimal(line.qtyPerUnit ?? '0'),
      note: line.note,
    };
  }

  private outsourceLineCreateData(
    techCardId: string,
    line: TechCardOutsourceLineInputDto,
    index: number,
  ): Prisma.TechCardOutsourceLineCreateManyInput {
    return {
      techCardId,
      sortOrder: (index + 1) * 10,
      name: line.name,
      unit: line.unit,
      qtyPerUnit:
        line.qtyPerUnit == null ? null : new Prisma.Decimal(line.qtyPerUnit),
      vendorName: line.vendorName,
      note: line.note,
    };
  }

  private toDetailDto(
    row: Prisma.TechCardTemplateGetPayload<{
      include: { materialLines: true; outsourceLines: true };
    }>,
  ): TechCardTemplateDetailDto {
    const materialLines: TechCardMaterialLineDto[] = row.materialLines
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit.toString(),
        note: l.note,
      }));
    const outsourceLines: TechCardOutsourceLineDto[] = row.outsourceLines
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((l) => ({
        id: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit ? l.qtyPerUnit.toString() : null,
        vendorName: l.vendorName,
        note: l.note,
      }));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      materialLinesCount: materialLines.length,
      outsourceLinesCount: outsourceLines.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      materialLines,
      outsourceLines,
    };
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new TechCardCodeTakenException();
    }
  }
}
