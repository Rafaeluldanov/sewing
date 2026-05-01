import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OrderStatus,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import {
  type CellDetailDto,
  type CreatePassportDto,
  type PassportDetailDto,
  type PassportListItemDto,
  type PassportPlacementResultDto,
  type PlacePassportDto,
} from '@sewing/shared/passports';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CellInactiveException,
  CellNotFoundException,
  PassportAlreadyIssuedException,
  PassportAlreadyPackedException,
  PassportAlreadyPlacedException,
  PassportCancelledException,
  PassportCuttingClosedException,
  PassportNotInCellException,
  PassportNotInProgressException,
  PassportNotPlaceableException,
  PassportNotQcPassedException,
  PassportNotYoursException,
  PassportOrderNotInProductionException,
  PassportQtyExceedsRemainingException,
  PassportSizeNotInOrderException,
  ShiftSessionRequiredException,
} from '../../common/errors.js';
import { OperationCategory } from '@prisma/client';
import { PassportNumberService } from './passport-number.service.js';
import { buildPassportPrintUrl, buildPassportQrPayload } from './qr.js';
import { EarningsService } from '../earnings/earnings.service.js';
import { CuttingClosureService } from '../cutting-closure/cutting-closure.service.js';

type PassportRow = Prisma.PassportGetPayload<{
  include: {
    size: true;
    product: true;
    order: true;
    cutter: true;
    creator: true;
    currentCell: true;
    boxItems: { include: { box: true } };
  };
}>;

