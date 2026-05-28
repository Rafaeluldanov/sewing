import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EarningsService } from '../earnings/earnings.service.js';
import {
  EmployeeInactiveException,
  EmployeeNotFoundException,
  PassportNotQcPassedException,
  PassportNotWtoableException,
} from '../../common/errors.js';

/**
 * Сервис ВТО (role-terminal `/wto`).
 *
 * Полный аналог `QcService` для роли ВТО (`docs/flows.md §F6`,
 * ADR-0013 §«WTO_DONE bucket»). Отвечает за:
 *   - карточку ВТО (`getWtoDetail`) с derived-флагами
 *     `wtoCompletedAt` / `removedFromWto` / `qcPassedAt`;
 *   - явное «Завершить ВТО» (`completeWto`) — пишет
 *     `PassportEvent(WTO_PASSED)` без изменения `Passport.status`;
 *   - проверку «есть ли ОТК» (`assertQcPassed`), которую можно
 *     переиспользовать из любых backend-вариантов «принять на ВТО»
 *     (само принятие на ВТО — это `OPERATION_SCAN` через
 *     `PassportsService.scanOnOperation`, который теперь сам делает
 *     этот же чек).
 *
 * Не вводит ни нового статуса, ни новой таблицы. Все интересные
 * derived-вещи остаются вычислимыми из `PassportEvent` — ровно как у
 * QC. Это позволяет бесшовно дописать `WTO_DONE` в shopfloor-проекцию
 * (см. `ShopfloorService`).
 */
@Injectable()
export class WtoService {
  private readonly logger = new Logger(WtoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly earnings: EarningsService,
  ) {}

  // -------------------------------------------------------------------------
  // GET DETAIL
  // -------------------------------------------------------------------------

  async getWtoDetail(passportId: string): Promise<WtoPassportDetailDto> {
    return this.loadDetail(passportId);
  }

  // -------------------------------------------------------------------------
  // COMPLETE WTO («Завершить ВТО»)
  // -------------------------------------------------------------------------

