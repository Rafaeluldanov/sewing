import { Injectable, Logger } from '@nestjs/common';
import {
  CuttingClosureRequestStatus,
  OrderStatus,
  PassportStatus,
  Prisma,
} from '@prisma/client';
import type {
  CreateCuttingClosureRequestDto,
  CuttingClosureRequestDto,
  ListCuttingClosureRequestsQuery,
  ReviewCuttingClosureRequestDto,
} from '@sewing/shared/cutting-closure';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CuttingClosureAlreadyApprovedException,
  CuttingClosureAlreadyRequestedException,
  CuttingClosureOrderNotInProductionException,
  CuttingClosureRequestNotFoundException,
  CuttingClosureRequestNotPendingException,
  CuttingClosureSizeNotInOrderException,
} from '../../common/errors.js';

type RequestRow = Prisma.CuttingClosureRequestGetPayload<{
  include: {
    order: true;
    product: true;
    size: true;
    requestedByEmployee: true;
    reviewedByEmployee: true;
  };
}>;

/**
 * Сервис «Закрытие раскроя по размеру через заявку» (ADR-0018).
 *
 * Одна активная (`REQUESTED`) и одна подтверждённая (`APPROVED`) заявка
 * на пару `(orderId, productId, sizeId)` — гарантировано БД через
 * partial unique indexes (`cutting_closure_request_active_uniq`,
 * `cutting_closure_request_approved_uniq`). Сервис ловит P2002 и
 * переводит его в понятную бизнес-ошибку.
 *
 * APPROVED-заявка читается из БД при выпуске паспорта (`PassportsService`)
 * и блокирует новые `Passport` по этой строке.
 */
