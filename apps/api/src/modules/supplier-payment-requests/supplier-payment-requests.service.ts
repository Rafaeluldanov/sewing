import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateSupplierPaymentRequestDto,
  SupplierPaymentRequestDetailDto,
  SupplierPaymentRequestFileDto,
  SupplierPaymentRequestListItemDto,
  SupplierPaymentRequestStageDto,
  UpdateSupplierPaymentRequestDto,
} from '@sewing/shared/supplier-payment-requests';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PurchaseOrderNotFoundException,
  SupplierPaymentRequestNotFoundException,
} from '../../common/errors.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';
import { SupplierPaymentRequestNumberService } from './supplier-payment-request-number.service.js';
import { SupplierPaymentRequestsStorageService } from './supplier-payment-requests-storage.service.js';

/**
 * Сервис «Заявки на оплату поставщику».
 *
 * Заявка выписывается ВНУТРИ `PurchaseOrder`: поставщик и его имя
 * берутся из снимка PO, реквизиты — из формы (предзаполнены из карточки
 * поставщика, редактируемы). Сумма заявки делится на этапы по проценту;
 * сумма этапа считается здесь как `round(amount × percent / 100, 2)` —
 * клиентскую сумму не доверяем. «Σ процентов = 100%» НЕ enforce-им
 * (мягкое предупреждение — на стороне UI).
 *
 * На MVP заявка только создаётся/читается. Передача в казначейство
 * (этап → `SupplierPayment` + проводка) — следующий шаг; крюк
 * `SupplierPaymentRequestStage.supplierPaymentId` уже заложен.
 */
@Injectable()
export class SupplierPaymentRequestsService {
  private readonly logger = new Logger(SupplierPaymentRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numberService: SupplierPaymentRequestNumberService,
    private readonly storage: SupplierPaymentRequestsStorageService,
  ) {}

  // ===========================================================================
  // LIST / GET
  // ===========================================================================

