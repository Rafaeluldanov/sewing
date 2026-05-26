import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OperationCategory, PassportEventType, PassportStatus } from '@prisma/client';
import type {
  CreatePassportDefectDto,
  DefectTypeDto,
  ListQcPassportsQuery,
  PassportDefectDto,
  QcPassportDetailDto,
  QcPassportListItemDto,
} from '@sewing/shared/qc';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  DefectExceedsRemainingException,
  DefectTypeInactiveException,
  DefectTypeNotFoundException,
  EmployeeInactiveException,
  EmployeeNotFoundException,
  PassportNoFinishedOperationException,
  PassportNotQcableException,
  PassportReworkAlreadyPendingException,
  PassportReworkRouteStepMissingException,
} from '../../common/errors.js';
import { EarningsService } from '../earnings/earnings.service.js';

/**
 * Сервис ОТК (Шаг 7).
 *
 * Отвечает за:
 *   - справочник видов брака (`DefectType`);
 *   - список паспортов, доступных ОТК;
 *   - карточку ОТК и историю дефектов;
 *   - запись `PassportDefect` + `PassportEvent(DEFECT_RECORDED)` в одной
 *     транзакции с пересчётом денормализованных `qtyDefect/qtyGood`
 *     в самом паспорте.
 *
 * Бизнес-правила см. в `docs/flows.md §F5` и `docs/domain.md §13`.
 */
@Injectable()
export class QcService {
  private readonly logger = new Logger(QcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly earnings: EarningsService,
  ) {}

  // -------------------------------------------------------------------------
  // Defect types
  // -------------------------------------------------------------------------

