import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  PassportEventType,
  PassportQtyCorrectionStatus,
  PassportStatus,
  Prisma,
  Role,
} from '@prisma/client';
import type {
  ApprovePassportQtyCorrectionResultDto,
  CreatePassportQtyCorrectionDto,
  PassportQtyCorrectionDto,
  ReviewPassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EarningsService } from '../earnings/earnings.service.js';
import { PushService } from '../push/push.service.js';
import {
  QtyCorrectionAlreadyPendingException,
  QtyCorrectionBelowDefectException,
  QtyCorrectionNotFoundException,
  QtyCorrectionNotPendingException,
  QtyCorrectionPassportNotEditableException,
} from '../../common/errors.js';

type CorrectionRow = Prisma.PassportQtyCorrectionGetPayload<{
  include: {
    passport: {
      include: {
        order: { select: { number: true } };
        product: { select: { name: true } };
        size: { select: { code: true } };
      };
    };
    requestedByEmployee: { select: { fullName: true } };
    reviewedByEmployee: { select: { fullName: true } };
  };
}>;

/**
 * Сервис «Корректировка фактического количества по паспорту»
 * (ОТК → мастер цеха).
 *
 * Двухшаговая заявка (зеркало `CuttingClosureService`): ОТК подаёт
 * `PENDING`, мастер цеха (`SHOPFLOOR_MASTER`) подтверждает/отклоняет.
 * В момент approve двигаем `Passport.qtyCut`/`qtyGood` на одну разницу,
 * пересчитываем сдельную ЗП (швеи через `reconcileToQtyGood`,
 * раскройщик через `recomputeCutterForPassport`), пишем
 * `PassportEvent(QTY_CORRECTED)` и аудит. Фаза 1 — только паспорта
 * `IN_PROGRESS` (до упаковки).
 */