@Injectable()
export class PassportsService {
  private readonly logger = new Logger(PassportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: PassportNumberService,
    private readonly earnings: EarningsService,
    private readonly closure: CuttingClosureService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Создание паспорта (выпуск кроя) — `creatorId` приходит из сессии
   * (ADR-0014). `cutterId` пока берём из seed-учётки `cutter`: на MVP
   * 1.1 раскройщик вводится в системе только за столом помощника, а
   * у самого раскройщика отдельной точки сканирования нет. Когда
   * появится «крой бригадой», эту логику вынесем в отдельный шаг.
   */
  async create(
    dto: CreatePassportDto,
    creatorEmployeeId: string,
  ): Promise<PassportDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: {
        items: { include: { product: true } },
        passports: true,
        // Soft-route MVP: подтягиваем snapshot, чтобы понять, нужно ли
        // ставить `currentRouteStepIndex = 0` у нового паспорта.
        routeSteps: { select: { id: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (
      order.status === OrderStatus.DONE ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new PassportOrderNotInProductionException();
    }
    // Бизнес-правило: выпуск паспорта разрешён только когда заказ в
    // производстве. См. ADR-0010 и docs/flows.md §F2.
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new PassportOrderNotInProductionException();
    }

    const orderItem = order.items.find((it) => it.sizeId === dto.sizeId);
    if (!orderItem) {
      throw new PassportSizeNotInOrderException();
    }

    // ADR-0018: подтверждённая мастером заявка на закрытие раскроя
    // по строке `(orderId, productId, sizeId)` запрещает выпуск
    // новых паспортов. Backend = источник истины: фронт может
    // спрятать кнопку, но реально режем здесь, до записи в БД.
    const closed = await this.closure.hasApprovedClosure(
      order.id,
      orderItem.productId,
      dto.sizeId,
    );
    if (closed) throw new PassportCuttingClosedException();

    // Сколько уже выпущено по этому размеру (без CANCELLED).
    const cutByThisSize = order.passports
      .filter(
        (p) => p.sizeId === dto.sizeId && p.status !== PassportStatus.CANCELLED,
      )
      .reduce((s, p) => s + p.qtyCut, 0);
    const remaining = orderItem.qtyPlan - cutByThisSize;
    if (dto.qtyCut > remaining) {
      throw new PassportQtyExceedsRemainingException(Math.max(remaining, 0));
    }

    const product = orderItem.product;
    const color = order.color ?? product.color;

    // creator = текущий пользователь сессии (см. ADR-0014). cutter
    // (раскройщик) — пока seed-учётка `cutter`: у него отдельной точки
    // сканирования на MVP нет. Если в seed нет «cutter», берём creator.
    const [creator, cutterFromSeed, divisionOp] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: creatorEmployeeId } }),
      this.prisma.employee.findUnique({ where: { login: 'cutter' } }),
      this.prisma.operation.findUnique({ where: { code: 'CUT_DIVISION' } }),
    ]);
    if (!creator) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Сотрудник-инициатор не найден.',
      });
    }
    const cutter = cutterFromSeed ?? creator;
    if (!divisionOp) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'OPERATION_NOT_FOUND',
        message:
          'В справочнике операций нет CUT_DIVISION. Запустите `npm run db:seed`.',
      });
    }

    // Soft-route MVP: если у заказа уже есть snapshot маршрута — у
    // нового паспорта проставляем `currentRouteStepIndex = 0`. Это
    // подсказка для UI: «маршрут известен, паспорт стоит в начале».
    // Никакого enforcement: значение остаётся UI-подсказкой.
    const initialRouteStepIndex = order.routeSteps.length > 0 ? 0 : null;

    const id = await this.prisma.$transaction(async (tx) => {
      const number = await this.numbers.nextNumber(tx);
      const created = await tx.passport.create({
        data: {
          number,
          // qrCode UNIQUE NOT NULL — проставим финальный `passport:{id}`
          // вторым шагом в этой же транзакции, когда узнаем id.
          qrCode: `passport-pending:${number}`,
          orderId: order.id,
          productId: product.id,
          sizeId: dto.sizeId,
          color,
          rollNumber: dto.rollNumber,
          cutDate: new Date(dto.cutDate),
          qtyPlan: dto.qtyCut,
          qtyCut: dto.qtyCut,
          qtyDefect: 0,
          qtyGood: dto.qtyCut,
          status: PassportStatus.CREATED,
          currentOperationId: divisionOp.id,
          currentEmployeeId: creator.id,
          cutterId: cutter.id,
          creatorId: creator.id,
          currentRouteStepIndex: initialRouteStepIndex,
        },
      });
      const qrCode = buildPassportQrPayload(created.id);
      await tx.passport.update({
        where: { id: created.id },
        data: { qrCode },
      });
      await tx.passportEvent.create({
        data: {
          passportId: created.id,
          type: PassportEventType.CREATED,
          operationId: divisionOp.id,
          employeeId: creator.id,
          qty: dto.qtyCut,
          payload: {
            rollNumber: dto.rollNumber,
            color,
          },
        },
      });
      // Шаг 9 (ADR-0005): immediate-начисление раскройщику. Делается в
      // той же транзакции, чтобы паспорт и зарплата жили атомарно. При
      // отсутствии действующей `PieceRate` сервис кидает 422
      // `PIECE_RATE_NOT_FOUND` — это сознательный выбор: silent skip
      // тут разрушит доверие к зарплате (см. `docs/flows.md §F2`).
      await this.earnings.createImmediateForCutter(tx, {
        passportId: created.id,
        cutterId: cutter.id,
        sizeId: dto.sizeId,
        productId: product.id,
        qty: dto.qtyCut,
      });
      return created.id;
    });
    this.logger.log(
      `event=passport.create passportId=${id} orderId=${order.id} sizeId=${dto.sizeId} qtyCut=${dto.qtyCut} creatorId=${creator.id}`,
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<PassportDetailDto> {
    const row = await this.prisma.passport.findUnique({
      where: { id },
      include: {
        size: true,
        product: true,
        order: true,
        cutter: true,
        creator: true,
        currentCell: true,
        boxItems: { include: { box: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    return this.toDetailDto(row);
  }

  // -------------------------------------------------------------------------
  // LIST BY ORDER
  // -------------------------------------------------------------------------

  async listByOrder(orderId: string): Promise<PassportListItemDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    const rows = await this.prisma.passport.findMany({
      where: { orderId },
      include: {
        size: true,
        currentCell: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      cutDate: r.cutDate.toISOString(),
      createdAt: r.createdAt.toISOString(),
      qtyCut: r.qtyCut,
      qtyPlan: r.qtyPlan,
      qtyDefect: r.qtyDefect,
      qtyGood: r.qtyGood,
      rollNumber: r.rollNumber,
      sizeId: r.sizeId,
      sizeCode: r.size.code,
      sizeSortOrder: r.size.sortOrder,
      currentCell: r.currentCell
        ? { id: r.currentCell.id, code: r.currentCell.code }
        : null,
      currentRouteStepIndex: r.currentRouteStepIndex,
    }));
  }

  // -------------------------------------------------------------------------
  // PLACE IN CELL
  // -------------------------------------------------------------------------

  async place(
    id: string,
    dto: PlacePassportDto,
  ): Promise<PassportPlacementResultDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id },
      include: { currentCell: true },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    if (passport.status !== PassportStatus.CREATED) {
      throw new PassportNotPlaceableException();
    }
    if (passport.currentCellId && passport.currentCell) {
      throw new PassportAlreadyPlacedException(passport.currentCell.code);
    }

    const cell = await this.findCellByIdOrCode(dto.cellId, dto.cellCode);

    await this.prisma.$transaction(async (tx) => {
      // Инкрементим срез CellContent (или создаём, если ещё нет).
      // Используем updateMany→create вместо upsert, т.к. unique по
      // (cellId, sizeId) у нас составной — это корректно работает с upsert,
      // но 2-шаговая реализация проще читается.
      const existing = await tx.cellContent.findUnique({
        where: {
          cellId_sizeId: { cellId: cell.id, sizeId: passport.sizeId },
        },
      });
      if (existing) {
        await tx.cellContent.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + passport.qtyCut },
        });
      } else {
        await tx.cellContent.create({
          data: {
            cellId: cell.id,
            sizeId: passport.sizeId,
            quantity: passport.qtyCut,
          },
        });
      }
      await tx.passport.update({
        where: { id: passport.id },
        data: { currentCellId: cell.id },
      });
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.CELL_PLACED,
          cellId: cell.id,
          qty: passport.qtyCut,
        },
      });
    });

    const [detail, cellDetail] = await Promise.all([
      this.getOne(id),
      this.getCell(cell.id),
    ]);
    return { passport: detail, cell: cellDetail };
  }

  // -------------------------------------------------------------------------
  // ISSUE (Шаг 6: «Получить крой»)
  // -------------------------------------------------------------------------

  /**
   * Сценарий `F3a` (docs/flows.md): швея на активной смене снимает
   * паспорт с ячейки. В одной транзакции:
   *   - уменьшаем `CellContent.quantity` на `qtyCut`;
   *   - обнуляем `Passport.currentCellId`;
   *   - закрепляем паспорт за сотрудником (`currentEmployeeId`);
   *   - ставим `status = IN_PROGRESS`;
   *   - пишем событие `ISSUED_TO_EMPLOYEE` (operationId = session.operationId).
   *
   * `currentOperationId` на этом шаге НЕ меняем: выдача — это ещё не
   * перемещение на конкретную операцию. Первый `scan` у швеи на её
   * рабочем месте создаст `OPERATION_SCAN` и переведёт паспорт на
   * `session.operationId`.
   */
  async issueToEmployee(
    passportId: string,
    employeeId: string,
  ): Promise<PassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: { currentCell: true },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    this.assertPassportActive(passport.status);

    // Активная смена сотрудника обязательна (см. docs/flows.md §F8).
    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
    });
    if (!session) throw new ShiftSessionRequiredException();

    // «Паспорт уже выдан»: закреплён за сотрудником, но не в ячейке.
    if (passport.currentEmployeeId && !passport.currentCellId) {
      throw new PassportAlreadyIssuedException();
    }
    // Можно выдавать только то, что лежит в ячейке.
    if (!passport.currentCellId) throw new PassportNotInCellException();

    await this.prisma.$transaction(async (tx) => {
      const content = await tx.cellContent.findUnique({
        where: {
          cellId_sizeId: {
            cellId: passport.currentCellId!,
            sizeId: passport.sizeId,
          },
        },
      });
      if (content) {
        const nextQty = Math.max(content.quantity - passport.qtyCut, 0);
        await tx.cellContent.update({
          where: { id: content.id },
          data: { quantity: nextQty },
        });
      }
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentCellId: null,
          currentEmployeeId: employeeId,
          status: PassportStatus.IN_PROGRESS,
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.ISSUED_TO_EMPLOYEE,
          cellId: passport.currentCellId,
          operationId: session.operationId,
          employeeId,
          qty: passport.qtyCut,
        },
      });
    });

    this.logger.log(
      `event=passport.issue passportId=${passportId} employeeId=${employeeId} operationId=${session.operationId}`,
    );
    return this.getOne(passportId);
  }

  // -------------------------------------------------------------------------
  // SCAN (Шаг 6: сканирование на операции)
  // -------------------------------------------------------------------------

  /**
   * Сценарий `F4` (docs/flows.md) на уровне Шага 6: любое сканирование =
   * переход. Берём `operationId` из активной смены и обновляем
   * `currentOperationId` / `currentEmployeeId`, пишем `OPERATION_SCAN`.
   *
   * Идемпотентность (ADR-0003 §6): повторный скан того же паспорта на
   * той же операции тем же сотрудником — no-op, возвращаем текущее
   * состояние без новых событий.
   */
  async scanOnOperation(
    passportId: string,
    employeeId: string,
  ): Promise<PassportDetailDto> {
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
    this.assertPassportActive(passport.status);

    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      include: { operation: { select: { category: true } } },
    });
    if (!session) throw new ShiftSessionRequiredException();

    // QC-gate для входа на ВТО (см. docs/flows.md §F6 / ADR-0013):
    // нельзя «принять» паспорт на операцию категории `IRONING`,
    // если по нему ещё нет ни одного `PassportEvent(QC_PASSED)`.
    // Источник истины — backend, чтобы scan-driven обход через
    // `/api/passports/:id/scan` не мог выполнить вход на ВТО без ОТК.
    // Пропускаем сменный no-op (это просто idempotent re-scan на той же
    // операции, ничего нового по pipeline не происходит).
    if (
      session.operation.category === OperationCategory.IRONING &&
      passport.currentOperationId !== session.operationId
    ) {
      const qcPassed = await this.prisma.passportEvent.findFirst({
        where: { passportId, type: PassportEventType.QC_PASSED },
        select: { id: true },
      });
      if (!qcPassed) throw new PassportNotQcPassedException();
    }

    const sameOp = passport.currentOperationId === session.operationId;
    const sameEmployee = passport.currentEmployeeId === employeeId;
    if (sameOp && sameEmployee && passport.status === PassportStatus.IN_PROGRESS) {
      // Шаг 12: явный лог идемпотентного повторного скана —
      // помогает на пилоте отличать «реальный двойной скан» от
      // настоящего перехода (см. ADR-0003 §6).
      this.logger.log(
        `event=passport.scan.noop passportId=${passportId} employeeId=${employeeId} operationId=${session.operationId}`,
      );
      return this.getOne(passportId);
    }

    // Сохраняем «предыдущих» actor/operation ДО апдейта — они нужны
    // Шагу 9 для начисления pending-earning по уже завершённой операции.
    const previousOperationId = passport.currentOperationId;
    const previousEmployeeId = passport.currentEmployeeId;

    // Soft-route MVP: если у заказа есть snapshot маршрута и
    // отсканированная операция в нём встречается — двигаем
    // `currentRouteStepIndex`. Если операция не из маршрута, оставляем
    // прежнее значение (НЕ ломаем UI-подсказку, НЕ кидаем 409). См.
    // `docs/domain.md §«Маршруты производства»`.
    const matchedStep = await this.prisma.orderRouteStep.findFirst({
      where: { orderId: passport.orderId, operationId: session.operationId },
      select: { index: true },
    });
    const nextRouteStepIndex =
      matchedStep !== null ? matchedStep.index : passport.currentRouteStepIndex;

    await this.prisma.$transaction(async (tx) => {
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentOperationId: session.operationId,
          currentEmployeeId: employeeId,
          status: PassportStatus.IN_PROGRESS,
          currentRouteStepIndex: nextRouteStepIndex,
        },
      });
      const event = await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.OPERATION_SCAN,
          operationId: session.operationId,
          fromOperationId: previousOperationId,
          employeeId,
          qty: passport.qtyGood,
        },
      });
      // Шаг 9 (ADR-0005): начисление PENDING_RELEASE предыдущему
      // исполнителю предыдущей операции. Сервис сам решит, выписывать
      // ли начисление: проверит, что operation — piecework и не CUT_CUT
      // (он покрыт immediate-веткой), а employee — на сдельной оплате.
      // Дубли защищены `@@unique` и обработкой P2002 в сервисе.
      await this.earnings.createPendingForPreviousOperation(tx, {
        passportId: passport.id,
        previousOperationId,
        previousEmployeeId,
        productId: passport.productId,
        sizeId: passport.sizeId,
        qty: passport.qtyCut,
        sourceEventId: event.id,
      });
    });

    this.logger.log(
      `event=passport.scan passportId=${passportId} employeeId=${employeeId} operationId=${session.operationId} fromOperationId=${previousOperationId ?? '-'}`,
    );
    return this.getOne(passportId);
  }

  // -------------------------------------------------------------------------
  // COMPLETE OPERATION (Шаг 6: швея завершает свою операцию через скан)
  // -------------------------------------------------------------------------

  /**
   * Завершение операции швеёй через повторный скан того же паспорта.
   *
   * На MVP 1.1 (MVP 1.2) семантика такая: швея завершает свою работу
   * сознательно и явно — сканирует паспорт ещё раз и подтверждает в
   * модалке. Дальнейшее движение паспорта по цепочке остаётся
   * pipeline-driven: следующий сотрудник (или упаковщик) перехватит
   * его штатным `scan`/`issue`, и `currentOperationId` поменяется там.
   *
   * Что делаем в одной транзакции:
   *   - проверяем, что паспорт в `IN_PROGRESS` и закреплён за `employeeId`;
   *   - снимаем `currentEmployeeId = null` — паспорт мгновенно уходит
   *     из `current-work` этой швеи (см. `ShiftsService.getCurrentWork`);
   *   - `currentOperationId` НЕ трогаем: это всё ещё «операция паспорта»,
   *     просто без активного исполнителя; статус тоже остаётся
   *     `IN_PROGRESS` — завершение — это ещё не упаковка и не отмена;
   *   - пишем событие `OPERATION_FINISHED` с `operationId =
   *     passport.currentOperationId` (если есть) и `qty = qtyGood`.
   *
   * Безопасность (ТЗ §7.2): нельзя завершить чужой паспорт — 409
   * `PASSPORT_NOT_YOURS`. Нельзя завершать паспорт вне `IN_PROGRESS`
   * (например, сразу после `place` или после `PACKED`) — 409
   * `PASSPORT_NOT_IN_PROGRESS`.
   */
  async completeOperationByEmployee(
    passportId: string,
    employeeId: string,
  ): Promise<PassportDetailDto> {
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
    // Терминальные статусы отсекаем специализированными ошибками,
    // чтобы UI показывал понятный message (см. `docs/api.md §13`).
    this.assertPassportActive(passport.status);
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      throw new PassportNotInProgressException();
    }
    if (passport.currentEmployeeId !== employeeId) {
      throw new PassportNotYoursException();
    }

    // Активная смена нужна по тем же причинам, что для `issue`/`scan`:
    // начисления и аудит привязаны к сессии оборудования/операции
    // (см. `docs/flows.md §F8`).
    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
    });
    if (!session) throw new ShiftSessionRequiredException();

    await this.prisma.$transaction(async (tx) => {
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentEmployeeId: null,
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.OPERATION_FINISHED,
          operationId: passport.currentOperationId,
          fromOperationId: passport.currentOperationId,
          employeeId,
          qty: passport.qtyGood,
        },
      });
    });

    this.logger.log(
      `event=passport.complete-operation passportId=${passportId} employeeId=${employeeId} operationId=${passport.currentOperationId ?? '-'}`,
    );
    return this.getOne(passportId);
  }

  // -------------------------------------------------------------------------
  // LOOKUP по коду паспорта (для сканеров и ручного ввода, Шаг 6)
  // -------------------------------------------------------------------------

  /**
   * Находит паспорт по произвольному коду, введённому/просканированному
   * сотрудником. Поддерживаются форматы:
   *   - `passport:{id}`  — QR-код по ADR-0008;
   *   - `P-YYYYMMDD-NNNN` — номер паспорта;
   *   - голый `id` — на случай, когда код уже распарсен на клиенте.
   */
  async findByCode(code: string): Promise<PassportDetailDto> {
    const trimmed = code.trim();
    const idFromQr = trimmed.startsWith('passport:')
      ? trimmed.slice('passport:'.length)
      : trimmed;

    const row = await this.prisma.passport.findFirst({
      where: {
        OR: [
          { id: idFromQr },
          { qrCode: trimmed },
          { number: trimmed },
        ],
      },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: `Паспорт не найден по коду «${trimmed}»`,
      });
    }
    return this.getOne(row.id);
  }

  // -------------------------------------------------------------------------
  // CELLS (минимальный контракт под форму размещения)
  // -------------------------------------------------------------------------

  async listCells(): Promise<CellDetailDto[]> {
    const cells = await this.prisma.cell.findMany({
      where: { active: true },
      include: {
        contents: { include: { size: true } },
        warehouse: true,
      },
      orderBy: { code: 'asc' },
    });
    return cells.map((c) => this.toCellDto(c));
  }

  async getCell(id: string): Promise<CellDetailDto> {
    const cell = await this.prisma.cell.findUnique({
      where: { id },
      include: {
        contents: { include: { size: true } },
        warehouse: true,
      },
    });
    if (!cell) throw new CellNotFoundException();
    return this.toCellDto(cell);
  }

  /**
   * Резолв ячейки по произвольному коду (QR/человекочитаемый/id).
   * Поддерживаемые форматы (по [ADR-0008](./adr/0008-qr-format.md)):
   *   - `cell:{id}` — QR-код ячейки;
   *   - `A-01`     — человекочитаемый `code`;
   *   - голый `id` — на случай, когда QR уже распарсен на клиенте.
   *
   * Возвращаем тот же `CellDetailDto`, что `GET /api/cells/:id`. Если
   * ячейка деактивирована — кидаем `CELL_INACTIVE`, чтобы UI shelf-placement
   * сразу поймал ошибку до confirm-модалки и не пускал помощника
   * сканировать паспорта в выключенную ячейку.
   */
  async findCellByCode(code: string): Promise<CellDetailDto> {
    const trimmed = code.trim();
    const idFromQr = trimmed.startsWith('cell:')
      ? trimmed.slice('cell:'.length)
      : trimmed;
    const cell = await this.prisma.cell.findFirst({
      where: {
        OR: [{ id: idFromQr }, { qrCode: trimmed }, { code: trimmed }],
      },
      include: {
        contents: { include: { size: true } },
        warehouse: true,
      },
    });
    if (!cell) throw new CellNotFoundException();
    if (!cell.active) throw new CellInactiveException();
    return this.toCellDto(cell);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Паспорт должен быть в «живом» статусе для выдачи/скана. Терминальные
   * статусы отсекаем отдельными бизнес-ошибками, чтобы UI показывал
   * понятный message (см. `docs/api.md §13`).
   */
  private assertPassportActive(status: PassportStatus): void {
    if (status === PassportStatus.PACKED) {
      throw new PassportAlreadyPackedException();
    }
    if (status === PassportStatus.CANCELLED) {
      throw new PassportCancelledException();
    }
  }

  private async findCellByIdOrCode(cellId?: string, cellCode?: string) {
    let cell = null;
    if (cellId) {
      cell = await this.prisma.cell.findUnique({ where: { id: cellId } });
    } else if (cellCode) {
      cell = await this.prisma.cell.findUnique({
        where: { code: cellCode },
      });
    }
    if (!cell) throw new CellNotFoundException();
    if (!cell.active) throw new CellInactiveException();
    return cell;
  }

  private toDetailDto(row: PassportRow): PassportDetailDto {
    // На MVP `BoxItem(boxId, passportId)` уникален и однонаправлен:
    // паспорт лежит максимум в одной коробке (см. ADR-0011 §3).
    const boxItem = row.boxItems[0];
    return {
      id: row.id,
      number: row.number,
      status: row.status,
      cutDate: row.cutDate.toISOString(),
      createdAt: row.createdAt.toISOString(),
      qtyCut: row.qtyCut,
      qtyPlan: row.qtyPlan,
      qtyDefect: row.qtyDefect,
      qtyGood: row.qtyGood,
      rollNumber: row.rollNumber,
      sizeId: row.sizeId,
      sizeCode: row.size.code,
      sizeSortOrder: row.size.sortOrder,
      currentCell: row.currentCell
        ? { id: row.currentCell.id, code: row.currentCell.code }
        : null,
      currentRouteStepIndex: row.currentRouteStepIndex,
      qrCode: row.qrCode,
      printUrl: buildPassportPrintUrl(row.id),
      color: row.color,
      orderId: row.orderId,
      orderNumber: row.order.number,
      productId: row.productId,
      productName: row.product.name,
      cutterId: row.cutterId,
      cutterName: row.cutter.fullName,
      creatorId: row.creatorId,
      creatorName: row.creator.fullName,
      box: boxItem
        ? {
            id: boxItem.box.id,
            number: boxItem.box.number,
            status: boxItem.box.closedAt ? 'CLOSED' : 'OPEN',
          }
        : null,
    };
  }

  private toCellDto(
    cell: Prisma.CellGetPayload<{
      include: {
        contents: { include: { size: true } };
        warehouse: true;
      };
    }>,
  ): CellDetailDto {
    return {
      id: cell.id,
      code: cell.code,
      qrCode: cell.qrCode,
      active: cell.active,
      warehouse: cell.warehouse
        ? {
            id: cell.warehouse.id,
            name: cell.warehouse.name,
            code: cell.warehouse.code,
          }
        : null,
      contents: cell.contents
        .map((c) => ({
          sizeId: c.sizeId,
          sizeCode: c.size.code,
          sizeSortOrder: c.size.sortOrder,
          quantity: c.quantity,
        }))
        .sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
    };
  }
}
