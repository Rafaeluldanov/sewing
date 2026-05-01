import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import type { WtoPassportDetailDto } from '@sewing/shared/wto';
import { PrismaService } from '../../prisma/prisma.service.js';
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

  constructor(private readonly prisma: PrismaService) {}

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
   * Идемпотентность: повторное «Завершить ВТО» допустимо. Каждое
   * нажатие создаёт новое событие (как у QC). Аудит хранит всю историю,
   * `wtoCompletedAt` — это всегда самое свежее `WTO_PASSED`.
   */
  async completeWto(
    passportId: string,
    actorEmployeeId: string,
  ): Promise<WtoPassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: { currentOperation: { select: { category: true } } },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    if (
      passport.status !== PassportStatus.IN_PROGRESS ||
      passport.currentOperation?.category !== OperationCategory.IRONING
    ) {
      throw new PassportNotWtoableException();
    }
    await this.assertQcPassed(passportId);

    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    await this.prisma.passportEvent.create({
      data: {
        passportId,
        type: PassportEventType.WTO_PASSED,
        employeeId: actorEmployeeId,
        operationId: passport.currentOperationId,
        qty: passport.qtyGood,
      },
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
    const qc = await this.prisma.passportEvent.findFirst({
      where: { passportId, type: PassportEventType.QC_PASSED },
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
      canCompleteWto: isOnIroning,
      removedFromWto,
    };
  }
}