@Injectable()
export class PassportQtyCorrectionsService {
  private readonly logger = new Logger(PassportQtyCorrectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: EarningsService,
    private readonly push: PushService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE (ОТК предлагает)
  // -------------------------------------------------------------------------

  async create(
    passportId: string,
    dto: CreatePassportQtyCorrectionDto,
    requestedByEmployeeId: string,
  ): Promise<PassportQtyCorrectionDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: {
        id: true,
        number: true,
        status: true,
        qtyCut: true,
        qtyDefect: true,
        qtyGood: true,
      },
    });
    if (!passport) throw this.passportNotFound();
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      throw new QtyCorrectionPassportNotEditableException();
    }
    // Инвариант: qtyGood = qtyCut − qtyDefect >= 0 после сдвига. Так как
    // мы двигаем qtyCut и qtyGood на одну и ту же разницу, qtyDefect не
    // меняется, значит новый qtyCut = qtyAfter + qtyDefect. Проверяем
    // защитно (при qtyAfter >= 0 условие всегда выполняется).
    const nextQtyCut = dto.qtyAfter + passport.qtyDefect;
    if (nextQtyCut < passport.qtyDefect) {
      throw new QtyCorrectionBelowDefectException(0);
    }

    // Быстрый pre-check + жёсткая защита от гонок на partial unique index.
    const existingPending = await this.prisma.passportQtyCorrection.findFirst({
      where: {
        passportId,
        status: PassportQtyCorrectionStatus.PENDING,
      },
      select: { id: true },
    });
    if (existingPending) throw new QtyCorrectionAlreadyPendingException();

    let created: CorrectionRow;
    try {
      created = await this.prisma.passportQtyCorrection.create({
        data: {
          passportId,
          qtyBefore: passport.qtyGood,
          qtyAfter: dto.qtyAfter,
          reason: dto.reason ?? null,
          requestedByEmployeeId,
          status: PassportQtyCorrectionStatus.PENDING,
        },
        include: this.includeAll(),
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new QtyCorrectionAlreadyPendingException();
      }
      throw err;
    }

    this.logger.log(
      `event=qty-correction.request id=${created.id} passportId=${passportId} ` +
        `${passport.qtyGood}->${dto.qtyAfter} by=${requestedByEmployeeId}`,
    );

    // Push всем мастерам цеха — строго после коммита create, fire-and-forget
    // (см. шаблон `QcService.returnToRework`). Ошибки глотает PushService.
    await this.notifyMasters(created, passport.number);

    return this.toDto(created);
  }

  // -------------------------------------------------------------------------
  // LIST / GET
  // -------------------------------------------------------------------------

  /** Очередь мастера: открытые (`PENDING`) заявки. */
  async listPending(): Promise<PassportQtyCorrectionDto[]> {
    const rows = await this.prisma.passportQtyCorrection.findMany({
      where: { status: PassportQtyCorrectionStatus.PENDING },
      include: this.includeAll(),
      orderBy: [{ requestedAt: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  /** Открытая заявка по конкретному паспорту (для карточки ОТК). `null` — нет. */
  async findPendingForPassport(
    passportId: string,
  ): Promise<PassportQtyCorrectionDto | null> {
    const row = await this.prisma.passportQtyCorrection.findFirst({
      where: {
        passportId,
        status: PassportQtyCorrectionStatus.PENDING,
      },
      include: this.includeAll(),
      orderBy: [{ requestedAt: 'desc' }],
    });
    return row ? this.toDto(row) : null;
  }

  // -------------------------------------------------------------------------
  // APPROVE (мастер подтверждает — применяем)
  // -------------------------------------------------------------------------

  async approve(
    id: string,
    dto: ReviewPassportQtyCorrectionDto,
    reviewerEmployeeId: string,
  ): Promise<ApprovePassportQtyCorrectionResultDto> {
    const result = await this.prisma.$transaction(async (tx) => {
      const correction = await tx.passportQtyCorrection.findUnique({
        where: { id },
        select: { id: true, status: true, passportId: true, qtyAfter: true },
      });
      if (!correction) throw new QtyCorrectionNotFoundException();
      if (correction.status !== PassportQtyCorrectionStatus.PENDING) {
        throw new QtyCorrectionNotPendingException();
      }

      const passport = await tx.passport.findUnique({
        where: { id: correction.passportId },
        select: {
          id: true,
          status: true,
          qtyCut: true,
          qtyDefect: true,
          qtyGood: true,
          currentOperationId: true,
        },
      });
      if (!passport) throw this.passportNotFound();
      if (passport.status !== PassportStatus.IN_PROGRESS) {
        throw new QtyCorrectionPassportNotEditableException();
      }

      const qtyBefore = passport.qtyGood;
      const delta = correction.qtyAfter - qtyBefore;
      const nextQtyGood = correction.qtyAfter;
      const nextQtyCut = passport.qtyCut + delta;
      if (nextQtyCut - passport.qtyDefect < 0) {
        throw new QtyCorrectionBelowDefectException(passport.qtyDefect);
      }

      // 1. Двигаем и раскрой, и годных на одну и ту же разницу (qtyDefect
      //    не трогаем). qtyPlan оставляем как есть — это план, а не факт.
      await tx.passport.update({
        where: { id: passport.id },
        data: { qtyCut: nextQtyCut, qtyGood: nextQtyGood },
      });

      // 2. Событие истории паспорта.
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.QTY_CORRECTED,
          employeeId: reviewerEmployeeId,
          operationId: passport.currentOperationId,
          qty: nextQtyGood,
          payload: {
            correctionId: correction.id,
            qtyBefore,
            qtyAfter: correction.qtyAfter,
            delta,
            reviewedByEmployeeId: reviewerEmployeeId,
          },
        },
      });

      // 3. Пересчёт сдельной ЗП: швеи/ВТО по qtyGood + раскройщик по qtyCut.
      const sewing = await this.earnings.reconcileToQtyGood(tx, passport.id);
      const cutter = await this.earnings.recomputeCutterForPassport(
        tx,
        passport.id,
      );

      // 4. Фиксируем решение по заявке.
      const updated = await tx.passportQtyCorrection.update({
        where: { id },
        data: {
          status: PassportQtyCorrectionStatus.APPROVED,
          reviewedAt: new Date(),
          reviewedByEmployeeId: reviewerEmployeeId,
          reviewerNote: dto.note ?? null,
        },
        include: this.includeAll(),
      });

      await this.audit.log(
        {
          event: 'PASSPORT_QTY_CORRECTED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId: reviewerEmployeeId,
          payload: {
            correctionId: correction.id,
            qtyBefore,
            qtyAfter: correction.qtyAfter,
            delta,
            qtyCut: nextQtyCut,
            qtyGood: nextQtyGood,
            salaryAdjusted: sewing.updated + cutter.updated,
            salarySkipped: sewing.skipped.length + cutter.skipped,
          },
        },
        tx,
      );

      return {
        correction: this.toDto(updated),
        qtyCut: nextQtyCut,
        qtyGood: nextQtyGood,
        salaryAdjusted: sewing.updated + cutter.updated,
        salarySkipped: sewing.skipped.length + cutter.skipped,
      } satisfies ApprovePassportQtyCorrectionResultDto;
    });

    this.logger.log(
      `event=qty-correction.approve id=${id} qtyGood=${result.qtyGood} ` +
        `salaryAdjusted=${result.salaryAdjusted} salarySkipped=${result.salarySkipped} by=${reviewerEmployeeId}`,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // REJECT / CANCEL
  // -------------------------------------------------------------------------

  /** Мастер отклонил заявку — количество не меняется. */
  async reject(
    id: string,
    dto: ReviewPassportQtyCorrectionDto,
    reviewerEmployeeId: string,
  ): Promise<PassportQtyCorrectionDto> {
    return this.resolveRejected(id, reviewerEmployeeId, dto.note ?? null);
  }

  /**
   * ОТК отозвал свою заявку (пока она `PENDING`). Технически — тот же
   * переход в `REJECTED`, но помечаем в заметке, что это отзыв.
   */
  async cancel(
    id: string,
    employeeId: string,
  ): Promise<PassportQtyCorrectionDto> {
    return this.resolveRejected(id, employeeId, 'Отозвано подавшим');
  }

  private async resolveRejected(
    id: string,
    reviewerEmployeeId: string,
    note: string | null,
  ): Promise<PassportQtyCorrectionDto> {
    const current = await this.prisma.passportQtyCorrection.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!current) throw new QtyCorrectionNotFoundException();
    if (current.status !== PassportQtyCorrectionStatus.PENDING) {
      throw new QtyCorrectionNotPendingException();
    }
    const updated = await this.prisma.passportQtyCorrection.update({
      where: { id },
      data: {
        status: PassportQtyCorrectionStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedByEmployeeId: reviewerEmployeeId,
        reviewerNote: note,
      },
      include: this.includeAll(),
    });
    this.logger.log(
      `event=qty-correction.reject id=${id} by=${reviewerEmployeeId}`,
    );
    return this.toDto(updated);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private includeAll() {
    return {
      passport: {
        include: {
          order: { select: { number: true } },
          product: { select: { name: true } },
          size: { select: { code: true } },
        },
      },
      requestedByEmployee: { select: { fullName: true } },
      reviewedByEmployee: { select: { fullName: true } },
    } as const;
  }

  private toDto(row: CorrectionRow): PassportQtyCorrectionDto {
    return {
      id: row.id,
      passportId: row.passportId,
      passportNumber: row.passport.number,
      orderId: row.passport.orderId,
      orderNumber: row.passport.order.number,
      productName: row.passport.product.name,
      color: row.passport.color,
      sizeCode: row.passport.size.code,
      status: row.status,
      qtyBefore: row.qtyBefore,
      qtyAfter: row.qtyAfter,
      delta: row.qtyAfter - row.qtyBefore,
      reason: row.reason,
      reviewerNote: row.reviewerNote,
      requestedByEmployeeId: row.requestedByEmployeeId,
      requestedByEmployeeName: row.requestedByEmployee.fullName,
      requestedAt: row.requestedAt.toISOString(),
      reviewedByEmployeeId: row.reviewedByEmployeeId,
      reviewedByEmployeeName: row.reviewedByEmployee?.fullName ?? null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    };
  }

  private async notifyMasters(
    correction: CorrectionRow,
    passportNumber: string,
  ): Promise<void> {
    let masters: Array<{ id: string }>;
    try {
      masters = await this.prisma.employee.findMany({
        where: { active: true, roles: { has: Role.SHOPFLOOR_MASTER } },
        select: { id: true },
      });
    } catch (e) {
      this.logger.warn(
        `notifyMasters: не удалось прочитать мастеров: ${String(e)}`,
      );
      return;
    }
    const delta = correction.qtyAfter - correction.qtyBefore;
    const deltaLabel = delta > 0 ? `+${delta}` : String(delta);
    const requester = correction.requestedByEmployee.fullName;
    for (const m of masters) {
      void this.push.notifyEmployee(m.id, {
        tag: `qty-correction:${correction.id}`,
        title: '✎ Корректировка количества',
        body: `${passportNumber}: ${correction.qtyBefore} → ${correction.qtyAfter} (${deltaLabel}) от ${requester}. Подтвердите на /master.`,
        url: '/master',
      });
    }
  }

  private passportNotFound(): NotFoundException {
    return new NotFoundException({
      statusCode: 404,
      code: 'PASSPORT_NOT_FOUND',
      message: 'Паспорт не найден',
    });
  }
}