@Injectable()
export class CuttingClosureService {
  private readonly logger = new Logger(CuttingClosureService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(
    dto: CreateCuttingClosureRequestDto,
    requestedByEmployeeId: string,
  ): Promise<CuttingClosureRequestDto> {
    const orderItem = await this.prisma.orderItem.findUnique({
      where: {
        orderId_productId_sizeId: {
          orderId: dto.orderId,
          productId: dto.productId,
          sizeId: dto.sizeId,
        },
      },
      include: { order: { select: { status: true } } },
    });
    if (!orderItem) throw new CuttingClosureSizeNotInOrderException();
    if (orderItem.order.status !== OrderStatus.IN_PRODUCTION) {
      throw new CuttingClosureOrderNotInProductionException();
    }

    // Быстрые pre-checks: дают понятный код ошибки. Жёсткая защита от
    // гонок — partial unique indexes ниже.
    const existingApproved = await this.prisma.cuttingClosureRequest.findFirst({
      where: {
        orderId: dto.orderId,
        productId: dto.productId,
        sizeId: dto.sizeId,
        status: CuttingClosureRequestStatus.APPROVED,
      },
      select: { id: true },
    });
    if (existingApproved) throw new CuttingClosureAlreadyApprovedException();

    try {
      const created = await this.prisma.cuttingClosureRequest.create({
        data: {
          orderId: dto.orderId,
          productId: dto.productId,
          sizeId: dto.sizeId,
          reason: dto.reason ?? null,
          requestedByEmployeeId,
          status: CuttingClosureRequestStatus.REQUESTED,
        },
        include: this.includeAll(),
      });
      this.logger.log(
        `event=cutting-closure.request id=${created.id} orderId=${dto.orderId} sizeId=${dto.sizeId} by=${requestedByEmployeeId}`,
      );
      return this.toDto(created);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Конкурентная попытка подать вторую REQUESTED — ловим
        // partial unique index `cutting_closure_request_active_uniq`.
        throw new CuttingClosureAlreadyRequestedException();
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // LIST / GET
  // -------------------------------------------------------------------------

  async list(
    query: ListCuttingClosureRequestsQuery,
  ): Promise<CuttingClosureRequestDto[]> {
    const where: Prisma.CuttingClosureRequestWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.orderId) where.orderId = query.orderId;
    if (query.productId) where.productId = query.productId;
    if (query.sizeId) where.sizeId = query.sizeId;
    const rows = await this.prisma.cuttingClosureRequest.findMany({
      where,
      include: this.includeAll(),
      orderBy: [{ status: 'asc' }, { requestedAt: 'desc' }],
    });
    const dtos = await Promise.all(rows.map((r) => this.toDto(r)));
    return dtos;
  }

  async getOne(id: string): Promise<CuttingClosureRequestDto> {
    const row = await this.prisma.cuttingClosureRequest.findUnique({
      where: { id },
      include: this.includeAll(),
    });
    if (!row) throw new CuttingClosureRequestNotFoundException();
    return this.toDto(row);
  }

  // -------------------------------------------------------------------------
  // APPROVE / REJECT
  // -------------------------------------------------------------------------

  async approve(
    id: string,
    dto: ReviewCuttingClosureRequestDto,
    reviewerEmployeeId: string,
  ): Promise<CuttingClosureRequestDto> {
    return this.review(id, dto, reviewerEmployeeId, CuttingClosureRequestStatus.APPROVED);
  }

  async reject(
    id: string,
    dto: ReviewCuttingClosureRequestDto,
    reviewerEmployeeId: string,
  ): Promise<CuttingClosureRequestDto> {
    return this.review(id, dto, reviewerEmployeeId, CuttingClosureRequestStatus.REJECTED);
  }

  private async review(
    id: string,
    dto: ReviewCuttingClosureRequestDto,
    reviewerEmployeeId: string,
    nextStatus:
      | typeof CuttingClosureRequestStatus.APPROVED
      | typeof CuttingClosureRequestStatus.REJECTED,
  ): Promise<CuttingClosureRequestDto> {
    const current = await this.prisma.cuttingClosureRequest.findUnique({
      where: { id },
      select: { status: true, orderId: true, productId: true, sizeId: true },
    });
    if (!current) throw new CuttingClosureRequestNotFoundException();
    if (current.status !== CuttingClosureRequestStatus.REQUESTED) {
      throw new CuttingClosureRequestNotPendingException();
    }

    try {
      const updated = await this.prisma.cuttingClosureRequest.update({
        where: { id },
        data: {
          status: nextStatus,
          reviewedAt: new Date(),
          reviewedByEmployeeId: reviewerEmployeeId,
          reviewerNote: dto.note ?? null,
        },
        include: this.includeAll(),
      });
      this.logger.log(
        `event=cutting-closure.${nextStatus.toLowerCase()} id=${id} by=${reviewerEmployeeId}`,
      );
      return this.toDto(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Гонка: пока мы делали UPDATE на APPROVED, кто-то уже
        // апрувнул другую заявку по той же строке. Теоретически
        // невозможно (REQUESTED был один), практически — защищаемся.
        throw new CuttingClosureAlreadyApprovedException();
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // ENFORCEMENT (используется PassportsService.create)
  // -------------------------------------------------------------------------

  /**
   * `true`, если по строке `(orderId, productId, sizeId)` уже есть
   * подтверждённая заявка на закрытие раскроя. Возвращаем boolean
   * (а не throw), чтобы вызывающий сервис сам выбрал подходящий
   * exception class.
   */
  async hasApprovedClosure(
    orderId: string,
    productId: string,
    sizeId: string,
  ): Promise<boolean> {
    const found = await this.prisma.cuttingClosureRequest.findFirst({
      where: {
        orderId,
        productId,
        sizeId,
        status: CuttingClosureRequestStatus.APPROVED,
      },
      select: { id: true },
    });
    return !!found;
  }

  // -------------------------------------------------------------------------
  // PASSPORT-LEVEL helper (для UI карточки паспорта)
  // -------------------------------------------------------------------------

  /**
   * Возвращает «текущую» заявку на строку, к которой относится
   * паспорт. Приоритет: APPROVED → REQUESTED → последняя REJECTED.
   * Используется UI карточки паспорта: помощник видит свой статус,
   * мастер — что подтверждать. Если по строке нет ни одной заявки —
   * `null`.
   */
  async findCurrentForPassport(
    passportId: string,
  ): Promise<CuttingClosureRequestDto | null> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: { orderId: true, productId: true, sizeId: true },
    });
    if (!passport) return null;
    const rows = await this.prisma.cuttingClosureRequest.findMany({
      where: {
        orderId: passport.orderId,
        productId: passport.productId,
        sizeId: passport.sizeId,
      },
      include: this.includeAll(),
      orderBy: [{ requestedAt: 'desc' }],
    });
    if (rows.length === 0) return null;
    const approved = rows.find(
      (r) => r.status === CuttingClosureRequestStatus.APPROVED,
    );
    const requested = rows.find(
      (r) => r.status === CuttingClosureRequestStatus.REQUESTED,
    );
    const chosen = approved ?? requested ?? rows[0];
    return this.toDto(chosen);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private includeAll() {
    return {
      order: true,
      product: true,
      size: true,
      requestedByEmployee: true,
      reviewedByEmployee: true,
    } as const;
  }

  private async toDto(row: RequestRow): Promise<CuttingClosureRequestDto> {
    const planFact = await this.computePlanFact(
      row.orderId,
      row.productId,
      row.sizeId,
    );
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.number,
      productId: row.productId,
      productName: row.product.name,
      sizeId: row.sizeId,
      sizeCode: row.size.code,
      status: row.status,
      reason: row.reason,
      reviewerNote: row.reviewerNote,
      requestedByEmployeeId: row.requestedByEmployeeId,
      requestedByEmployeeName: row.requestedByEmployee.fullName,
      requestedAt: row.requestedAt.toISOString(),
      reviewedByEmployeeId: row.reviewedByEmployeeId,
      reviewedByEmployeeName: row.reviewedByEmployee?.fullName ?? null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      planFact,
    };
  }

  /**
   * План/факт/остаток по строке. Считается так же, как в
   * `aggregateOrder`: факт = `Σ Passport.qtyCut` по живым (не
   * `CANCELLED`) паспортам того же размера/продукта.
   */
  private async computePlanFact(
    orderId: string,
    productId: string,
    sizeId: string,
  ): Promise<{ qtyPlan: number; qtyCut: number; qtyRemaining: number }> {
    const [item, passports] = await Promise.all([
      this.prisma.orderItem.findUnique({
        where: {
          orderId_productId_sizeId: { orderId, productId, sizeId },
        },
        select: { qtyPlan: true },
      }),
      this.prisma.passport.findMany({
        where: {
          orderId,
          productId,
          sizeId,
          status: { not: PassportStatus.CANCELLED },
        },
        select: { qtyCut: true },
      }),
    ]);
    const qtyPlan = item?.qtyPlan ?? 0;
    const qtyCut = passports.reduce((s, p) => s + p.qtyCut, 0);
    return {
      qtyPlan,
      qtyCut,
      qtyRemaining: Math.max(qtyPlan - qtyCut, 0),
    };
  }
}
