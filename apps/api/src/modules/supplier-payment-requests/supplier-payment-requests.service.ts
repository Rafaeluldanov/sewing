import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateSupplierPaymentRequestDto,
  SupplierPaymentRequestDetailDto,
  SupplierPaymentRequestFileDto,
  SupplierPaymentRequestListItemDto,
  SupplierPaymentRequestStageDto,
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
