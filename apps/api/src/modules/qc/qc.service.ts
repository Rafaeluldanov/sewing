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
  EligibleReworkTargetDto,
  ListQcPassportsQuery,
  PassportDefectDto,
  QcIncomingReworkDto,
  QcPassportDetailDto,
  QcPassportListItemDto,
  ReturnToReworkDto,
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
  PassportParallelGroupIncompleteException,
  PassportReworkAlreadyPendingException,
  PassportReworkRouteStepMissingException,
  PassportReworkTargetNotEligibleException,
} from '../../common/errors.js';
import { EarningsService } from '../earnings/earnings.service.js';
import { PushService } from '../push/push.service.js';

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
    private readonly push: PushService,
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
  // Incoming reworks (banner на /qc)
  // -------------------------------------------------------------------------

  /**
   * Список паспортов, которые мастер вернул на ОТК через backward
   * `set-route-step` и которые ждут, пока ОТК их отсканирует для
   * повторной проверки. Источник истины: паспорт стоит на операции
   * текущей смены ОТК-актора + на этой операции открыт
   * `OPERATION_REWORK_OPENED` (см. `MasterActionsService.setRouteStep`).
   *
   * Если у сотрудника нет активной смены или смена не на категории QC
   * — отдаём пустой список (нет операционного контекста, чтобы решить,
   * к кому возврат). Терминал `/qc` сам решает, показывать ли баннер.
   */
  async listIncomingReworks(employeeId: string): Promise<{
    items: QcIncomingReworkDto[];
  }> {
    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      include: { operation: { select: { id: true, category: true } } },
    });
    if (!session || session.operation.category !== OperationCategory.QC) {
      return { items: [] };
    }
    const qcOpId = session.operationId;
    const passports = await this.prisma.passport.findMany({
      where: {
        currentOperationId: qcOpId,
        status: PassportStatus.IN_PROGRESS,
      },
      include: {
        order: { select: { number: true } },
        product: { select: { name: true } },
        size: { select: { code: true, sortOrder: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (passports.length === 0) return { items: [] };

    const items: QcIncomingReworkDto[] = [];
    for (const p of passports) {
      const lastRework = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: p.id,
          operationId: qcOpId,
          type: PassportEventType.OPERATION_REWORK_OPENED,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (!lastRework) continue;
      const closedAfter = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: p.id,
          operationId: qcOpId,
          type: PassportEventType.OPERATION_FINISHED,
          createdAt: { gt: lastRework.createdAt },
        },
        select: { id: true },
      });
      if (closedAfter) continue;
      items.push({
        passportId: p.id,
        passportNumber: p.number,
        orderNumber: p.order.number,
        productName: p.product.name,
        color: p.color,
        sizeCode: p.size.code,
        sizeSortOrder: p.size.sortOrder,
        qtyGood: p.qtyGood,
        returnedAt: lastRework.createdAt.toISOString(),
      });
    }
    return { items };
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
    const retroactive = passport.status === PassportStatus.PACKED;
    if (passport.status !== PassportStatus.IN_PROGRESS) {
      if (retroactive) {
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

    // AND-гейт параллельной группы до ОТК. Зеркало
    // `PassportsService.evaluateRouteOrder` (см. `passports.service.ts`):
    // если в маршруте заказа есть параллельная группа целиком ДО шага
    // ОТК — все её операции должны быть закрыты (`OPERATION_FINISHED`),
    // иначе принимать ОТК нельзя. Это закрывает класс «застрял после
    // ОТК на ВТО» (инцидент 28.05.2026 на чёрных футболках, см.
    // `scripts/migrations/20260529_unblock_*`). Для retroactive
    // (PACKED-паспорт без QC_PASSED) пропускаем — историю не лечим.
    if (!retroactive) {
      await this.assertParallelGroupCompleteForQc(passport.id, passport.orderId);
    }

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
      // Для retroactive (`status==PACKED`) `currentOperationId`, как
      // правило, не на категории QC — пытаемся достать operationId
      // ОТК из маршрута заказа, иначе оставляем `currentOperationId`.
      const operationId = await resolveQcOperationId(
        tx,
        passport.currentOperationId,
        passport.orderId,
      );
      // Re-check после backward-возврата мастером: если на ОТК-операции
      // есть открытый `OPERATION_REWORK_OPENED` (мастер вернул паспорт
      // на повторную проверку, см. `MasterActionsService.setRouteStep`,
      // ветка `reopenFinishedTarget`), то идемпотентность по «любому
      // существующему QC_PASSED» неверна — это новый проход проверки.
      // Считаем «уже завершено» только если QC_PASSED был ПОСЛЕ
      // последнего rework на этой ОТК-операции; иначе пишем новый
      // QC_PASSED и в той же транзакции закрываем rework через
      // `OPERATION_FINISHED` (та же семантика, что у швеи на SEW-op).
      // Pending earnings за повторный проход не пишем — ОТК уже была
      // оплачена за первичную проверку.
      const lastReworkOnQcOp = operationId
        ? await tx.passportEvent.findFirst({
            where: {
              passportId,
              operationId,
              type: PassportEventType.OPERATION_REWORK_OPENED,
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          })
        : null;
      const existing = await tx.passportEvent.findFirst({
        where: {
          passportId,
          type: PassportEventType.QC_PASSED,
          ...(lastReworkOnQcOp
            ? { createdAt: { gt: lastReworkOnQcOp.createdAt } }
            : {}),
        },
        select: { id: true },
      });
      if (existing) return;
      const isRecheck = lastReworkOnQcOp !== null;
      const createdEvent = await tx.passportEvent.create({
        data: {
          passportId,
          type: PassportEventType.QC_PASSED,
          employeeId: actorEmployeeId,
          operationId,
          qty: passport.qtyGood,
        },
      });
      // Закрываем rework на ОТК-операции явным OPERATION_FINISHED —
      // чтобы `hasOpenRework` / `loadReworkAssignment` / `isReworkOpenForOp`
      // в дальнейшем не считали этот rework «висящим». Без этого
      // последующий повторный backward от мастера на ту же ОТК не
      // отработал бы как переоткрытие (lastRework есть, finishedOnTarget
      // нет → reopenFinishedTarget=false).
      if (isRecheck && operationId) {
        await tx.passportEvent.create({
          data: {
            passportId,
            type: PassportEventType.OPERATION_FINISHED,
            employeeId: actorEmployeeId,
            operationId,
            qty: passport.qtyGood,
          },
        });
      }
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
            recheck: isRecheck || undefined,
          },
        },
        tx,
      );
      // Сдельное начисление за ОТК (как у швеи на `OPERATION_FINISHED`).
      // Тихо пропускается, если у операции `pricingMode = SALARY_ONLY`,
      // нет ставки или сотрудник на чистом окладе. Для retroactive-ветки
      // (`status == PACKED`) выписываем сразу APPROVED — упаковка уже
      // была, второго `approvePendingForPassport` не случится. Для
      // re-check после backward от мастера повторное начисление не
      // пишем — оплата за первичную проверку уже зафиксирована.
      if (!isRecheck) {
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
      }
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
    dto: ReturnToReworkDto,
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

    // Единый источник истины — `eligibleReworkTargets`. UI рендерит
    // radio-список из этого же набора, бэк валидирует переданный
    // `targetOperationId` против него. Внутри метода:
    //   - проверяет, что хотя бы один OPERATION_FINISHED по паспорту
    //     вообще есть (иначе `PassportNoFinishedOperationException`);
    //   - проверяет, что target — SEW из маршрута без открытого rework.
    const targets = await this.computeEligibleReworkTargets(passport.id, passport.orderId);
    if (targets.length === 0) {
      // Edge-case: маршрут перерисовали ПОСЛЕ прохождения SEW; или
      // последний rework ещё не закрыт. Различаем для информативной
      // ошибки.
      const anyFinished = await this.prisma.passportEvent.findFirst({
        where: {
          passportId,
          type: PassportEventType.OPERATION_FINISHED,
        },
        select: { id: true },
      });
      if (!anyFinished) throw new PassportNoFinishedOperationException();
      const openSomewhere = await this.hasAnyOpenRework(passportId);
      if (openSomewhere) throw new PassportReworkAlreadyPendingException();
      throw new PassportReworkRouteStepMissingException();
    }

    const target = targets.find(
      (t) => t.operationId === dto.targetOperationId,
    );
    if (!target) throw new PassportReworkTargetNotEligibleException();

    // Адаптер под старые имена в дальнейшем коде транзакции.
    const lastFinished = {
      operationId: target.operationId,
      employeeId: target.finisherEmployeeId,
      createdAt: new Date(target.finishedAt),
    };
    const targetStep = {
      index: target.routeStepIndex,
      operationId: target.operationId,
    };

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

    // Фоновый Web Push швее-финишёру: будит её устройство даже при
    // свёрнутом приложении/потушенном экране, чтобы переделка
    // приоритизировалась, а не ждала, пока она откроет /work. Строго
    // ПОСЛЕ коммита и fire-and-forget — `notifyEmployee` не бросает,
    // доставка пуша не влияет на ответ ОТК (см. `PushService`).
    if (lastFinished.employeeId) {
      void this.push.notifyEmployee(lastFinished.employeeId, {
        tag: `rework:${passportId}:${targetStep.operationId}`,
        title: '⚠ Пришёл брак от ОТК',
        body: `${passport.number} · ${target.operationName} — заберите у ОТК и переделайте в первую очередь.`,
        url: '/work',
      });
    }

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

    const reconcile = await this.prisma.$transaction(async (tx) => {
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
      // Авто-пересчёт сдельной выработки по паспорту: выработка = qtyGood
      // для всех сдельных. Раскройщик и уже выплаченные строки не
      // трогаются (см. `EarningsService.reconcileToQtyGood`).
      return this.earnings.reconcileToQtyGood(tx, passportId);
    });

    this.logger.log(
      `event=qc.defect passportId=${passportId} defectTypeId=${defectType.id} qty=${dto.qty} actorId=${actorEmployeeId} reconciled=${reconcile.updated} skippedPaid=${reconcile.skipped.length}`,
    );
    if (reconcile.skipped.length > 0) {
      this.logger.warn(
        `event=qc.defect.reconcile.skipped passportId=${passportId} entryIds=${reconcile.skipped.map((s) => s.id).join(',')} reason=ALREADY_PAID`,
      );
    }
    return this.loadDetail(passportId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * AND-гейт параллельной группы перед `QC_PASSED`. Логика — зеркало
   * `PassportsService.evaluateRouteOrder.groupIncomplete` для случая,
   * когда target = шаг ОТК маршрута заказа: если есть параллельные
   * группы, целиком стоящие ДО ОТК, все их операции должны быть
   * закрыты `OPERATION_FINISHED` для этого паспорта. Если нет —
   * бросаем `PassportParallelGroupIncompleteException`.
   *
   * Заказы без маршрута / без шага ОТК / без параллельных групп —
   * пропускаем (no-op), как evaluateRouteOrder.
   */
  private async assertParallelGroupCompleteForQc(
    passportId: string,
    orderId: string | null,
  ): Promise<void> {
    if (!orderId) return;
    const steps = await this.prisma.orderRouteStep.findMany({
      where: { orderId },
      select: {
        index: true,
        operationId: true,
        parallelGroup: true,
        operation: { select: { category: true } },
      },
    });
    if (steps.length === 0) return;
    const qcStep = steps.find(
      (s) => s.operation.category === OperationCategory.QC,
    );
    if (!qcStep) return;

    const groupMax = new Map<number, number>();
    const groupOps = new Map<number, string[]>();
    for (const s of steps) {
      if (s.parallelGroup == null) continue;
      groupMax.set(
        s.parallelGroup,
        Math.max(groupMax.get(s.parallelGroup) ?? s.index, s.index),
      );
      const arr = groupOps.get(s.parallelGroup) ?? [];
      arr.push(s.operationId);
      groupOps.set(s.parallelGroup, arr);
    }
    const groupsBefore: number[] = [];
    for (const [g, gMax] of groupMax) {
      if (gMax < qcStep.index) groupsBefore.push(g);
    }
    if (groupsBefore.length === 0) return;

    // Substitute-правила (см. `OperationSubstitution`): закрытие
    // substitute засчитывает satisfies (см. `evaluateRouteOrder` в
    // `passports.service.ts`).
    const [finished, substitutes] = await Promise.all([
      this.prisma.passportEvent.findMany({
        where: {
          passportId,
          type: PassportEventType.OPERATION_FINISHED,
          operationId: { not: null },
        },
        select: { operationId: true },
      }),
      this.prisma.operationSubstitution.findMany({
        where: {
          satisfiesOpId: {
            in: [...groupsBefore.flatMap((g) => groupOps.get(g) ?? [])],
          },
        },
        select: { satisfiesOpId: true, substituteOpId: true },
      }),
    ]);
    const finishedSet = new Set(finished.map((e) => e.operationId));
    const substitutesFor = new Map<string, string[]>();
    for (const s of substitutes) {
      const arr = substitutesFor.get(s.satisfiesOpId) ?? [];
      arr.push(s.substituteOpId);
      substitutesFor.set(s.satisfiesOpId, arr);
    }
    const isSatisfied = (opId: string): boolean => {
      if (finishedSet.has(opId)) return true;
      const subs = substitutesFor.get(opId);
      if (!subs) return false;
      return subs.some((sub) => finishedSet.has(sub));
    };
    for (const g of groupsBefore) {
      const ops = groupOps.get(g) ?? [];
      if (!ops.every(isSatisfied)) {
        throw new PassportParallelGroupIncompleteException();
      }
    }
  }

  private async loadDetail(passportId: string): Promise<QcPassportDetailDto> {
    const r = await this.prisma.passport.findUnique({
      where: { id: passportId },
      include: {
        order: { select: { id: true, number: true } },
        product: { select: { name: true } },
        size: true,
        currentOperation: {
          select: { id: true, code: true, name: true, category: true },
        },
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
    // Особый случай — «мастер вернул паспорт на повторную ОТК-проверку»
    // (`MasterActionsService.setRouteStep` backward на ОТК-операцию):
    // `OPERATION_REWORK_OPENED` висит на самой ОТК-операции, паспорт
    // стоит на ней (`currentOperationId`). UI должен показать карточку
    // в рабочем режиме (а не как read-only «ждёт переделки у швеи») +
    // отдельную плашку «возвращён мастером» — для этого считаем
    // `incomingReworkAtQc` и не учитываем этот rework в общем
    // `reworkPending`. См. `docs/flows.md §F5a`.
    const currentOpIsQc = r.currentOperation?.category === OperationCategory.QC;
    const incomingReworkAtQc =
      currentOpIsQc && r.currentOperationId
        ? await this.isReworkOpenForOp(passportId, r.currentOperationId)
        : false;
    const reworkPending = await this.hasAnyOpenRework(
      passportId,
      incomingReworkAtQc ? r.currentOperationId : null,
    );
    // Кандидаты на возврат: SEW-операции из маршрута, у которых есть
    // OPERATION_FINISHED и нет открытого rework. Если есть open rework
    // где-либо — кандидатов не отдаём, кнопка прячется UI-флагом
    // `canReturnToRework` (см. ниже).
    const eligibleReworkTargets = reworkPending
      ? []
      : await this.computeEligibleReworkTargets(r.id, r.orderId);
    // Для read-only баннера: подробности активного rework. Берём
    // последний открытый `OPERATION_REWORK_OPENED` (его `employeeId`
    // — целевая швея) и подтягиваем имя + название операции. Для
    // `incomingReworkAtQc` баннер не нужен — UI рисует свою плашку
    // «возвращён мастером», поэтому передаём `excludeOperationId`,
    // чтобы не подставить сюда самого ОТК-финишёра.
    const reworkAssignment = reworkPending
      ? await this.loadReworkAssignment(
          passportId,
          incomingReworkAtQc ? r.currentOperationId : null,
        )
      : null;
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
      } else if (incomingReworkAtQc) {
        // Мастер вернул паспорт на ОТК через backward set-route-step:
        // OPERATION_SCAN от следующей операции (например, ВТО) висит
        // в истории после `lastQcPassed`, но паспорт сейчас снова на
        // ОТК и ждёт повторной проверки. Сворачивать карточку нельзя.
        removedFromQc = false;
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
      // При `incomingReworkAtQc` карточка показывает повторный проход
      // проверки — старый `QC_PASSED` от ПРЕДЫДУЩЕГО прохода в UI как
      // «уже проверено» не считаем, иначе сверху висел бы зелёный бейдж
      // и ОТК подумал бы, что делать ничего не надо. Свежий QC_PASSED
      // (после повторного «Проверка выполнена») закроет rework и снова
      // включит этот срез.
      qcCompletedAt: incomingReworkAtQc
        ? null
        : lastQcPassed?.createdAt.toISOString() ?? null,
      canCompleteQc:
        !reworkPending &&
        (r.status === PassportStatus.IN_PROGRESS ||
          (r.status === PassportStatus.PACKED && lastQcPassed === null)),
      // Кнопка «Вернуть на переделку» активна, если есть хотя бы
      // один eligible-кандидат и паспорт `IN_PROGRESS`. `reworkPending`
      // обнуляет список выше, так что отдельный чек тут излишен.
      canReturnToRework:
        r.status === PassportStatus.IN_PROGRESS &&
        eligibleReworkTargets.length > 0,
      eligibleReworkTargets,
      reworkPending,
      reworkAssignment,
      removedFromQc,
      incomingReworkAtQc,
    };
  }

  /**
   * Подробности активного rework (для read-only баннера в QC-карточке).
   * Возвращает данные последнего открытого `OPERATION_REWORK_OPENED`
   * — той швее, что ждёт паспорт, и операции, на которую он возвращён.
   */
  private async loadReworkAssignment(
    passportId: string,
    excludeOperationId?: string | null,
  ): Promise<{
    operationId: string;
    operationCode: string;
    operationName: string;
    employeeId: string;
    employeeName: string;
    reworkedAt: string;
  } | null> {
    const reworks = await this.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
        operationId: { not: null },
      },
      select: {
        operationId: true,
        employeeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (reworks.length === 0) return null;

    // Берём самый свежий rework, для которого ещё нет последующего
    // FINISHED по той же операции (т.е. реально открытый).
    for (const r of reworks) {
      if (!r.operationId || !r.employeeId) continue;
      if (excludeOperationId && r.operationId === excludeOperationId) continue;
      const finishedAfter = await this.prisma.passportEvent.findFirst({
        where: {
          passportId,
          operationId: r.operationId,
          type: PassportEventType.OPERATION_FINISHED,
          createdAt: { gt: r.createdAt },
        },
        select: { id: true },
      });
      if (finishedAfter) continue;
      const [op, emp] = await Promise.all([
        this.prisma.operation.findUnique({
          where: { id: r.operationId },
          select: { code: true, name: true },
        }),
        this.prisma.employee.findUnique({
          where: { id: r.employeeId },
          select: { fullName: true },
        }),
      ]);
      if (!op || !emp) continue;
      return {
        operationId: r.operationId,
        operationCode: op.code,
        operationName: op.name,
        employeeId: r.employeeId,
        employeeName: emp.fullName,
        reworkedAt: r.createdAt.toISOString(),
      };
    }
    return null;
  }

  /**
   * Возвращает SEW-операции из маршрута заказа, на которые можно
   * вернуть паспорт. Условие eligibility:
   *   - категория `SEWING`;
   *   - по паспорту есть хотя бы один `OPERATION_FINISHED`;
   *   - нет открытого rework для этой пары (passport, operation).
   *
   * Если у заказа нет маршрута — возвращаем пустой список (вернуть
   * некуда). Имя финишёра берём из самого свежего `OPERATION_FINISHED`
   * для каждой операции.
   */
  private async computeEligibleReworkTargets(
    passportId: string,
    orderId: string | null,
  ): Promise<EligibleReworkTargetDto[]> {
    if (!orderId) return [];
    const steps = await this.prisma.orderRouteStep.findMany({
      where: {
        orderId,
        operation: { category: OperationCategory.SEWING },
      },
      select: {
        index: true,
        operationId: true,
        operation: { select: { code: true, name: true } },
      },
      orderBy: { index: 'asc' },
    });
    if (steps.length === 0) return [];

    const operationIds = steps.map((s) => s.operationId);
    // Тащим все события OPERATION_FINISHED и OPERATION_REWORK_OPENED
    // для этих операций одним батчем, чтобы не плодить N+1. Для каждой
    // операции возьмём самое свежее FINISHED и определим, не открыт ли
    // rework позже него.
    const events = await this.prisma.passportEvent.findMany({
      where: {
        passportId,
        operationId: { in: operationIds },
        type: {
          in: [
            PassportEventType.OPERATION_FINISHED,
            PassportEventType.OPERATION_REWORK_OPENED,
          ],
        },
      },
      select: {
        type: true,
        operationId: true,
        employeeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    type EventRow = {
      type: PassportEventType;
      operationId: string | null;
      employeeId: string | null;
      createdAt: Date;
    };
    const lastFinishedByOp = new Map<string, EventRow>();
    const lastReworkByOp = new Map<string, EventRow>();
    for (const ev of events) {
      if (!ev.operationId) continue;
      if (
        ev.type === PassportEventType.OPERATION_FINISHED &&
        !lastFinishedByOp.has(ev.operationId)
      ) {
        lastFinishedByOp.set(ev.operationId, ev);
      }
      if (
        ev.type === PassportEventType.OPERATION_REWORK_OPENED &&
        !lastReworkByOp.has(ev.operationId)
      ) {
        lastReworkByOp.set(ev.operationId, ev);
      }
    }

    const eligibleSteps = steps.filter((s) => {
      const finished = lastFinishedByOp.get(s.operationId);
      if (!finished || !finished.employeeId) return false;
      const rework = lastReworkByOp.get(s.operationId);
      if (rework && rework.createdAt > finished.createdAt) return false;
      return true;
    });
    if (eligibleSteps.length === 0) return [];

    const finisherIds = Array.from(
      new Set(
        eligibleSteps
          .map((s) => lastFinishedByOp.get(s.operationId)?.employeeId)
          .filter((x): x is string => !!x),
      ),
    );
    const employees = await this.prisma.employee.findMany({
      where: { id: { in: finisherIds } },
      select: { id: true, fullName: true },
    });
    const empById = new Map(employees.map((e) => [e.id, e.fullName]));

    return eligibleSteps.map((s) => {
      const fin = lastFinishedByOp.get(s.operationId)!;
      return {
        operationId: s.operationId,
        operationCode: s.operation.code,
        operationName: s.operation.name,
        routeStepIndex: s.index,
        finisherEmployeeId: fin.employeeId!,
        finisherEmployeeName: empById.get(fin.employeeId!) ?? '—',
        finishedAt: fin.createdAt.toISOString(),
      };
    });
  }

  /**
   * Есть ли по паспорту хотя бы один «открытый» rework — то есть
   * `OPERATION_REWORK_OPENED` без последующего `OPERATION_FINISHED`
   * для той же (passport, operation). Локальный аналог
   * `PassportsService.hasOpenRework`, чтобы не вешать cross-module
   * зависимость; обе функции делают одно и то же по тем же таблицам.
   */
  private async hasAnyOpenRework(
    passportId: string,
    excludeOperationId?: string | null,
  ): Promise<boolean> {
    const events = await this.prisma.passportEvent.findMany({
      where: {
        passportId,
        type: {
          in: [
            PassportEventType.OPERATION_REWORK_OPENED,
            PassportEventType.OPERATION_FINISHED,
          ],
        },
        operationId: { not: null },
      },
      select: { type: true, operationId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const lastByOp = new Map<string, PassportEventType>();
    for (const ev of events) {
      if (!ev.operationId) continue;
      if (!lastByOp.has(ev.operationId)) lastByOp.set(ev.operationId, ev.type);
    }
    for (const [opId, t] of lastByOp) {
      if (excludeOperationId && opId === excludeOperationId) continue;
      if (t === PassportEventType.OPERATION_REWORK_OPENED) return true;
    }
    return false;
  }

  /**
   * «Открыт ли rework именно на этой операции» — точечный вариант
   * `hasAnyOpenRework` для одной operationId. Используется в
   * `loadDetail` для флага `incomingReworkAtQc` (мастер вернул паспорт
   * на ОТК через backward set-route-step).
   */
  private async isReworkOpenForOp(
    passportId: string,
    operationId: string,
  ): Promise<boolean> {
    const lastRework = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        operationId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!lastRework) return false;
    const finishedAfter = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        operationId,
        type: PassportEventType.OPERATION_FINISHED,
        createdAt: { gt: lastRework.createdAt },
      },
      select: { id: true },
    });
    return finishedAfter === null;
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