  /**
   * Явно фиксирует, что ВТО завершило обработку по паспорту.
   *
   * Условия (см. `docs/flows.md §F6`):
   *   - паспорт `IN_PROGRESS` И `currentOperation.category = IRONING`
   *     (иначе — `PASSPORT_NOT_WTOABLE`: либо ещё не на ВТО, либо уже
   *     ушёл дальше);
   *   - по паспорту был `QC_PASSED` (иначе — `PASSPORT_NOT_QC_PASSED`,
   *     дублируется на всякий случай: входной скан уже это проверил,
   *     но WTO_PASSED без QC_PASSED — невозможное состояние).
   *
   * Идемпотентность (row-level): повторное «Завершить ВТО» допустимо,
   * но второй вызов НЕ пишет ни новый `PassportEvent(WTO_PASSED)`,
   * ни новую запись `AuditLog(WTO_COMPLETED)`. Возвращаем текущее
   * состояние карточки. `wtoCompletedAt` указывает на единственный
   * `WTO_PASSED`-event и не «прыгает» между нажатиями. Симметрично
   * `QcService.completeQc` и закрывает соответствующий finding из
   * `docs/operations-test-findings.md`.
   */
  async completeWto(
    passportId: string,
    actorEmployeeId: string,
  ): Promise<WtoPassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: { currentOperation: { select: { category: true } } },
      // productId/sizeId нужны для `createPendingForCompletedOperation`
      // (ставка операции резолвится по размеру). `findUnique` уже
      // включает все скалярные поля, явно дочитывать не нужно.
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    // Допустим retroactive ВТО: status==PACKED, по паспорту ещё нет
    // `WTO_PASSED`. Закрывает исторический бэклог упакованных без ВТО
    // паспортов (до route-aware gate в `PackingService.addPassport`).
    // Повторная попытка не пройдёт — `existing` ниже завернёт в
    // идемпотентную ветку.
    const isOnIroning =
      passport.status === PassportStatus.IN_PROGRESS &&
      passport.currentOperation?.category === OperationCategory.IRONING;
    let retroactive = false;
    if (!isOnIroning) {
      if (passport.status === PassportStatus.PACKED) {
        const alreadyWto = await this.prisma.passportEvent.findFirst({
          where: { passportId, type: PassportEventType.WTO_PASSED },
          select: { id: true },
        });
        if (alreadyWto) throw new PassportNotWtoableException();
        retroactive = true;
      } else {
        throw new PassportNotWtoableException();
      }
    }
    await this.assertQcPassed(passportId);

    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    // Аналогично `QcService.completeQc`: оборачиваем в `$transaction`,
    // чтобы запись `WTO_PASSED` и строка `AuditLog` создавались
    // атомарно (см. `docs/domain.md §«Audit log»`).
    //
    // Row-level idempotency: внутри транзакции проверяем наличие
    // существующего `WTO_PASSED`-event; если есть — выходим без
    // вставки event/audit. См. подробный комментарий в
    // `QcService.completeQc` — здесь применяется тот же подход
    // «check-then-insert» под одной транзакцией.
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.passportEvent.findFirst({
        where: { passportId, type: PassportEventType.WTO_PASSED },
        select: { id: true },
      });
      if (existing) return;
      // Для retroactive (`status==PACKED`) `currentOperationId` обычно
      // не на категории IRONING — пытаемся достать operationId ВТО
      // из маршрута заказа, иначе оставляем `currentOperationId`.
      const operationId = retroactive
        ? await resolveIroningOperationId(
            tx,
            passport.currentOperationId,
            passport.orderId,
          )
        : passport.currentOperationId;
      const createdEvent = await tx.passportEvent.create({
        data: {
          passportId,
          type: PassportEventType.WTO_PASSED,
          employeeId: actorEmployeeId,
          operationId,
          qty: passport.qtyGood,
        },
      });
      await this.audit.log(
        {
          event: 'WTO_COMPLETED',
          entityType: 'WTO',
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
      // Сдельное начисление за ВТО (как у швеи на `OPERATION_FINISHED`).
      // Тихо пропускается, если у операции `pricingMode = SALARY_ONLY`,
      // нет ставки или сотрудник на чистом окладе. Для retroactive-ветки
      // (`status == PACKED`) выписываем сразу APPROVED — упаковка уже
      // была, второго `approvePendingForPassport` не случится.
      await this.earnings.createPendingForCompletedOperation(tx, {
        passportId,
        operationId,
        employeeId: actorEmployeeId,
        productId: passport.productId,
        sizeId: passport.sizeId,
        qty: passport.qtyGood,
        sourceEventId: createdEvent.id,
        approveImmediately: retroactive,
      });
    });
    this.logger.log(
      `event=wto.complete passportId=${passportId} actorId=${actorEmployeeId}`,
    );
    return this.loadDetail(passportId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private async assertQcPassed(passportId: string): Promise<void> {
    // QC_PASSED считаем только после последнего `OPERATION_REWORK_OPENED`
    // (см. `QcService.returnToRework`). Если ОТК вернул паспорт на
    // переделку — старый QC_PASSED аннулируется, ВТО должна дождаться
    // нового подтверждения ОТК.
    const lastRework = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const qc = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        type: PassportEventType.QC_PASSED,
        ...(lastRework ? { createdAt: { gt: lastRework.createdAt } } : {}),
      },
      select: { id: true },
    });
    if (!qc) throw new PassportNotQcPassedException();
  }

  private async loadDetail(passportId: string): Promise<WtoPassportDetailDto> {
    const r = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: {
        order: { select: { id: true, number: true } },
        product: { select: { name: true } },
        size: true,
        currentOperation: { select: { code: true, name: true, category: true } },
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

    // Самое свежее `WTO_PASSED` — последнее «Завершить ВТО».
    const lastWto = await this.prisma.passportEvent.findFirst({
      where: { passportId, type: PassportEventType.WTO_PASSED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    // Самое свежее `QC_PASSED` — для UI-подсказки «ОТК прошло такого-то».
    const lastQc = await this.prisma.passportEvent.findFirst({
      where: { passportId, type: PassportEventType.QC_PASSED },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    // Backend-источник истины «паспорт ушёл из ВТО» — полный аналог
    // `removedFromQc` (см. QcService.loadDetail). Признаков движения два:
    //   1) терминальный статус (`PACKED`/`CANCELLED`);
    //   2) свежий `OPERATION_SCAN` после `wtoCompletedAt`.
    let removedFromWto = false;
    if (lastWto) {
      if (
        r.status === PassportStatus.PACKED ||
        r.status === PassportStatus.CANCELLED
      ) {
        removedFromWto = true;
      } else {
        const moved = await this.prisma.passportEvent.findFirst({
          where: {
            passportId,
            type: PassportEventType.OPERATION_SCAN,
            createdAt: { gt: lastWto.createdAt },
          },
          select: { id: true },
        });
        removedFromWto = moved !== null;
      }
    }

    const isOnIroning =
      r.status === PassportStatus.IN_PROGRESS &&
      r.currentOperation?.category === OperationCategory.IRONING;
    const canRetroactive =
      r.status === PassportStatus.PACKED && lastWto === null;

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
      rollNumber: r.rollNumber,
      cutDate: r.cutDate.toISOString(),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      currentOperationCode: r.currentOperation?.code ?? null,
      currentOperationName: r.currentOperation?.name ?? null,
      currentEmployeeId: r.currentEmployee?.id ?? null,
      currentEmployeeName: r.currentEmployee?.fullName ?? null,
      wtoCompletedAt: lastWto?.createdAt.toISOString() ?? null,
      qcPassedAt: lastQc?.createdAt.toISOString() ?? null,
      canCompleteWto: isOnIroning || canRetroactive,
      removedFromWto,
    };
  }
}

/**
 * Резолвит `operationId` для записи `WTO_PASSED` в retroactive-случае:
 * берём операцию категории IRONING из маршрута заказа. Если в маршруте
 * такой нет (или заказ без маршрута) — fallback на `currentOperationId`.
 */
async function resolveIroningOperationId(
  tx: Prisma.TransactionClient,
  currentOperationId: string | null,
  orderId: string | null,
): Promise<string | null> {
  if (!orderId) return currentOperationId;
  const step = await tx.orderRouteStep.findFirst({
    where: { orderId, operation: { category: OperationCategory.IRONING } },
    select: { operationId: true },
  });
  return step?.operationId ?? currentOperationId;
}