  async listDefectTypes(): Promise<DefectTypeDto[]> {
    const rows = await this.prisma.defectType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
    }));
  }

  // -------------------------------------------------------------------------
  // QC list
  // -------------------------------------------------------------------------

  /**
   * Паспорт доступен ОТК, если он `IN_PROGRESS`. Это значит:
   *   - выпуск/размещение прошли (статус был `CREATED`);
   *   - паспорт уже снят с ячейки и закреплён за швеёй или
   *     отсканирован на операции (Шаг 6 переводит статус в `IN_PROGRESS`);
   *   - терминальные состояния `PACKED` / `CANCELLED` исключены.
   *
   * Это правило компромисс: оно строже «после первого OPERATION_SCAN»
   * (см. п. 9–10 ТЗ Шага 7), но не требует отдельного запроса по
   * событиям и хорошо ложится на denormalised `Passport.status`.
   */
  async listForQc(query: ListQcPassportsQuery): Promise<{
    items: QcPassportListItemDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where: Prisma.PassportWhereInput = {
      status: PassportStatus.IN_PROGRESS,
    };
    if (query.orderId) where.orderId = query.orderId;
    if (query.search && query.search.length > 0) {
      const s = query.search;
      where.OR = [
        { number: { contains: s, mode: 'insensitive' } },
        { rollNumber: { contains: s, mode: 'insensitive' } },
        { order: { number: { contains: s, mode: 'insensitive' } } },
        { product: { name: { contains: s, mode: 'insensitive' } } },
        { color: { contains: s, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.passport.count({ where }),
      this.prisma.passport.findMany({
        where,
        include: {
          order: { select: { id: true, number: true } },
          product: { select: { name: true } },
          size: true,
          currentOperation: { select: { code: true, name: true } },
          currentEmployee: { select: { id: true, fullName: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    const items: QcPassportListItemDto[] = rows.map((r) => ({
      passportId: r.id,
      passportNumber: r.number,
      orderId: r.orderId,
      orderNumber: r.order.number,
      productName: r.product.name,
      color: r.color,
      sizeId: r.sizeId,
      sizeCode: r.size.code,
      sizeSortOrder: r.size.sortOrder,
      qtyCut: r.qtyCut,
      qtyDefect: r.qtyDefect,
      qtyGood: r.qtyGood,
      status: r.status,
      currentOperationCode: r.currentOperation?.code ?? null,
      currentOperationName: r.currentOperation?.name ?? null,
      currentEmployeeId: r.currentEmployee?.id ?? null,
      currentEmployeeName: r.currentEmployee?.fullName ?? null,
      updatedAt: r.updatedAt.toISOString(),
    }));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  // -------------------------------------------------------------------------
  // QC detail
  // -------------------------------------------------------------------------

  async getQcDetail(passportId: string): Promise<QcPassportDetailDto> {
    const detail = await this.loadDetail(passportId);
    return detail;
  }

  // -------------------------------------------------------------------------
  // Defect history (used by /api/passports/:id/defects)
  // -------------------------------------------------------------------------

  async listDefectsByPassport(
    passportId: string,
  ): Promise<PassportDefectDto[]> {
    const exists = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    return this.loadDefects(passportId);
  }

  // -------------------------------------------------------------------------
  // Record defect
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Complete QC (role-terminal: «Проверка выполнена»)
  // -------------------------------------------------------------------------

  /**
   * Явно фиксирует, что ОТК завершил проверку по паспорту.
   *
   * Намеренно НЕ меняет `Passport.status` и `currentEmployeeId`/
   * `currentOperationId`: на MVP ОТК — это аудит-роль над живой партией,
   * а не отдельная стадия pipeline. Дальнейшее движение паспорта
   * (упаковка, повторный пошив, и т.п.) остаётся pipeline-driven.
   *
   * Что делаем:
   *   - проверяем, что паспорт существует и в статусе `IN_PROGRESS`
   *     (терминальные/CREATED — `PASSPORT_NOT_QCABLE`, как у `recordDefect`);
   *   - проверяем актора (есть, активен);
   *   - пишем `PassportEvent(QC_PASSED, qty=qtyGood, employeeId=actor)`.
   *
   * Идемпотентность (row-level): повторный «Проверка выполнена»
   * допустим, но второй вызов НЕ пишет ни новый `PassportEvent
   * (QC_PASSED)`, ни новую запись `AuditLog(QC_COMPLETED)`. Возвращаем
   * текущее состояние карточки. `qcCompletedAt` указывает на
   * единственный `QC_PASSED`-event и не «прыгает» между нажатиями.
   * Это закрывает finding из `docs/operations-test-findings.md` и
   * соответствует recon §6 invariant 6.
   */
  async completeQc(
    passportId: string,
    actorEmployeeId: string,
  ): Promise<QcPassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    // Допустим retroactive QC: status==PACKED ровно один раз, если
    // `QC_PASSED` ещё не записан. Закрывает исторический бэклог паспортов,
    // которые упаковали до включения route-aware gate в `PackingService.
    // addPassport`. Повторная попытка отсканировать PACKED-паспорт уже
    // не пройдёт — `existing` ниже завернёт в идемпотентную ветку.
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      if (passport.status === PassportStatus.PACKED) {
        const alreadyQc = await this.prisma.passportEvent.findFirst({
          where: { passportId, type: PassportEventType.QC_PASSED },
          select: { id: true },
        });
        if (alreadyQc) throw new PassportNotQcableException();
      } else {
        throw new PassportNotQcableException();
      }
    }
    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    // Сам event и аудит — в одной транзакции, чтобы инвариант
    // «либо и QC_PASSED, и AuditLog, либо ничего» соблюдался даже
    // на уровне БД (см. `docs/domain.md §«Audit log»`).
    //
    // Row-level idempotency: внутри транзакции проверяем наличие
    // уже существующего `QC_PASSED`-event; если есть — выходим без
    // вставки event/audit. Без unique-индекса на `(passportId, type)`
    // обходимся «check-then-insert» под одной транзакцией, в которой
    // повторный insert от параллельного запроса в худшем случае
    // создаст вторую строку — но в нашем продовом сценарии «двойной
    // клик» это происходит последовательно, так что обычного `findFirst`
    // достаточно. Полный конкурент-safe-вариант потребовал бы partial
    // unique индекс — это уже миграция и выходит за рамки задачи.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.passportEvent.findFirst({
        where: { passportId, type: PassportEventType.QC_PASSED },
        select: { id: true },
      });
      if (existing) return;
      // Для retroactive (`status==PACKED`) `currentOperationId`, как
      // правило, не на категории QC — пытаемся достать operationId
      // ОТК из маршрута заказа, иначе оставляем `currentOperationId`.
      const operationId = await resolveQcOperationId(
        tx,
        passport.currentOperationId,
        passport.orderId,
      );
      await tx.passportEvent.create({
        data: {
          passportId,
          type: PassportEventType.QC_PASSED,
          employeeId: actorEmployeeId,
          operationId,
          qty: passport.qtyGood,
        },
      });
      await this.audit.log(
        {
          event: 'QC_COMPLETED',
          entityType: 'QC',
          entityId: passportId,
          employeeId: actorEmployeeId,
          payload: {
            passportId,
            operationId,
            qty: passport.qtyGood,
          },
        },
        tx,
      );
    });
    this.logger.log(
      `event=qc.complete passportId=${passportId} actorId=${actorEmployeeId}`,
    );
    return this.loadDetail(passportId);
  }

  // -------------------------------------------------------------------------
  // Return to rework (role-terminal: «Вернуть на переделку»)
  // -------------------------------------------------------------------------

  /**
   * ОТК нашёл брак и возвращает паспорт на предыдущий шаг (тому же
   * исполнителю). См. `docs/flows.md §F5a`, обсуждение дизайна — в
   * памяти проекта `project_qc_return_to_rework`.
   *
   * Инварианты:
   *   - паспорт `IN_PROGRESS`;
   *   - есть последний `OPERATION_FINISHED` — определяет target-операцию
   *     и швею-финишёра (`employeeId` в событии — «кому возвращаем»);
   *   - в текущем маршруте заказа есть `OrderRouteStep` под target —
   *     иначе 409, edge-case (маршрут перерисовали после прохождения);
   *   - не должно быть открытого rework (без последующего FINISHED) —
   *     защита от двойного нажатия.
   *
   * Эффекты в одной транзакции:
   *   1. Сдвигаем паспорт назад: `currentOperationId = target.operationId`,
   *      `currentRouteStepIndex = target.index`, `currentEmployeeId = null`,
   *      `currentCellId = null` (ячейку не используем — швея забирает
   *      паспорт у ОТК физически).
   *   2. Пишем `PassportEvent(OPERATION_REWORK_OPENED)` с
   *      `operationId = target`, `employeeId = previousFinisher`,
   *      `qty = qtyGood` (информационно).
   *   3. Отзываем pending earning у швеи предыдущего прохода —
   *      инвариант «оплата за изделие — один раз»: повторный
   *      `OPERATION_FINISHED` потом создаст начисление финишёру
   *      финального успешного прохода.
   *   4. Аудит `QC_PASSPORT_RETURNED_TO_REWORK`.
   *
   * После возврата:
   *   - `assertOperationNotFinished` пропускает повторную выдачу и
   *     завершение target-операции (учитывает события только после
   *     последнего `OPERATION_REWORK_OPENED`);
   *   - QC-/WTO-/packing-гейты тоже считают `QC_PASSED`/`WTO_PASSED`
   *     только после rework — паспорт должен снова пройти ОТК.
   */
  async returnToRework(
    passportId: string,
    actorEmployeeId: string,
  ): Promise<QcPassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      throw new PassportNotQcableException();
    }

    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    const lastFinished = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: PassportEventType.OPERATION_FINISHED,
      },
      orderBy: { createdAt: 'desc' },
      select: { operationId: true, employeeId: true, createdAt: true },
    });
    if (!lastFinished || !lastFinished.operationId) {
      throw new PassportNoFinishedOperationException();
    }

    // Защита от двойного нажатия: если по target-операции уже есть
    // открытый rework (REWORK_OPENED позже последнего FINISHED) —
    // второй raise не делаем. UI и так должен прятать кнопку
    // (см. флаг `reworkPending` в `loadDetail`), но дублирование
    // на бэке — на случай race-condition.
    const openRework = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
        createdAt: { gt: lastFinished.createdAt },
      },
      select: { id: true },
    });
    if (openRework) throw new PassportReworkAlreadyPendingException();

    const targetStep = await this.prisma.orderRouteStep.findFirst({
      where: {
        orderId: passport.orderId,
        operationId: lastFinished.operationId,
      },
      select: { index: true, operationId: true },
    });
    if (!targetStep) throw new PassportReworkRouteStepMissingException();

    const beforeSnapshot = {
      currentOperationId: passport.currentOperationId,
      currentRouteStepIndex: passport.currentRouteStepIndex,
      currentEmployeeId: passport.currentEmployeeId,
      currentCellId: passport.currentCellId,
    };
    const afterSnapshot = {
      currentOperationId: targetStep.operationId,
      currentRouteStepIndex: targetStep.index,
      currentEmployeeId: null,
      currentCellId: null,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.passport.update({
        where: { id: passportId },
        data: {
          currentOperationId: targetStep.operationId,
          currentRouteStepIndex: targetStep.index,
          currentEmployeeId: null,
          currentCellId: null,
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId,
          type: PassportEventType.OPERATION_REWORK_OPENED,
          operationId: targetStep.operationId,
          // `employeeId` события — «кому возвращаем» (последний
          // финишёр). Это же поле использует UI /work, чтобы
          // показать секцию «К переделке» у конкретной швеи.
          employeeId: lastFinished.employeeId,
          qty: passport.qtyGood,
        },
      });
      const revoked = await this.earnings.revokePendingForOperation(
        tx,
        passportId,
        targetStep.operationId,
      );
      await this.audit.log(
        {
          event: 'QC_PASSPORT_RETURNED_TO_REWORK',
          entityType: 'PASSPORT',
          entityId: passportId,
          employeeId: actorEmployeeId,
          payload: {
            targetOperationId: targetStep.operationId,
            targetRouteStepIndex: targetStep.index,
            previousFinisherEmployeeId: lastFinished.employeeId,
            qty: passport.qtyGood,
            pendingEarningsRevoked: revoked,
            before: beforeSnapshot,
            after: afterSnapshot,
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=qc.returnToRework passportId=${passportId} actorId=${actorEmployeeId} targetOperationId=${targetStep.operationId} previousFinisherEmployeeId=${lastFinished.employeeId ?? 'unknown'}`,
    );
    return this.loadDetail(passportId);
  }

  async recordDefect(
    passportId: string,
    dto: CreatePassportDefectDto,
    actorEmployeeId: string,
  ): Promise<QcPassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    // Доступность для ОТК — только живые «в работе».
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      throw new PassportNotQcableException();
    }

    const defectType = await this.prisma.defectType.findUnique({
      where: { id: dto.defectTypeId },
    });
    if (!defectType) throw new DefectTypeNotFoundException();
    if (!defectType.isActive) throw new DefectTypeInactiveException();

    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    // Граница: qtyGood = qtyCut − qtyDefect не может стать < 0.
    const remaining = passport.qtyCut - passport.qtyDefect;
    if (dto.qty > remaining) {
      throw new DefectExceedsRemainingException(remaining);
    }

    await this.prisma.$transaction(async (tx) => {
      // Перепроверяем границу под локом транзакции, чтобы две
      // одновременные фиксации брака не пробили `qtyGood >= 0`.
      const fresh = await tx.passport.findUnique({
        where: { id: passportId },
        select: {
          qtyCut: true,
          qtyDefect: true,
          status: true,
          currentOperationId: true,
        },
      });
      if (!fresh || fresh.status !== PassportStatus.IN_PROGRESS) {
        throw new PassportNotQcableException();
      }
      const remainingNow = fresh.qtyCut - fresh.qtyDefect;
      if (dto.qty > remainingNow) {
        throw new DefectExceedsRemainingException(remainingNow);
      }
      const created = await tx.passportDefect.create({
        data: {
          passportId,
          defectTypeId: defectType.id,
          qty: dto.qty,
          comment: dto.comment ?? null,
          createdByEmployeeId: actorEmployeeId,
        },
      });
      await tx.passport.update({
        where: { id: passportId },
        data: {
          qtyDefect: { increment: dto.qty },
          qtyGood: { decrement: dto.qty },
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId,
          type: PassportEventType.DEFECT_RECORDED,
          employeeId: actorEmployeeId,
          operationId: fresh.currentOperationId,
          qty: dto.qty,
          payload: {
            defectId: created.id,
            defectTypeId: defectType.id,
            defectTypeCode: defectType.code,
            defectTypeName: defectType.name,
            comment: dto.comment ?? null,
          },
        },
      });
    });

    this.logger.log(
      `event=qc.defect passportId=${passportId} defectTypeId=${defectType.id} qty=${dto.qty} actorId=${actorEmployeeId}`,
    );
    return this.loadDetail(passportId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private async loadDetail(passportId: string): Promise<QcPassportDetailDto> {
    const r = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: {
        order: { select: { id: true, number: true } },
        product: { select: { name: true } },
        size: true,
        currentOperation: { select: { code: true, name: true } },
        currentEmployee: { select: { id: true, fullName: true } },
      },
    });
    if (!r) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    const defects = await this.loadDefects(passportId);
    const remainingForDefect = Math.max(r.qtyCut - r.qtyDefect, 0);
    // Самое свежее `QC_PASSED` — фиксирует «когда ОТК последний раз
    // подтвердил проверку» (см. `completeQc`).
    const lastQcPassed = await this.prisma.passportEvent.findFirst({
      where: { passportId, type: PassportEventType.QC_PASSED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // Последнее `OPERATION_FINISHED` — нужно для `canReturnToRework`
    // и для проверки «есть ли открытый rework по этой операции».
    const lastFinished = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: PassportEventType.OPERATION_FINISHED,
      },
      orderBy: { createdAt: 'desc' },
      select: { operationId: true, createdAt: true },
    });
    const reworkPending = lastFinished
      ? Boolean(
          await this.prisma.passportEvent.findFirst({
            where: {
              passportId,
              type: PassportEventType.OPERATION_REWORK_OPENED,
              createdAt: { gt: lastFinished.createdAt },
            },
            select: { id: true },
          }),
        )
      : false;
    // Backend-источник истины «паспорт ушёл из ОТК». QC-терминал
    // (`apps/web/app/qc/qc-terminal.tsx`) использует этот флаг, чтобы
    // схлопнутая строка «Проверено ОТК» исчезала, когда паспорт реально
    // двинулся дальше. Признаков движения два:
    //   1) терминальный статус (`PACKED`/`CANCELLED`) — паспорт уже не
    //      «живой», ОТК его никак не касается;
    //   2) появился новый `PassportEvent(OPERATION_SCAN)` после
    //      `qcCompletedAt` — значит сотрудник на следующей операции его
    //      перехватил (`PassportsService.scanOnOperation`).
    // Если QC ещё ни разу не подтверждал паспорт (`qcCompletedAt = null`),
    // флаг всегда `false`: терминал даже не показывал строку «проверено».
    let removedFromQc = false;
    if (lastQcPassed) {
      if (
        r.status === PassportStatus.PACKED ||
        r.status === PassportStatus.CANCELLED
      ) {
        removedFromQc = true;
      } else {
        const moved = await this.prisma.passportEvent.findFirst({
          where: {
            passportId,
            type: PassportEventType.OPERATION_SCAN,
            createdAt: { gt: lastQcPassed.createdAt },
          },
          select: { id: true },
        });
        removedFromQc = moved !== null;
      }
    }
    return {
      passportId: r.id,
      passportNumber: r.number,
      orderId: r.orderId,
      orderNumber: r.order.number,
      productName: r.product.name,
      color: r.color,
      sizeId: r.sizeId,
      sizeCode: r.size.code,
      sizeSortOrder: r.size.sortOrder,
      qtyCut: r.qtyCut,
      qtyDefect: r.qtyDefect,
      qtyGood: r.qtyGood,
      qtyPlan: r.qtyPlan,
      status: r.status,
      currentOperationCode: r.currentOperation?.code ?? null,
      currentOperationName: r.currentOperation?.name ?? null,
      currentEmployeeId: r.currentEmployee?.id ?? null,
      currentEmployeeName: r.currentEmployee?.fullName ?? null,
      rollNumber: r.rollNumber,
      cutDate: r.cutDate.toISOString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      defects,
      // В состоянии открытого rework (паспорт уже отправлен на переделку
      // и ждёт сканирования швеёй) ОТК ничего делать не должен —
      // карточка показывается в read-only.
      canRecordDefect:
        !reworkPending &&
        r.status === PassportStatus.IN_PROGRESS &&
        remainingForDefect > 0,
      remainingForDefect,
      qcCompletedAt: lastQcPassed?.createdAt.toISOString() ?? null,
      canCompleteQc:
        !reworkPending &&
        (r.status === PassportStatus.IN_PROGRESS ||
          (r.status === PassportStatus.PACKED && lastQcPassed === null)),
      // Кнопка «Вернуть на переделку» активна только если есть кому
      // возвращать (есть OPERATION_FINISHED) и нет уже открытого rework.
      canReturnToRework:
        r.status === PassportStatus.IN_PROGRESS &&
        lastFinished !== null &&
        !reworkPending,
      reworkPending,
      removedFromQc,
    };
  }

  private async loadDefects(passportId: string): Promise<PassportDefectDto[]> {
    const rows = await this.prisma.passportDefect.findMany({
      where: { passportId },
      include: {
        defectType: { select: { code: true, name: true } },
        createdByEmployee: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((d) => ({
      id: d.id,
      passportId: d.passportId,
      defectTypeId: d.defectTypeId,
      defectTypeCode: d.defectType.code,
      defectTypeName: d.defectType.name,
      qty: d.qty,
      comment: d.comment ?? null,
      createdAt: d.createdAt.toISOString(),
      createdByEmployeeId: d.createdByEmployeeId ?? null,
      createdByEmployeeName: d.createdByEmployee?.fullName ?? null,
    }));
  }
}

/**
 * Резолвит `operationId` для записи `QC_PASSED` в retroactive-случае:
 * берём операцию категории QC из маршрута заказа. Если в маршруте такой
 * нет (или заказ без маршрута) — fallback на `currentOperationId`.
 */
async function resolveQcOperationId(
  tx: Prisma.TransactionClient,
  currentOperationId: string | null,
  orderId: string | null,
): Promise<string | null> {
  if (!orderId) return currentOperationId;
  const step = await tx.orderRouteStep.findFirst({
    where: { orderId, operation: { category: OperationCategory.QC } },
    select: { operationId: true },
  });
  return step?.operationId ?? currentOperationId;
}
