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
  CashFlowItemNotFoundException,
  PurchaseOrderNotFoundException,
  SupplierNotFoundException,
  SupplierPaymentRequestNotFoundException,
} from '../../common/errors.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';
import { SupplierPaymentService } from '../treasury/supplier-payment.service.js';
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
    private readonly supplierPayments: SupplierPaymentService,
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

    // Плательщик: по умолчанию поставщик заказа, но форма может выбрать
    // другого активного — тогда снимаем его имя/реквизиты. Имя для
    // снимка берём из снимка PO, если плательщик совпадает с заказом,
    // иначе — актуальное имя выбранной карточки.
    let payer = po.supplier;
    let supplierNameSnapshot = po.supplierNameSnapshot;
    if (dto.supplierId && dto.supplierId !== po.supplierId) {
      const chosen = await this.prisma.supplier.findUnique({
        where: { id: dto.supplierId },
      });
      if (!chosen) throw new SupplierNotFoundException();
      payer = chosen;
      supplierNameSnapshot = chosen.name;
    }

    // Статья ДДС: снимаем имя по id (если выбрана). null = без статьи.
    const cashFlowItem = await this.resolveCashFlowItem(dto.cashFlowItemId);

    const amount = new Prisma.Decimal(dto.amount);

    // Снимок реквизитов: значение из формы (даже явный `null` = очистка)
    // имеет приоритет; если поле в форме не пришло — берём из карточки
    // поставщика-плательщика.
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
      const row = await tx.supplierPaymentRequest.create({
        data: {
          number,
          purchaseOrderId: po.id,
          supplierId: payer.id,
          supplierNameSnapshot,
          cashFlowItemId: cashFlowItem.id,
          cashFlowItemNameSnapshot: cashFlowItem.name,
          legalNameSnapshot: pick(dto.legalName, payer.legalName),
          innSnapshot: pick(dto.inn, payer.inn),
          kppSnapshot: pick(dto.kpp, payer.kpp),
          bankNameSnapshot: pick(dto.bankName, payer.bankName),
          bankAccountSnapshot: pick(dto.bankAccount, payer.bankAccount),
          bankBikSnapshot: pick(dto.bankBik, payer.bankBik),
          bankCorrAccountSnapshot: pick(
            dto.bankCorrAccount,
            payer.bankCorrAccount,
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
      return { id: row.id, number };
    });

    // Хэндофф в казначейство: по каждому этапу — черновик «заявки на
    // расход» (`SupplierPayment`). Best-effort и опт-ин: если в настройках
    // не задан счёт для оплат поставщикам — не делаем ничего (нулевая
    // регрессия); сбой по одному этапу не валит создание заявки.
    await this.autoCreateExpenseRequests({
      requestId: created.id,
      requestNumber: created.number,
      supplierId: payer.id,
      supplierNameSnapshot,
      purchaseOrderId: po.id,
      purchaseOrderNumber: po.number,
      cashFlowItemId: cashFlowItem.id,
      actorEmployeeId,
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
        supplierId: payer.id,
        cashFlowItemId: cashFlowItem.id,
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

    // Статья ДДС: снимок-замена (как реквизиты). Имя резолвим по id.
    const cashFlowItem = await this.resolveCashFlowItem(dto.cashFlowItemId);

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
          cashFlowItemId: cashFlowItem.id,
          cashFlowItemNameSnapshot: cashFlowItem.name,
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

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Хэндофф «заявка на оплату → казначейство». По каждому этапу заявки
   * создаём черновик «заявки на расход» (`SupplierPayment`) и привязываем
   * его к этапу (`stage.supplierPaymentId`).
   *
   * Опт-ин: счёт берётся из `TreasurySettings.supplierAccountId`; если он
   * не задан — ничего не делаем (нулевая регрессия). Статья ДДС — из
   * заявки (`cashFlowItemId`), иначе fallback `supplierItemId` из настроек.
   * Best-effort: сбой по одному этапу логируем и идём дальше, создание
   * заявки на оплату не валится.
   */
  private async autoCreateExpenseRequests(params: {
    requestId: string;
    requestNumber: string;
    supplierId: string;
    supplierNameSnapshot: string;
    purchaseOrderId: string;
    purchaseOrderNumber: string;
    cashFlowItemId: string | null;
    actorEmployeeId?: string | null;
  }): Promise<void> {
    const settings = await this.prisma.treasurySettings.findUnique({
      where: { id: 'default' },
      select: { supplierAccountId: true, supplierItemId: true },
    });
    const accountId = settings?.supplierAccountId ?? null;
    const itemId = params.cashFlowItemId ?? settings?.supplierItemId ?? null;
    if (!accountId || !itemId) {
      this.logger.log(
        `event=supplier_payment_request.handoff_skipped request=${params.requestId} ` +
          `accountConfigured=${Boolean(accountId)} itemResolved=${Boolean(itemId)}`,
      );
      return;
    }

    const stages = await this.prisma.supplierPaymentRequestStage.findMany({
      where: { requestId: params.requestId },
      orderBy: { sortOrder: 'asc' },
    });
    for (const stage of stages) {
      if (stage.supplierPaymentId) continue;
      try {
        const payment = await this.supplierPayments.createDraftFromRequestStage({
          supplierId: params.supplierId,
          supplierNameSnapshot: params.supplierNameSnapshot,
          purchaseOrderId: params.purchaseOrderId,
          purchaseOrderNumberSnapshot: params.purchaseOrderNumber,
          accountId,
          itemId,
          amount: stage.amount,
          comment: `Заявка ${params.requestNumber}, этап ${stage.sortOrder}`,
          createdById: params.actorEmployeeId ?? null,
        });
        await this.prisma.supplierPaymentRequestStage.update({
          where: { id: stage.id },
          data: { supplierPaymentId: payment.id },
        });
      } catch (e) {
        this.logger.warn(
          `event=supplier_payment_request.handoff_failed request=${params.requestId} ` +
            `stage=${stage.id} error=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Резолв статьи ДДС по id для снимка `{ id, name }`. `null`/`undefined`
   * → `{ id: null, name: null }` (без статьи). Несуществующий id →
   * `CashFlowItemNotFoundException` (UI предлагает только активные, но от
   * гонок и прямого API защищаемся).
   */
  private async resolveCashFlowItem(
    itemId: string | null | undefined,
  ): Promise<{ id: string | null; name: string | null }> {
    if (!itemId) return { id: null, name: null };
    const item = await this.prisma.cashFlowItem.findUnique({
      where: { id: itemId },
      select: { id: true, name: true },
    });
    if (!item) throw new CashFlowItemNotFoundException();
    return { id: item.id, name: item.name };
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
    cashFlowItemId: row.cashFlowItemId,
    cashFlowItemNameSnapshot: row.cashFlowItemNameSnapshot,
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