  async listForPurchaseOrder(
    purchaseOrderId: string,
  ): Promise<SupplierPaymentRequestListItemDto[]> {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { id: true },
    });
    if (!po) throw new PurchaseOrderNotFoundException();

    const rows = await this.prisma.supplierPaymentRequest.findMany({
      where: { purchaseOrderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: REQUEST_LIST_INCLUDE,
    });
    return rows.map((row) => toListItemDto(row));
  }

  async get(id: string): Promise<SupplierPaymentRequestDetailDto> {
    const row = await this.prisma.supplierPaymentRequest.findUnique({
      where: { id },
      include: REQUEST_DETAIL_INCLUDE,
    });
    if (!row) throw new SupplierPaymentRequestNotFoundException();
    return toDetailDto(row);
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async create(
    purchaseOrderId: string,
    dto: CreateSupplierPaymentRequestDto,
    files: UploadedFileLike[],
    actorEmployeeId?: string | null,
  ): Promise<SupplierPaymentRequestDetailDto> {
    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { supplier: true },
    });
    if (!po) throw new PurchaseOrderNotFoundException();

    const amount = new Prisma.Decimal(dto.amount);

    // Снимок реквизитов: значение из формы (даже явный `null` = очистка)
    // имеет приоритет; если поле в форме не пришло — берём из карточки
    // поставщика.
    const pick = (
      formValue: string | null | undefined,
      supplierValue: string | null,
    ): string | null =>
      formValue !== undefined ? formValue : (supplierValue ?? null);

    // Сумма этапа = round(amount × percent / 100, 2). sortOrder — 1..N.
    const stagesData = dto.stages.map((stage, index) => {
      const percent = new Prisma.Decimal(stage.percent);
      // toDecimalPlaces без явного режима = ROUND_HALF_UP (дефолт decimal.js).
      const stageAmount = amount.mul(percent).div(100).toDecimalPlaces(2);
      return {
        sortOrder: index + 1,
        percent,
        amount: stageAmount,
        plannedPayDate: stage.plannedPayDate
          ? new Date(stage.plannedPayDate)
          : null,
        status: 'PENDING',
        comment: stage.comment ?? null,
      };
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.numberService.nextNumber(tx);
      return tx.supplierPaymentRequest.create({
        data: {
          number,
          purchaseOrderId: po.id,
          supplierId: po.supplierId,
          supplierNameSnapshot: po.supplierNameSnapshot,
          legalNameSnapshot: pick(dto.legalName, po.supplier.legalName),
          innSnapshot: pick(dto.inn, po.supplier.inn),
          kppSnapshot: pick(dto.kpp, po.supplier.kpp),
          bankNameSnapshot: pick(dto.bankName, po.supplier.bankName),
          bankAccountSnapshot: pick(dto.bankAccount, po.supplier.bankAccount),
          bankBikSnapshot: pick(dto.bankBik, po.supplier.bankBik),
          bankCorrAccountSnapshot: pick(
            dto.bankCorrAccount,
            po.supplier.bankCorrAccount,
          ),
          amount,
          currency: dto.currency ?? 'RUB',
          status: 'DRAFT',
          comment: dto.comment ?? null,
          createdById: actorEmployeeId ?? null,
          stages: { create: stagesData },
        },
        select: { id: true },
      });
    });

    // Файлы пишем после создания заявки (запись на диск не транзакционна,
    // как в `ConstructorTasksService`). Сбой одного файла не откатывает
    // заявку — менеджер сможет добавить недостающее позже.
    let savedFiles = 0;
    for (const file of files) {
      const saved = await this.storage.saveRequestFile(created.id, file);
      await this.prisma.supplierPaymentRequestFile.create({
        data: {
          requestId: created.id,
          fileUrl: saved.publicUrl,
          originalFileName: saved.originalFileName,
          contentType: saved.contentType,
          sizeBytes: saved.sizeBytes,
        },
      });
      savedFiles += 1;
    }

    this.logger.log(
      `event=supplier_payment_request.create id=${created.id} po=${po.id} ` +
        `amount=${amount.toString()} stages=${stagesData.length} files=${savedFiles}`,
    );
    await this.audit.log({
      event: 'SUPPLIER_PAYMENT_REQUEST_CREATED',
      entityType: 'SUPPLIER_PAYMENT_REQUEST',
      entityId: created.id,
      payload: {
        purchaseOrderId: po.id,
        supplierId: po.supplierId,
        amount: amount.toString(),
        stagesCount: stagesData.length,
        filesCount: savedFiles,
      },
      employeeId: actorEmployeeId ?? null,
    });

    return this.get(created.id);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  /**
   * Редактировать заявку. Сумма/реквизиты/комментарий/статус
   * перезаписываются; этапы пересоздаются целиком (полная замена набора,
   * сумма этапа пересчитывается так же, как при создании); вложения —
   * `keepFileIds` оставить, прочие удалить, `files` добавить.
   */
  async update(
    id: string,
    dto: UpdateSupplierPaymentRequestDto,
    files: UploadedFileLike[],
    actorEmployeeId?: string | null,
  ): Promise<SupplierPaymentRequestDetailDto> {
    const existing = await this.prisma.supplierPaymentRequest.findUnique({
      where: { id },
      include: { files: true },
    });
    if (!existing) throw new SupplierPaymentRequestNotFoundException();

    const amount = new Prisma.Decimal(dto.amount);

    // Сумма этапа = round(amount × percent / 100, 2). sortOrder — 1..N.
    const stagesData = dto.stages.map((stage, index) => {
      const percent = new Prisma.Decimal(stage.percent);
      const stageAmount = amount.mul(percent).div(100).toDecimalPlaces(2);
      return {
        sortOrder: index + 1,
        percent,
        amount: stageAmount,
        plannedPayDate: stage.plannedPayDate
          ? new Date(stage.plannedPayDate)
          : null,
        status: 'PENDING',
        comment: stage.comment ?? null,
      };
    });

    const keep = new Set(dto.keepFileIds ?? []);
    const filesToRemove = existing.files.filter((f) => !keep.has(f.id));

    await this.prisma.$transaction(async (tx) => {
      // Этапы заменяем целиком: на MVP у них нет связи с оплатой
      // (`supplierPaymentId` всегда null), пересоздать безопасно.
      await tx.supplierPaymentRequestStage.deleteMany({
        where: { requestId: id },
      });
      if (filesToRemove.length > 0) {
        await tx.supplierPaymentRequestFile.deleteMany({
          where: { id: { in: filesToRemove.map((f) => f.id) } },
        });
      }
      await tx.supplierPaymentRequest.update({
        where: { id },
        data: {
          amount,
          currency: dto.currency ?? 'RUB',
          comment: dto.comment ?? null,
          status: dto.status ?? existing.status,
          // Реквизиты — снимок: форма редактирования всегда шлёт текущие
          // значения (или явный null = очистка), берём как есть.
          legalNameSnapshot: dto.legalName ?? null,
          innSnapshot: dto.inn ?? null,
          kppSnapshot: dto.kpp ?? null,
          bankNameSnapshot: dto.bankName ?? null,
          bankAccountSnapshot: dto.bankAccount ?? null,
          bankBikSnapshot: dto.bankBik ?? null,
          bankCorrAccountSnapshot: dto.bankCorrAccount ?? null,
          stages: { create: stagesData },
        },
      });
    });

    // Файлы — вне транзакции (диск не транзакционен, как при создании):
    // сначала чистим удалённые, затем дописываем новые.
    for (const f of filesToRemove) {
      await this.storage.deleteByPublicUrl(f.fileUrl);
    }
    let addedFiles = 0;
    for (const file of files) {
      const saved = await this.storage.saveRequestFile(id, file);
      await this.prisma.supplierPaymentRequestFile.create({
        data: {
          requestId: id,
          fileUrl: saved.publicUrl,
          originalFileName: saved.originalFileName,
          contentType: saved.contentType,
          sizeBytes: saved.sizeBytes,
        },
      });
      addedFiles += 1;
    }

    this.logger.log(
      `event=supplier_payment_request.update id=${id} amount=${amount.toString()} ` +
        `stages=${stagesData.length} filesKept=${keep.size} ` +
        `filesRemoved=${filesToRemove.length} filesAdded=${addedFiles}`,
    );
    await this.audit.log({
      event: 'SUPPLIER_PAYMENT_REQUEST_UPDATED',
      entityType: 'SUPPLIER_PAYMENT_REQUEST',
      entityId: id,
      payload: {
        amount: amount.toString(),
        status: dto.status ?? existing.status,
        stagesCount: stagesData.length,
        filesRemoved: filesToRemove.length,
        filesAdded: addedFiles,
      },
      employeeId: actorEmployeeId ?? null,
    });

    return this.get(id);
  }

  // ===========================================================================
  // DELETE
  // ===========================================================================

  /**
   * Удалить заявку целиком. Каскад БД (`onDelete: Cascade`) уберёт этапы
   * и строки файлов; физические файлы с диска удаляем сами (после
   * успешного удаления записи).
   */
  async delete(id: string, actorEmployeeId?: string | null): Promise<void> {
    const existing = await this.prisma.supplierPaymentRequest.findUnique({
      where: { id },
      include: { files: true },
    });
    if (!existing) throw new SupplierPaymentRequestNotFoundException();

    await this.prisma.supplierPaymentRequest.delete({ where: { id } });
    for (const f of existing.files) {
      await this.storage.deleteByPublicUrl(f.fileUrl);
    }

    this.logger.log(
      `event=supplier_payment_request.delete id=${id} ` +
        `po=${existing.purchaseOrderId} files=${existing.files.length}`,
    );
    await this.audit.log({
      event: 'SUPPLIER_PAYMENT_REQUEST_DELETED',
      entityType: 'SUPPLIER_PAYMENT_REQUEST',
      entityId: id,
      payload: {
        purchaseOrderId: existing.purchaseOrderId,
        number: existing.number,
        filesCount: existing.files.length,
      },
      employeeId: actorEmployeeId ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Prisma includes + mappers
// ---------------------------------------------------------------------------

const REQUEST_LIST_INCLUDE = {
  _count: { select: { stages: true, files: true } },
} satisfies Prisma.SupplierPaymentRequestInclude;

const REQUEST_DETAIL_INCLUDE = {
  stages: { orderBy: { sortOrder: 'asc' } },
  files: { orderBy: { createdAt: 'asc' } },
  _count: { select: { stages: true, files: true } },
} satisfies Prisma.SupplierPaymentRequestInclude;

function toListItemDto(
  row: Prisma.SupplierPaymentRequestGetPayload<{
    include: typeof REQUEST_LIST_INCLUDE;
  }>,
): SupplierPaymentRequestListItemDto {
  return {
    id: row.id,
    number: row.number,
    purchaseOrderId: row.purchaseOrderId,
    supplierId: row.supplierId,
    supplierNameSnapshot: row.supplierNameSnapshot,
    amount: row.amount.toString(),
    currency: row.currency,
    status: row.status,
    stagesCount: row._count.stages,
    filesCount: row._count.files,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function stageToDto(
  s: Prisma.SupplierPaymentRequestStageGetPayload<{}>,
): SupplierPaymentRequestStageDto {
  return {
    id: s.id,
    sortOrder: s.sortOrder,
    percent: s.percent.toString(),
    amount: s.amount.toString(),
    plannedPayDate: s.plannedPayDate ? s.plannedPayDate.toISOString() : null,
    status: s.status,
    supplierPaymentId: s.supplierPaymentId,
    comment: s.comment,
  };
}

function fileToDto(
  f: Prisma.SupplierPaymentRequestFileGetPayload<{}>,
): SupplierPaymentRequestFileDto {
  return {
    id: f.id,
    fileUrl: f.fileUrl,
    originalFileName: f.originalFileName,
    contentType: f.contentType,
    sizeBytes: f.sizeBytes,
    createdAt: f.createdAt.toISOString(),
  };
}

function toDetailDto(
  row: Prisma.SupplierPaymentRequestGetPayload<{
    include: typeof REQUEST_DETAIL_INCLUDE;
  }>,
): SupplierPaymentRequestDetailDto {
  return {
    ...toListItemDto(row),
    legalNameSnapshot: row.legalNameSnapshot,
    innSnapshot: row.innSnapshot,
    kppSnapshot: row.kppSnapshot,
    bankNameSnapshot: row.bankNameSnapshot,
    bankAccountSnapshot: row.bankAccountSnapshot,
    bankBikSnapshot: row.bankBikSnapshot,
    bankCorrAccountSnapshot: row.bankCorrAccountSnapshot,
    comment: row.comment,
    createdById: row.createdById,
    stages: row.stages.map(stageToDto),
    files: row.files.map(fileToDto),
  };
}
