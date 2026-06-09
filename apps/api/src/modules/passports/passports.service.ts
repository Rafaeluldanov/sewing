import {
  BadRequestException,
  HttpException,
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
  PASSPORT_EVENT_LABELS,
  type CellDetailDto,
  type CreatePassportDto,
  type MyPassportListItem,
  type PassportDetailDto,
  type PassportEditableBlock,
  type PassportHistoryDto,
  type PassportHistoryEventDto,
  type PassportHistoryEventType,
  type PassportListItemDto,
  type PassportPlacementResultDto,
  type PassportRouteHintDto,
  type PassportRouteStepLiteDto,
  type PlacePassportDto,
  type ReleaseFromRollsDto,
  type ReleaseFromRollsResultDto,
  type UpdatePassportDto,
} from '@sewing/shared/passports';
import type { BatchCompleteOperationsResultDto } from '@sewing/shared/shifts';
import { normalizeColor } from '@sewing/shared/colors';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CellInactiveException,
  CellNotFoundException,
  CutterInactiveException,
  CutterNotFoundException,
  CutterRequiredException,
  PassportAlreadyIssuedException,
  PassportAlreadyPackedException,
  PassportAlreadyPlacedException,
  PassportCancelledException,
  PassportCompleteBackwardException,
  PassportCuttingClosedException,
  PassportHasApprovedEarningsException,
  PassportHasPostedMaterialIssueException,
  PassportNotEditableException,
  PassportNotInCellException,
  PassportNotInProgressException,
  PassportOperationAlreadyFinishedException,
  PassportNotPlaceableException,
  PassportNotQcPassedException,
  PassportNotYoursException,
  PassportIssueBackwardException,
  PassportParallelGroupIncompleteException,
  PassportReworkOperationNotAllowedForShiftException,
  PassportReworkPendingException,
  PassportScanBackwardException,
  PassportNotYoursToEditException,
  PassportOrderNotInProductionException,
  PassportPackedDeleteException,
  PassportQtyExceedsRemainingException,
  PassportSizeNotInOrderException,
  ShiftSessionRequiredException,
} from '../../common/errors.js';
import { OperationCategory, Role } from '@prisma/client';
import { PassportNumberService } from './passport-number.service.js';
import { buildPassportPrintUrl, buildPassportQrPayload } from './qr.js';
import { EarningsService } from '../earnings/earnings.service.js';
import { CuttingClosureService } from '../cutting-closure/cutting-closure.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CutReleasePolicyService } from '../cut-release-policy/cut-release-policy.service.js';
import { OrderCutIssueRulesService } from '../order-cut-issue-rules/order-cut-issue-rules.service.js';
import { MaterialIssuesService } from '../material-issues/material-issues.service.js';
import { CompanySettingsService } from '../company-settings/company-settings.service.js';
import { FinishedGoodsService } from '../finished-goods/finished-goods.service.js';
import { WorkInProgressService } from '../work-in-progress/work-in-progress.service.js';

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

/**
 * Опции `getOne(...)`. На MVP единственная — `employeeIdForRouteHint`:
 * если передан, сервис подтянет активную смену сотрудника и заполнит
 * `routeHint.routeMismatchWithActiveShift` / `activeShiftOperation*`.
 *
 * Без этой опции `routeHint` всё равно может быть непустым (current/next
 * шаги маршрута), просто без сравнения с активной сменой.
 */
interface GetOneOptions {
  employeeIdForRouteHint?: string;
}

/**
 * Достаёт человеко-читаемое сообщение и бизнес-код из ошибки, брошенной
 * `completeOperationByEmployee`, для строки `failed[]` пакетного ответа.
 * `BusinessException`/Nest-исключения кладут `{ message, code }` в тело
 * ответа (`HttpException.getResponse()`), его и разбираем; всё прочее
 * сводим к нейтральному тексту без code.
 */
function describeBatchCompleteError(e: unknown): {
  error: string;
  code: string | null;
} {
  if (e instanceof HttpException) {
    const res = e.getResponse();
    if (res && typeof res === 'object') {
      const obj = res as { message?: unknown; code?: unknown };
      return {
        error: typeof obj.message === 'string' ? obj.message : e.message,
        code: typeof obj.code === 'string' ? obj.code : null,
      };
    }
    return { error: e.message, code: null };
  }
  return { error: 'Не удалось завершить операцию', code: null };
}

@Injectable()
export class PassportsService {
  private readonly logger = new Logger(PassportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: PassportNumberService,
    private readonly earnings: EarningsService,
    private readonly closure: CuttingClosureService,
    private readonly audit: AuditService,
    private readonly cutReleasePolicy: CutReleasePolicyService,
    private readonly orderCutIssueRules: OrderCutIssueRulesService,
    private readonly materialIssues: MaterialIssuesService,
    private readonly companySettings: CompanySettingsService,
    private readonly finishedGoods: FinishedGoodsService,
    private readonly workInProgress: WorkInProgressService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Создание паспорта (выпуск кроя) — `creatorId` приходит из сессии
   * (ADR-0014).
   *
   * **PHASE 2 STEP 3 — Cutter attribution.** `cutterId` теперь
   * обязан быть явно определён, а не подобран по seed-учётке
   * `Employee.login = 'cutter'` (это давало ложные начисления при
   * любом несовпадении логина и рушило payroll, см.
   * `docs/domain.md §«Cutter attribution»`).
   *
   * Алгоритм:
   *   1. Если в `dto.cutterId` пришёл явный id — валидируем и
   *      используем его (сотрудник должен существовать, иметь роль
   *      `CUTTER` и `active = true`). Иначе — `CUTTER_NOT_FOUND` /
   *      `CUTTER_INACTIVE`.
   *   2. Если `dto.cutterId` не пришёл, но `creator.role === CUTTER`
   *      → атрибуция creator-у самому (исторический happy-path для
   *      рабочего места раскройщика).
   *   3. Иначе (creator с ролью CUTTER_ASSISTANT / SHOP_MANAGER /
   *      ADMIN без `cutterId`) → 400 `CUTTER_REQUIRED`. UI обязан
   *      показать select раскройщика для этих ролей.
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
    // Цвет нормализуем при создании паспорта (даже если источник —
    // legacy `Product.color` или ещё не нормализованный `Order.color`).
    // Без этого однородность коробки в `PackingService.addPassport`
    // ломалась на «Белый» vs «белый» из разных периодов (см.
    // `packages/shared/src/colors.ts::normalizeColor`).
    const color = normalizeColor(order.color ?? product.color);

    // creator = текущий пользователь сессии (см. ADR-0014).
    // cutter (раскройщик) с PHASE 2 STEP 3 определяется явно: либо
    // переданный `dto.cutterId` (валидируется ниже), либо сам creator,
    // если у него role = CUTTER. Старая привязка к seed-учётке
    // `Employee.login = 'cutter'` удалена, см. JSDoc метода.
    const [creator, divisionOp] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: creatorEmployeeId } }),
      this.prisma.operation.findUnique({ where: { code: 'CUT_DIVISION' } }),
    ]);
    if (!creator) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Сотрудник-инициатор не найден.',
      });
    }
    if (!divisionOp) {
      // На корректно поднятом инстансе этой ветки быть не должно:
      // `ReferenceDataBootstrapService.onApplicationBootstrap`
      // (`apps/api/src/modules/bootstrap/reference-data.service.ts`)
      // создаёт `CUT_DIVISION` при старте Nest. Если строка
      // действительно отсутствует — менеджер случайно удалил её через
      // `/admin/operations`; перезапуск контейнера её восстановит.
      throw new BadRequestException({
        statusCode: 400,
        code: 'OPERATION_NOT_FOUND',
        message:
          'В справочнике нет операции CUT_DIVISION. Восстановите её в /admin/operations или перезапустите API — bootstrap создаёт её автоматически.',
      });
    }
    const cutter = await this.resolveCutter(dto.cutterId, creator);

    // Soft-route MVP: если у заказа уже есть snapshot маршрута — у
    // нового паспорта проставляем `currentRouteStepIndex = 0`. Это
    // подсказка для UI: «маршрут известен, паспорт стоит в начале».
    // Никакого enforcement: значение остаётся UI-подсказкой.
    const initialRouteStepIndex = order.routeSteps.length > 0 ? 0 : null;

    const id = await this.prisma.$transaction(async (tx) => {
      const lite = await this.createOnePassportInTx(tx, {
        orderId: order.id,
        productId: product.id,
        sizeId: dto.sizeId,
        color,
        rollNumber: dto.rollNumber,
        rollOrdinal: null,
        cutDate: new Date(dto.cutDate),
        qty: dto.qtyCut,
        cutterId: cutter.id,
        creatorId: creator.id,
        divisionOpId: divisionOp.id,
        initialRouteStepIndex,
      });
      return lite.id;
    });
    this.logger.log(
      `event=passport.create passportId=${id} orderId=${order.id} sizeId=${dto.sizeId} qtyCut=${dto.qtyCut} creatorId=${creator.id}`,
    );
    return this.getOne(id);
  }

  /**
   * Создаёт один паспорт внутри переданной транзакции: генерация номера,
   * запись паспорта (+ финальный QR), событие `CREATED` и immediate-
   * начисление раскройщику (ADR-0005). Общий код для ручного выпуска
   * (`create`) и рулонного выпуска помощником (`releaseFromRolls`),
   * чтобы инварианты «паспорт + зарплата атомарно» жили в одном месте.
   *
   * `rollOrdinal` — порядковый номер рулона из `CuttingTask` для
   * рулонного выпуска; `null` для ручной формы.
   */
  private async createOnePassportInTx(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      productId: string;
      sizeId: string;
      color: string;
      rollNumber: string;
      rollOrdinal: number | null;
      cutDate: Date;
      qty: number;
      cutterId: string;
      creatorId: string;
      divisionOpId: string;
      initialRouteStepIndex: number | null;
    },
  ): Promise<{
    id: string;
    number: string;
    qtyCut: number;
    rollNumber: string;
    rollOrdinal: number | null;
  }> {
    const number = await this.numbers.nextNumber(tx);
    const created = await tx.passport.create({
      data: {
        number,
        // qrCode UNIQUE NOT NULL — проставим финальный `passport:{id}`
        // вторым шагом в этой же транзакции, когда узнаем id.
        qrCode: `passport-pending:${number}`,
        orderId: params.orderId,
        productId: params.productId,
        sizeId: params.sizeId,
        color: params.color,
        rollNumber: params.rollNumber,
        rollOrdinal: params.rollOrdinal,
        cutDate: params.cutDate,
        qtyPlan: params.qty,
        qtyCut: params.qty,
        qtyDefect: 0,
        qtyGood: params.qty,
        status: PassportStatus.CREATED,
        currentOperationId: params.divisionOpId,
        currentEmployeeId: params.creatorId,
        cutterId: params.cutterId,
        creatorId: params.creatorId,
        currentRouteStepIndex: params.initialRouteStepIndex,
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
        operationId: params.divisionOpId,
        employeeId: params.creatorId,
        qty: params.qty,
        payload: {
          rollNumber: params.rollNumber,
          color: params.color,
        },
      },
    });
    // Шаг 9 (ADR-0005): immediate-начисление раскройщику. Делается в той
    // же транзакции, чтобы паспорт и зарплата жили атомарно. При
    // отсутствии ставки в `OperationRateBySize` для пары
    // `(operationId, sizeId)` сервис кидает 422 `OPERATION_RATE_MISSING`.
    await this.earnings.createImmediateForCutter(tx, {
      passportId: created.id,
      cutterId: params.cutterId,
      sizeId: params.sizeId,
      productId: params.productId,
      qty: params.qty,
    });
    return {
      id: created.id,
      number: created.number,
      qtyCut: created.qtyCut,
      rollNumber: created.rollNumber,
      rollOrdinal: created.rollOrdinal,
    };
  }

  /**
   * Рулонный выпуск паспортов помощником раскройщика
   * (`POST /api/passports/release-from-rolls`).
   *
   * Помощник ничего не вводит руками: количество и рулоны берутся из
   * завершённой задачи раскройщика (`CuttingTask`). На каждый выбранный
   * рулон создаётся паспорт с `qtyCut = слои рулона × раскладка размера`
   * (`CuttingTaskRoll.layers × CuttingTaskSizeRow.perLayerQty`) и
   * `rollOrdinal = ordinal`. Сдельное за раскрой идёт автоматически
   * раскройщику задачи (`CuttingTask.assignedToId`).
   *
   * Идемпотентно: пары `(sizeId, ordinal)`, по которым паспорт уже
   * выпущен (есть non-CANCELLED паспорт с этим `rollOrdinal`), —
   * пропускаются. Это закрывает кейс «сломался принтер → продолжить с
   * нужного рулона» и защищает от двойного клика. Сохраняются прежние
   * инварианты: заказ в производстве, closure-блок (ADR-0018) и
   * `Σ qtyCut ≤ остаток плана` по размеру.
   */
  async releaseFromRolls(
    dto: ReleaseFromRollsDto,
    creatorEmployeeId: string,
  ): Promise<ReleaseFromRollsResultDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      include: {
        items: { include: { product: true } },
        passports: true,
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
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new PassportOrderNotInProductionException();
    }

    const orderItem = order.items.find((it) => it.sizeId === dto.sizeId);
    if (!orderItem) {
      throw new PassportSizeNotInOrderException();
    }

    // ADR-0018: подтверждённое закрытие раскроя по строке блокирует выпуск.
    const closed = await this.closure.hasApprovedClosure(
      order.id,
      orderItem.productId,
      dto.sizeId,
    );
    if (closed) throw new PassportCuttingClosedException();

    // Источник рулонов и раскладки — завершённая задача раскройщика.
    const task = await this.prisma.cuttingTask.findUnique({
      where: { orderId: order.id },
      include: {
        sizeRows: { select: { sizeId: true, perLayerQty: true } },
        rolls: { select: { ordinal: true, layers: true } },
      },
    });
    if (!task) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'CUTTING_TASK_NOT_FOUND',
        message: 'Для заказа нет задачи раскроя.',
      });
    }
    if (task.status !== 'DONE') {
      throw new BadRequestException({
        statusCode: 400,
        code: 'CUTTING_TASK_NOT_DONE',
        message: 'Раскрой по заказу ещё не завершён — выпуск недоступен.',
      });
    }
    const sizeRow = task.sizeRows.find((r) => r.sizeId === dto.sizeId);
    if (!sizeRow) {
      throw new PassportSizeNotInOrderException();
    }
    const perLayerQty = sizeRow.perLayerQty;
    const rollByOrdinal = new Map(task.rolls.map((r) => [r.ordinal, r.layers]));

    // Раскройщик для начислений — тот, кто выполнил задачу. Валидируем
    // его так же, как явный `cutterId` (роль CUTTER + active).
    if (!task.assignedToId) {
      throw new CutterRequiredException();
    }
    const [creator, divisionOp, cutter] = await Promise.all([
      this.prisma.employee.findUnique({ where: { id: creatorEmployeeId } }),
      this.prisma.operation.findUnique({ where: { code: 'CUT_DIVISION' } }),
      this.resolveCutter(task.assignedToId, {
        id: '',
        role: Role.CUTTER_ASSISTANT,
        active: true,
      }),
    ]);
    if (!creator) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Сотрудник-инициатор не найден.',
      });
    }
    if (!divisionOp) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'OPERATION_NOT_FOUND',
        message:
          'В справочнике нет операции CUT_DIVISION. Восстановите её в /admin/operations или перезапустите API.',
      });
    }

    const product = orderItem.product;
    const color = normalizeColor(order.color ?? product.color);
    const initialRouteStepIndex = order.routeSteps.length > 0 ? 0 : null;

    // Уникализируем входные ordinal-ы, сохраняя порядок выбора.
    const requested = [...new Set(dto.rollOrdinals)];

    const result = await this.prisma.$transaction(async (tx) => {
      // Перечитываем уже выпущенные пары ВНУТРИ транзакции — защита от
      // гонки двух параллельных выпусков по тем же рулонам.
      const existing = await tx.passport.findMany({
        where: {
          orderId: order.id,
          sizeId: dto.sizeId,
          status: { not: PassportStatus.CANCELLED },
        },
        select: { qtyCut: true, rollOrdinal: true },
      });
      const releasedOrdinals = new Set<number>();
      let cutBySize = 0;
      for (const p of existing) {
        cutBySize += p.qtyCut;
        if (p.rollOrdinal != null) releasedOrdinals.add(p.rollOrdinal);
      }
      let remaining = orderItem.qtyPlan - cutBySize;

      const created: ReleaseFromRollsResultDto['created'] = [];
      const skipped: number[] = [];

      for (const ordinal of requested) {
        if (releasedOrdinals.has(ordinal)) {
          skipped.push(ordinal);
          continue;
        }
        const layers = rollByOrdinal.get(ordinal);
        if (layers === undefined) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'CUTTING_ROLL_NOT_FOUND',
            message: `Рулон №${ordinal} не относится к этой задаче раскроя.`,
          });
        }
        const qty = layers * perLayerQty;
        if (qty <= 0) {
          // Рулон без слоёв / размер не на настиле — выпускать нечего.
          skipped.push(ordinal);
          continue;
        }
        if (qty > remaining) {
          throw new PassportQtyExceedsRemainingException(Math.max(remaining, 0));
        }
        const lite = await this.createOnePassportInTx(tx, {
          orderId: order.id,
          productId: product.id,
          sizeId: dto.sizeId,
          color,
          rollNumber: `Рулон ${ordinal}`,
          rollOrdinal: ordinal,
          cutDate: new Date(dto.cutDate),
          qty,
          cutterId: cutter.id,
          creatorId: creator.id,
          divisionOpId: divisionOp.id,
          initialRouteStepIndex,
        });
        remaining -= qty;
        releasedOrdinals.add(ordinal);
        created.push({
          id: lite.id,
          number: lite.number,
          qtyCut: lite.qtyCut,
          rollNumber: lite.rollNumber,
          rollOrdinal: ordinal,
        });
      }

      return { created, skipped };
    });

    this.logger.log(
      `event=passport.release-from-rolls orderId=${order.id} sizeId=${dto.sizeId} created=${result.created.length} skipped=${result.skipped.length} creatorId=${creator.id} cutterId=${cutter.id}`,
    );
    return result;
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(
    id: string,
    options?: GetOneOptions,
  ): Promise<PassportDetailDto> {
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
    const routeHint = await this.buildRouteHint(row, options);
    return this.toDetailDto(row, routeHint);
  }

  // -------------------------------------------------------------------------
  // LIST MINE (страница «Выпущенные паспорта» помощника раскройщика,
  // см. `app/work/passports/page.tsx`).
  //
  // Контракт: возвращает свежие паспорта, которые выпустил сам actor
  // (`creatorId === employeeId`). Без пагинации (на /work показываем
  // последние 100 — этого достаточно для серийного выпуска MVP), с
  // полями `editable` / `editableBlockReason`, чтобы UI рисовал кнопки
  // «Редактировать»/«Удалить» как enabled только для пригодных
  // паспортов и не падал в backend-ошибку при попытке отредактировать
  // уже размещённый паспорт.
  // -------------------------------------------------------------------------

  /**
   * Список последних паспортов, выпущенных самим actor-ом.
   *
   * Используется страницей `/work/passports` для роли
   * `CUTTER_ASSISTANT` / `CUTTER`. Менеджеры/админ всё равно видят
   * чужие паспорта на admin-карточке заказа — отдельной страницы
   * списка для них нет.
   *
   * Поле `editable` отражает текущее состояние backend-инвариантов
   * (status = CREATED, currentCellId = null, нет PassportEvent кроме
   * CREATED). UI этим полем гасит кнопки на строках, которые
   * «двинулись», и показывает причину пользователю, а не глухую
   * 409-ку из PATCH/DELETE.
   */
  async listMineRecent(employeeId: string): Promise<MyPassportListItem[]> {
    const rows = await this.prisma.passport.findMany({
      where: { creatorId: employeeId },
      include: {
        size: true,
        product: { select: { id: true, name: true } },
        order: {
          select: { id: true, number: true },
        },
        currentCell: { select: { id: true, code: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (rows.length === 0) return [];

    // Один общий select по PassportEvent, чтобы понять для каждого
    // паспорта, есть ли события кроме CREATED. На MVP это самый
    // дешёвый способ — последовательные findFirst-ы давали бы N+1.
    const eventCounts = await this.prisma.passportEvent.groupBy({
      by: ['passportId'],
      where: {
        passportId: { in: rows.map((r) => r.id) },
        type: { not: PassportEventType.CREATED },
      },
      _count: { _all: true },
    });
    const hasOtherEvents = new Map(
      eventCounts.map((g) => [g.passportId, g._count._all > 0]),
    );

    return rows.map((r) => {
      const blocked = this.editableBlockReason(
        {
          status: r.status,
          currentCellId: r.currentCellId,
        },
        hasOtherEvents.get(r.id) ?? false,
      );
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        cutDate: r.cutDate.toISOString(),
        createdAt: r.createdAt.toISOString(),
        qtyCut: r.qtyCut,
        qtyPlan: r.qtyPlan,
        rollNumber: r.rollNumber,
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        orderId: r.order.id,
        orderNumber: r.order.number,
        productName: r.product?.name ?? null,
        currentCell: r.currentCell
          ? { id: r.currentCell.id, code: r.currentCell.code }
          : null,
        editable: blocked === null,
        editableBlockReason: blocked,
      };
    });
  }

  // -------------------------------------------------------------------------
  // HISTORY (PassportEvent timeline для экрана `/master` — кнопка
  // «Посмотреть историю паспорта» в `PassportActionsSheet`).
  // -------------------------------------------------------------------------

  /**
   * Хронологический список `PassportEvent` одного паспорта с
   * подтянутыми именами связных сущностей (operation, employee, cell,
   * fromOperation). Сортировка — `createdAt asc` (старые → новые),
   * чтобы мастер «прочитал историю сверху вниз». Возвращает пустой
   * массив, если паспорт не найден, — UI обычно открывает историю по
   * id из карточки уже найденного паспорта, но defensive-проверка
   * через `findUnique` ниже выкидывает 404, если id не существует.
   *
   * Поле `manual` помечает события с id-префиксом `man_` — мы
   * используем этот префикс для записей, созданных ручной правкой
   * админа (см. инциденты 12.05.2026 с догенерацией `OPERATION_FINISHED`
   * и `OperationEntry`). UI помечает такие строки «(ручная правка)»,
   * чтобы мастер не путал их с штатным flow.
   */
  async getHistory(passportId: string): Promise<PassportHistoryDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id: passportId },
      select: { id: true },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }
    const rows = await this.prisma.passportEvent.findMany({
      where: { passportId },
      orderBy: [
        { createdAt: 'asc' },
        // Tie-break по id — если несколько событий записаны в одну
        // миллисекунду (батч-инсёрт), сохраняем стабильный порядок
        // между запросами.
        { id: 'asc' },
      ],
      include: {
        operation: { select: { id: true, name: true } },
        fromOperation: { select: { id: true, name: true } },
        employee: { select: { id: true, fullName: true } },
        cell: { select: { id: true, code: true } },
      },
    });
    const events: PassportHistoryEventDto[] = rows.map((r) => {
      const type = r.type as PassportHistoryEventType;
      return {
        id: r.id,
        type,
        typeLabel: PASSPORT_EVENT_LABELS[type] ?? type,
        createdAt: r.createdAt.toISOString(),
        employee: r.employee
          ? { id: r.employee.id, fullName: r.employee.fullName }
          : null,
        operation: r.operation
          ? { id: r.operation.id, name: r.operation.name }
          : null,
        fromOperation: r.fromOperation
          ? { id: r.fromOperation.id, name: r.fromOperation.name }
          : null,
        cell: r.cell ? { id: r.cell.id, code: r.cell.code } : null,
        qty: r.qty,
        defectQty: r.defectQty,
        manual: r.id.startsWith('man_'),
      };
    });
    return { passportId, events };
  }

  // -------------------------------------------------------------------------
  // UPDATE (редактирование полей паспорта помощником/раскройщиком/менеджером,
  // см. `docs/domain.md §7.8a «Редактирование паспорта»`).
  // -------------------------------------------------------------------------

  /**
   * Редактирование полей паспорта, пока он ещё не «уехал» в
   * производство.
   *
   * RBAC enforce-ит контроллер; здесь дополнительно проверяем
   * «свой/не-свой» для не-менеджерских ролей и инварианты
   * редактируемости (status, ячейка, события).
   *
   * Что меняем (опционально, любая комбинация):
   *   - `sizeId` — должен быть в строках заказа; пересчитываем
   *     immediate-начисление раскройщика (новый sizeId → новая
   *     ставка по `OperationRateBySize`);
   *   - `cutDate`, `rollNumber` — простые update-ы, не трогают
   *     payroll;
   *   - `qtyCut` — должно влезать в остаток плана размера (с учётом
   *     уже выпущенных паспортов, исключая редактируемый); параллельно
   *     пересчитываем `qtyPlan` / `qtyGood` (на момент CREATED они
   *     равны `qtyCut`, см. `create()`) и immediate-начисление;
   *   - `cutterId` — новый раскройщик (active, role=CUTTER); сносим
   *     старое immediate-начисление и создаём новое уже на нового.
   *
   * Транзакция:
   *   1. Удаляем все `OperationEntry` этого паспорта с
   *      `sourceEventType = PASSPORT_CREATED` (immediate-cutter).
   *      Других `APPROVED` начислений на статусе CREATED не бывает —
   *      см. JSDoc у `delete()` и проверку `editable*` выше.
   *   2. Обновляем `Passport`.
   *   3. Обновляем CREATED `PassportEvent` (qty + payload) — это даёт
   *      честный аудит «помощник поправил qtyCut/rollNumber» без
   *      нового events-таймлайна.
   *   4. Перезапускаем `EarningsService.createImmediateForCutter` с
   *      новыми параметрами (qty/sizeId/cutterId).
   *   5. Audit log `PASSPORT_UPDATED` с before/after-снэпшотом.
   */
  async update(
    id: string,
    dto: UpdatePassportDto,
    actor: { employeeId: string; role: Role },
  ): Promise<PassportDetailDto> {
    const passport = await this.prisma.passport.findUnique({
      where: { id },
      include: {
        order: {
          include: { items: true },
        },
      },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }

    const isManager = actor.role === Role.SHOP_MANAGER || actor.role === Role.ADMIN;
    if (!isManager && passport.creatorId !== actor.employeeId) {
      throw new PassportNotYoursToEditException();
    }

    const otherEvent = await this.prisma.passportEvent.findFirst({
      where: { passportId: id, type: { not: PassportEventType.CREATED } },
      select: { id: true },
    });
    const blocked = this.editableBlockReason(
      { status: passport.status, currentCellId: passport.currentCellId },
      Boolean(otherEvent),
    );
    if (blocked !== null) {
      throw new PassportNotEditableException();
    }

    if (
      passport.order.status === OrderStatus.DONE ||
      passport.order.status === OrderStatus.CANCELLED ||
      passport.order.status !== OrderStatus.IN_PRODUCTION
    ) {
      throw new PassportOrderNotInProductionException();
    }

    const nextSizeId = dto.sizeId ?? passport.sizeId;
    const orderItem = passport.order.items.find((it) => it.sizeId === nextSizeId);
    if (!orderItem) {
      throw new PassportSizeNotInOrderException();
    }

    if (dto.sizeId && dto.sizeId !== passport.sizeId) {
      // Меняем размер — нужно проверить, что в новой строке нет
      // подтверждённой заявки на закрытие раскроя.
      const closed = await this.closure.hasApprovedClosure(
        passport.orderId,
        orderItem.productId,
        nextSizeId,
      );
      if (closed) throw new PassportCuttingClosedException();
    }

    const nextQty = dto.qtyCut ?? passport.qtyCut;
    if (nextQty !== passport.qtyCut || nextSizeId !== passport.sizeId) {
      // Проверяем remaining по размеру, исключая сам редактируемый
      // паспорт. На статусе CREATED CANCELLED-братьев у него нет, но
      // для корректности считаем как в create().
      const others = await this.prisma.passport.findMany({
        where: {
          orderId: passport.orderId,
          sizeId: nextSizeId,
          status: { not: PassportStatus.CANCELLED },
          NOT: { id: passport.id },
        },
        select: { qtyCut: true },
      });
      const cutByThisSize = others.reduce((s, p) => s + p.qtyCut, 0);
      const remaining = orderItem.qtyPlan - cutByThisSize;
      if (nextQty > remaining) {
        throw new PassportQtyExceedsRemainingException(Math.max(remaining, 0));
      }
    }

    // Резолвим раскройщика (active, role=CUTTER). Если поле не
    // прислали — оставляем прежнего. Прислали тот же id — тоже
    // дополнительно валидируем, чтобы UI не давал сохранять
    // деактивированную учётку.
    const nextCutterId = dto.cutterId ?? passport.cutterId;
    const nextCutter = await this.prisma.employee.findUnique({
      where: { id: nextCutterId },
      select: { id: true, role: true, active: true },
    });
    if (!nextCutter || nextCutter.role !== Role.CUTTER) {
      throw new CutterNotFoundException();
    }
    if (!nextCutter.active) {
      throw new CutterInactiveException();
    }

    const before = {
      sizeId: passport.sizeId,
      cutDate: passport.cutDate.toISOString(),
      qtyCut: passport.qtyCut,
      rollNumber: passport.rollNumber,
      cutterId: passport.cutterId,
    };
    const after = {
      sizeId: nextSizeId,
      cutDate: dto.cutDate ?? passport.cutDate.toISOString(),
      qtyCut: nextQty,
      rollNumber: dto.rollNumber ?? passport.rollNumber,
      cutterId: nextCutter.id,
    };

    await this.prisma.$transaction(async (tx) => {
      // 1. Снимаем immediate-начисления раскройщика (если были).
      //    На статусе CREATED других APPROVED-entries не бывает.
      await tx.operationEntry.deleteMany({
        where: { passportId: id, sourceEventType: 'PASSPORT_CREATED' },
      });

      // 2. Обновляем сам паспорт. На CREATED qtyPlan и qtyGood равны
      //    qtyCut (см. create()), поэтому при изменении qtyCut они
      //    тоже меняются — иначе ОТК-формула qtyGood = qtyCut - qtyDefect
      //    для нового количества развалилась бы.
      await tx.passport.update({
        where: { id },
        data: {
          sizeId: after.sizeId,
          cutDate: new Date(after.cutDate),
          qtyCut: after.qtyCut,
          qtyPlan: after.qtyCut,
          qtyGood: after.qtyCut,
          rollNumber: after.rollNumber,
          cutterId: after.cutterId,
          // Если меняется размер — нормализуем `color` под изделие
          // строки (в create() именно так и делается, см. снимок).
          // На MVP `Order.color` не зависит от размера, поэтому
          // фактически это no-op; оставлено для симметрии с create().
        },
      });

      // 3. Обновляем CREATED PassportEvent — историю не множим, но
      //    и снэпшот «что было выпущено» не сохраняем устаревшим.
      await tx.passportEvent.updateMany({
        where: { passportId: id, type: PassportEventType.CREATED },
        data: {
          qty: after.qtyCut,
          employeeId: passport.creatorId,
          payload: {
            rollNumber: after.rollNumber,
            color: passport.color,
            updatedByEmployeeId: actor.employeeId,
            updatedAt: new Date().toISOString(),
          },
        },
      });

      // 4. Пересоздаём immediate-начисление раскройщика. Контракт
      //    тот же, что в create() — тот же service, та же транзакция.
      await this.earnings.createImmediateForCutter(tx, {
        passportId: id,
        cutterId: after.cutterId,
        sizeId: after.sizeId,
        productId: orderItem.productId,
        qty: after.qtyCut,
      });

      // 5. Audit. Минимальный полезный набор — before/after по
      //    редактируемым полям + actor.
      await this.audit.log(
        {
          event: 'PASSPORT_UPDATED',
          entityType: 'PASSPORT',
          entityId: id,
          employeeId: actor.employeeId,
          payload: {
            number: passport.number,
            orderId: passport.orderId,
            before,
            after,
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=passport.update passportId=${id} actorId=${actor.employeeId} ` +
        `qtyCut=${after.qtyCut} sizeId=${after.sizeId} cutterId=${after.cutterId}`,
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // DELETE (управленческое удаление паспорта, см. `docs/domain.md §7.8`)
  // -------------------------------------------------------------------------

  /**
   * Удалить паспорт целиком — нужно, когда менеджер хочет откатить
   * ошибочный выпуск (неверный размер, рулон, кол-во). Операция
   * безопасна по построению: блокируется, как только данные паспорта
   * уже «уехали» в учёт:
   *
   *   - паспорт упакован в коробку (`BoxItem` есть) →
   *     `PASSPORT_HAS_BOX`. Сначала менеджер должен снять паспорт с
   *     коробки на упаковке;
   *   - есть подтверждённые сдельные начисления (`OperationEntry.status
   *     = APPROVED`) → `PASSPORT_HAS_APPROVED_EARNINGS`. Стирать уже
   *     начисленную сотрудникам зарплату нельзя;
   *   - привязан проведённый документ расхода материалов
   *     (`MaterialIssue.status = POSTED`) →
   *     `PASSPORT_HAS_POSTED_MATERIAL_ISSUE`. Удаление паспорта
   *     оставило бы документ-расход с ссылкой `passportId=null`, но
   *     стирать историю расхода материалов мы тоже не имеем права —
   *     лучше отказать явно.
   *
   * Если ни одного блокера нет, чистим всё, что висит на паспорте, в
   * одной транзакции:
   *   - `CellContent.quantity` декрементим на `passport.qtyCut`, если
   *     паспорт лежал в ячейке (`currentCellId != null`) — симметрично
   *     инкременту в `place`, иначе ячейка «помнит» лишний остаток;
   *   - `PassportEvent` (история событий, без `onDelete` каскада в схеме);
   *   - `OperationEntry` (только `PENDING_RELEASE` — `APPROVED` уже
   *     заблокирован выше);
   *   - `PassportDefect` (записи брака ОТК).
   *
   * `MaterialIssue.passportId` Prisma-схема обнуляет автоматически
   * (`onDelete: SetNull`), отдельной чистки не нужно.
   *
   * После успеха пишем `AuditLog` с минимальным набором полей,
   * необходимым для разбора инцидента (`number` / `orderId` /
   * `sizeId` / `qtyCut` / актор), и кидаем в обычный логгер сервиса.
   */
  async delete(
    id: string,
    deleterEmployeeId: string,
    actorRole?: Role,
  ): Promise<void> {
    const passport = await this.prisma.passport.findUnique({
      where: { id },
      select: {
        id: true,
        number: true,
        orderId: true,
        productId: true,
        sizeId: true,
        color: true,
        qtyCut: true,
        status: true,
        currentCellId: true,
        currentCell: { select: { warehouseId: true } },
        creatorId: true,
        boxItems: { select: { box: { select: { number: true } } }, take: 1 },
      },
    });
    if (!passport) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: 'Паспорт не найден',
      });
    }

    // Self-cancel ветка для не-менеджерских ролей: помощник раскройщика
    // / раскройщик может удалить ТОЛЬКО свой только что выпущенный
    // паспорт, и только пока паспорт ещё нетронут (status=CREATED, без
    // ячейки, без событий кроме CREATED). См. JSDoc у класса.
    const isManager =
      actorRole === Role.SHOP_MANAGER || actorRole === Role.ADMIN;
    if (!isManager && actorRole) {
      if (passport.creatorId !== deleterEmployeeId) {
        throw new PassportNotYoursToEditException();
      }
      const otherEvent = await this.prisma.passportEvent.findFirst({
        where: { passportId: id, type: { not: PassportEventType.CREATED } },
        select: { id: true },
      });
      const blocked = this.editableBlockReason(
        { status: passport.status, currentCellId: passport.currentCellId },
        Boolean(otherEvent),
      );
      if (blocked !== null) {
        throw new PassportNotEditableException();
      }
    }

    const packedInto = passport.boxItems[0]?.box?.number;
    if (packedInto) {
      throw new PassportPackedDeleteException(packedInto);
    }

    // Для self-cancel APPROVED-блокер не нужен: на статусе CREATED +
    // нет cell + нет других событий APPROVED-entries бывают только
    // immediate-cutter (`sourceEventType = PASSPORT_CREATED`), и их
    // мы каскадно сносим — это корректно: «работы по выпуску не
    // случилось», начислять не за что. Для менеджерского delete
    // оставляем строгий блокер: paint-by-numbers с уже подтверждённой
    // зарплатой швеи стирать нельзя.
    if (isManager) {
      const approvedEntry = await this.prisma.operationEntry.findFirst({
        where: { passportId: id, status: 'APPROVED' },
        select: { id: true },
      });
      if (approvedEntry) {
        throw new PassportHasApprovedEarningsException();
      }
    }

    const postedIssue = await this.prisma.materialIssue.findFirst({
      where: { passportId: id, status: 'POSTED' },
      select: { id: true },
    });
    if (postedIssue) {
      throw new PassportHasPostedMaterialIssueException();
    }

    await this.prisma.$transaction(async (tx) => {
      if (passport.currentCellId) {
        // Foundation полуфабриката: DELETE-движение по крою откатывает
        // PLACE/RETURN-движения этого паспорта. Идемпотентно по
        // `WIP_DELETE:<passportId>` (паспорт удаляется, ключ остаётся
        // уникальным навсегда). См. `WorkInProgressService.recordDeleteInTx`.
        await this.workInProgress.recordDeleteInTx(tx, {
          passport: {
            id: passport.id,
            orderId: passport.orderId,
            productId: passport.productId,
            sizeId: passport.sizeId,
            color: passport.color,
            qtyCut: passport.qtyCut,
          },
          fromCell: {
            id: passport.currentCellId,
            warehouseId: passport.currentCell?.warehouseId ?? null,
          },
          employeeId: deleterEmployeeId,
        });
      }
      await tx.passportDefect.deleteMany({ where: { passportId: id } });
      await tx.operationEntry.deleteMany({ where: { passportId: id } });
      await tx.passportEvent.deleteMany({ where: { passportId: id } });
      await tx.passport.delete({ where: { id } });
      await this.audit.log(
        {
          event: 'PASSPORT_DELETED',
          entityType: 'PASSPORT',
          entityId: id,
          employeeId: deleterEmployeeId,
          payload: {
            number: passport.number,
            orderId: passport.orderId,
            sizeId: passport.sizeId,
            qtyCut: passport.qtyCut,
            cellId: passport.currentCellId,
            actorRole: actorRole ?? null,
          },
        },
        tx,
      );
    });
    this.logger.log(
      `event=passport.delete passportId=${id} number=${passport.number} orderId=${passport.orderId} qtyCut=${passport.qtyCut} deleterId=${deleterEmployeeId} actorRole=${actorRole ?? '-'}`,
    );
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
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentCellId: cell.id,
          // После размещения паспорт «отвязывается» от создателя
          // (раскройщика): он лежит в ячейке и доступен любому, кто
          // делает `issue`. Без этого `currentEmployeeId` оставался бы
          // на cutter-е, и баннер `getActiveBannerForOperation` (фильтр
          // `currentEmployeeId: null`) не показывал бы ячейки в
          // подсказке швее.
          currentEmployeeId: null,
        },
      });
      const placedEvent = await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.CELL_PLACED,
          cellId: cell.id,
          qty: passport.qtyCut,
        },
      });
      // Foundation полуфабриката: PLACE-движение по крою — единственный
      // источник истины «что лежит в ячейке». Идемпотентно по
      // `WIP_PLACE:<eventId>`. См. `WorkInProgressService.recordPlaceInTx`.
      await this.workInProgress.recordPlaceInTx(tx, {
        passport: {
          id: passport.id,
          orderId: passport.orderId,
          productId: passport.productId,
          sizeId: passport.sizeId,
          color: passport.color,
          qtyCut: passport.qtyCut,
        },
        cell: { id: cell.id, warehouseId: cell.warehouseId },
        eventId: placedEvent.id,
        employeeId: null,
      });
      // Audit (см. `docs/domain.md §«Audit log»`): фиксируем ровно
      // тот срез, который полезен для разбора инцидента — на какую
      // ячейку поставили и сколько штук физически легло. `employeeId`
      // на endpoint `/place` явно не приходит (это операция
      // помощника раскройщика, выполняется без активной смены), —
      // оставляем `null`, чтобы не угадывать актора.
      await this.audit.log(
        {
          event: 'PASSPORT_PLACED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          payload: {
            cellId: cell.id,
            cellCode: cell.code,
            sizeId: passport.sizeId,
            qty: passport.qtyCut,
          },
        },
        tx,
      );
    });

    const [detail, cellDetail] = await Promise.all([
      this.getOne(id),
      this.getCell(cell.id),
    ]);
    return { passport: detail, cell: cellDetail };
  }

  /**
   * Порядок маршрута с учётом ПАРАЛЛЕЛЬНЫХ (взаимозаменяемых) групп
   * (`OrderRouteStep.parallelGroup`). Используется в `issueToEmployee` /
   * `scanOnOperation` / `completeOperationByEmployee` вместо «сырого»
   * сравнения `index < currentRouteStepIndex`.
   *
   * Возвращает:
   *   - `targetIndex` — индекс целевой операции в маршруте (`null`, если
   *     операции нет в маршруте → enforcement не применяется, как раньше);
   *   - `backward` — целевой шаг идёт РАНЬШЕ текущего по «свёрнутому»
   *     рангу: операции одной параллельной группы делят общий ранг
   *     (= минимальный index группы), поэтому взять КИПЕРКУ после
   *     РАСПОШИВА (одна группа) — НЕ «назад»;
   *   - `groupIncomplete` — целевой шаг стоит ПОСЛЕ некой параллельной
   *     группы, в которой завершены ещё НЕ все операции (AND-гейт: на
   *     ОТК нельзя, пока не сделаны и КИПЕРКА, и РАСПОШИВ).
   *
   * Без параллельных групп (`parallelGroup` везде `null`) поведение
   * идентично прежнему: ранг = index, `groupIncomplete` всегда `false`.
   */
  private async evaluateRouteOrder(
    passport: {
      id: string;
      orderId: string | null;
      currentRouteStepIndex: number | null;
    },
    targetOperationId: string,
  ): Promise<{
    targetIndex: number | null;
    backward: boolean;
    groupIncomplete: boolean;
  }> {
    const none = { targetIndex: null, backward: false, groupIncomplete: false };
    if (!passport.orderId) return none;
    const steps = await this.prisma.orderRouteStep.findMany({
      where: { orderId: passport.orderId },
      select: { index: true, operationId: true, parallelGroup: true },
    });
    if (steps.length === 0) return none;

    const groupMin = new Map<number, number>();
    const groupMax = new Map<number, number>();
    const groupOps = new Map<number, string[]>();
    for (const s of steps) {
      if (s.parallelGroup == null) continue;
      groupMin.set(
        s.parallelGroup,
        Math.min(groupMin.get(s.parallelGroup) ?? s.index, s.index),
      );
      groupMax.set(
        s.parallelGroup,
        Math.max(groupMax.get(s.parallelGroup) ?? s.index, s.index),
      );
      const arr = groupOps.get(s.parallelGroup) ?? [];
      arr.push(s.operationId);
      groupOps.set(s.parallelGroup, arr);
    }
    // Групп-репрезентативный ранг шага (свёртка параллельной группы).
    const rep = (index: number, group: number | null): number =>
      group != null ? groupMin.get(group) ?? index : index;

    // Substitution-aware резолв целевого шага. Прямой случай — операция
    // стоит в снимке маршрута. Иначе она может быть ЗАМЕСТИТЕЛЕМ (полный
    // распошив 04), которого в сплит-снимке нет, но он закрывает операции
    // группы (низ 0001 + рукав 16). Тогда позиционируем паспорт по этим
    // закрываемым шагам — это нужно после отказа от необратимого
    // сворачивания маршрута (Вариант B, см. route-mode.ts): снимок всегда
    // сплит, а швея физически закрывает один 04.
    let targetStep = steps.find((s) => s.operationId === targetOperationId);
    if (!targetStep) {
      const subs = await this.prisma.operationSubstitution.findMany({
        where: { substituteOpId: targetOperationId },
        select: { satisfiesOpId: true },
      });
      const satisfies = new Set(subs.map((s) => s.satisfiesOpId));
      const merged = steps.filter((s) => satisfies.has(s.operationId));
      if (merged.length === 0) return none; // не в маршруте и не заместитель
      // Виртуальный целевой шаг = самый поздний из закрываемых (паспорт
      // прошёл весь распошив целиком). Параллельная группа — их общая.
      targetStep = merged.reduce((a, b) => (b.index > a.index ? b : a));
    }
    const targetIndex = targetStep.index;
    const targetRep = rep(targetIndex, targetStep.parallelGroup);

    let backward = false;
    if (passport.currentRouteStepIndex !== null) {
      const curStep = steps.find(
        (s) => s.index === passport.currentRouteStepIndex,
      );
      if (curStep) {
        backward = targetRep < rep(curStep.index, curStep.parallelGroup);
      }
    }

    // AND-гейт: параллельные группы, целиком стоящие ДО target, должны
    // быть завершены полностью. Запрос завершённых операций — только если
    // такие группы есть (в обычном маршруте без групп — пропускаем).
    //
    // Substitute-правила (см. `OperationSubstitution`): если есть запись
    // `(satisfiesOpId = X, substituteOpId = Y)`, то `OPERATION_FINISHED`
    // на Y засчитывает закрытие X. Например, РАСПОШИВ (04) — заместитель
    // Подгиб низа (0001) и Распошив рукав (16): когда станок «Подгиб
    // низа» сломан, швея закрывает 04, и это считается эквивалентом
    // пары. См. `prisma/migrations/20260729200000_add_operation_substitution`.
    let groupIncomplete = false;
    const groupsBefore: number[] = [];
    for (const [g, gMax] of groupMax) {
      if (gMax < targetIndex) groupsBefore.push(g);
    }
    if (groupsBefore.length > 0) {
      const [finished, substitutes] = await Promise.all([
        this.prisma.passportEvent.findMany({
          where: {
            passportId: passport.id,
            type: PassportEventType.OPERATION_FINISHED,
            operationId: { not: null },
          },
          select: { operationId: true },
        }),
        // Только substitutes для операций, реально стоящих в проверяемых
        // группах — иначе тянули бы весь справочник.
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
          groupIncomplete = true;
          break;
        }
      }
    }

    return { targetIndex, backward, groupIncomplete };
  }

  /**
   * Авто-определение операции, которую швея фактически берёт/завершает по
   * этому паспорту.
   *
   * По умолчанию это операция её активной смены (`session.operationId`) —
   * исторически и `issueToEmployee`, и `completeOperationByEmployee`
   * писали события строго по смене («взять крой = встать на операцию
   * смены»). Но если ОТК вернул паспорт на переделку
   * (`OPERATION_REWORK_OPENED`), целевая операция задаётся самим
   * паспортом, а не сменой: распошивщица могла уже переключиться на
   * другую распошив-операцию (напр. «РАСПОШИВ» 04), и заставлять её
   * вручную менять смену ради закрытия rework по «Распошив рукав» (16) —
   * лишний шаг, из-за которого паспорт «висит» в «К переделке» (инцидент
   * 02.06.2026).
   *
   * Поэтому: если у паспорта есть открытый rework и его операция
   * **разрешена на оборудовании текущей смены** (allow-list
   * `EquipmentOperation`) — возвращаем операцию переделки. Это не трогает
   * `ShiftSession.operationId` (общий для всех паспортов на руках), а
   * атрибутирует операцию **по-паспортно** — поэтому многозадачность
   * (обычный крой + переделка на разных операциях) и пакетное завершение
   * не запишут `OPERATION_FINISHED` на чужую операцию.
   *
   * Если операция переделки на оборудовании смены НЕ разрешена —
   * `PassportReworkOperationNotAllowedForShiftException` с именем нужной
   * операции (молча закрыть rework на «не той» операции нельзя). Когда
   * смена уже стоит на нужной операции или открытых reworks нет —
   * поведение прежнее (возвращаем `session.operationId`).
   */
  private async resolveOperationForPassport(
    passport: { id: string; orderId: string | null },
    session: { operationId: string; equipmentId: string },
  ): Promise<string> {
    // Все REWORK_OPENED по паспорту (свежие сверху). Дедупим по операции
    // и оставляем только «открытые» — без последующего OPERATION_FINISHED
    // для той же пары (passport, operation). Зеркалит логику
    // `ShiftsService.getMyReworkPassports` и `assertOperationNotFinished`.
    const reworks = await this.prisma.passportEvent.findMany({
      where: {
        passportId: passport.id,
        type: PassportEventType.OPERATION_REWORK_OPENED,
        operationId: { not: null },
      },
      select: { operationId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    if (reworks.length === 0) return session.operationId;

    const seen = new Set<string>();
    const openOps: string[] = [];
    for (const r of reworks) {
      const op = r.operationId;
      if (!op || seen.has(op)) continue;
      seen.add(op);
      const finished = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: passport.id,
          operationId: op,
          type: PassportEventType.OPERATION_FINISHED,
          createdAt: { gt: r.createdAt },
        },
        select: { id: true },
      });
      if (!finished) openOps.push(op);
    }
    if (openOps.length === 0) return session.operationId;

    // Смена уже на нужной операции переделки — ничего не меняем
    // (полностью прежнее поведение).
    if (openOps.includes(session.operationId)) return session.operationId;

    // Несколько открытых reworks — берём маршрут-раннюю операцию (логично
    // переделывать по порядку маршрута), иначе первую попавшуюся.
    let targetOp = openOps[0];
    if (passport.orderId && openOps.length > 1) {
      const steps = await this.prisma.orderRouteStep.findMany({
        where: { orderId: passport.orderId, operationId: { in: openOps } },
        select: { operationId: true },
        orderBy: { index: 'asc' },
      });
      if (steps[0]) targetOp = steps[0].operationId;
    }

    // Операция переделки обязана быть в allow-list оборудования смены —
    // иначе понятная ошибка (см. JSDoc выше).
    const allowed = await this.prisma.equipmentOperation.findFirst({
      where: {
        equipmentId: session.equipmentId,
        operationId: targetOp,
        isActive: true,
      },
      select: { id: true },
    });
    if (!allowed) {
      const op = await this.prisma.operation.findUnique({
        where: { id: targetOp },
        select: { name: true },
      });
      throw new PassportReworkOperationNotAllowedForShiftException(
        op?.name ?? targetOp,
      );
    }
    return targetOp;
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
   *   - переводим паспорт НА операцию смены (`currentOperationId =
   *     session.operationId`, `currentRouteStepIndex = шаг маршрута`);
   *   - пишем событие `ISSUED_TO_EMPLOYEE` (operationId = session.operationId).
   *
   * **Взять крой = встать на операцию.** «Деление кроя» (CUT_DIVISION) —
   * операция кроильного цеха; швея берёт уже разделённый, готовый крой и
   * сразу начинает свою ПЕРВУЮ швейную операцию (ОВР). Поэтому
   * `issueToEmployee` переводит паспорт на `session.operationId` ровно
   * как `scanOnOperation` — иначе паспорт всё время работы числился бы на
   * CUT_DIVISION (исчезал с доски / в кабинете висел не на той операции).
   * Раньше это было разделено (issue только закрепляет, scan двигает), но
   * реальный флоу `OPERATION_SCAN` не пишет (см.
   * project_no_operation_scan_events), и паспорт «зависал» на кройке до
   * самого `OPERATION_FINISHED`.
   *
   * **Route-WIP исключение (soft-route MVP, см. `docs/domain.md §18`,
   * `docs/flows.md §F3a`).** Если у заказа есть snapshot маршрута и
   * паспорт уже вошёл в маршрутный поток (`currentRouteStepIndex !==
   * null` — ставится при создании паспорта, если у заказа есть
   * `OrderRouteStep[]`), то размещение в ячейке между маршрутными
   * шагами **не обязательно**: следующий исполнитель может «получить
   * крой» прямо из руки предыдущего сотрудника / помощника
   * раскройщика (выпустившего паспорт после CUT_DIVISION). В этом
   * случае мы:
   *   - не кидаем `PASSPORT_NOT_IN_CELL`;
   *   - не кидаем `PASSPORT_ALREADY_ISSUED` за «висящего creator»
   *     (status=CREATED) и за «свободного» паспорта после
   *     `complete-operation` (currentEmployeeId=null);
   *   - не трогаем `CellContent` (нечего вычитать);
   *   - идемпотентны для того же сотрудника на IN_PROGRESS.
   * Для немаршрутных заказов и для маршрутных, у которых паспорт
   * лежит в ячейке как буфер, поведение остаётся прежним (legacy).
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
    // Подтягиваем `operation.category` — нужно для Stage 3 «Мастер цеха»
    // (политика выдачи кроя проверяется только на ПЕРВОЙ операции
    // маршрута или операциях категории `CUTTING`).
    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      include: { operation: { select: { category: true } } },
    });
    if (!session) throw new ShiftSessionRequiredException();

    // Операция, на которую встаёт паспорт: по умолчанию — операция смены,
    // но для возвращённого ОТК паспорта берётся операция его переделки
    // (см. `resolveOperationForPassport`). Так распошивщица «принимает»
    // возврат по «Распошив рукав», стоя на смене «РАСПОШИВ», без ручного
    // переключения смены; обычный поток не меняется.
    const targetOperationId = await this.resolveOperationForPassport(
      { id: passport.id, orderId: passport.orderId },
      session,
    );

    // Если операция, на которую встаёт паспорт, уже завершалась по нему —
    // запрещаем повторную выдачу. Без этого scan на уже закрытой
    // операции создаёт второй `ISSUED_TO_EMPLOYEE` и паспорт начинает
    // «висеть» у швеи без OPERATION_FINISHED (см. инцидент 09.05.2026,
    // 60+ дубль-выдач у трёх швей).
    await this.assertOperationNotFinished(passport.id, targetOperationId);

    // Запрещаем «получить крой» на операции, идущей в маршруте раньше
    // уже зафиксированного шага паспорта. Симметрично
    // `PASSPORT_SCAN_BACKWARD` в `scanOnOperation`: без этого
    // issue-канал становился лазейкой — швея могла «вернуть» паспорт
    // на прошлый шаг через issue (issue не двигает
    // `currentRouteStepIndex`), а последующий complete уже падал с
    // `PASSPORT_COMPLETE_BACKWARD`, и паспорт «висел» у неё в работе
    // (инцидент 13.05.2026, 5 паспортов на КИПЕРКЕ после РАСПОШИВ).
    // Откат назад остаётся прерогативой мастера через `set-route-step`.
    // Порядок маршрута с учётом параллельных групп (см. evaluateRouteOrder):
    //   - backward → нельзя «получить крой» раньше текущего ранга (внутри
    //     одной параллельной группы — можно, это не «назад»);
    //   - groupIncomplete → нельзя выйти на операцию после параллельной
    //     группы, пока не завершены все её операции (ОТК ждёт обе из
    //     {КИПЕРКА, РАСПОШИВ}).
    const issueOrder = await this.evaluateRouteOrder(
      passport,
      targetOperationId,
    );
    if (issueOrder.backward) throw new PassportIssueBackwardException();
    if (issueOrder.groupIncomplete) {
      throw new PassportParallelGroupIncompleteException();
    }
    const issueTargetIndex = issueOrder.targetIndex;

    // QC-gate для входа на ВТО — зеркало `scanOnOperation` (см.
    // docs/flows.md §F6 / ADR-0013). Раз issue теперь переводит паспорт
    // НА операцию смены, «получить крой» прямо на ВТО (категория
    // `IRONING`) без хотя бы одного `QC_PASSED` запрещаем — иначе
    // issue-канал обходил бы ОТК так же, как раньше мог scan. Пропускаем,
    // если паспорт уже на этой операции (идемпотентный re-issue).
    if (
      session.operation.category === OperationCategory.IRONING &&
      passport.currentOperationId !== session.operationId
    ) {
      // QC_PASSED после последнего `OPERATION_REWORK_OPENED`. После rework
      // паспорт должен снова пройти ОТК, прежде чем попасть на ВТО.
      const lastRework = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: passport.id,
          type: PassportEventType.OPERATION_REWORK_OPENED,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const qcPassed = await this.prisma.passportEvent.findFirst({
        where: {
          passportId: passport.id,
          type: PassportEventType.QC_PASSED,
          ...(lastRework ? { createdAt: { gt: lastRework.createdAt } } : {}),
        },
        select: { id: true },
      });
      if (!qcPassed) throw new PassportNotQcPassedException();
    }

    // «Очередь выдачи кроя по размерам» — pre-check ДО глобальной
    // `CutReleasePolicy`. Семантика та же, что у Stage 3: проверка
    // действует только на ПЕРВОЙ операции маршрута / категории
    // `CUTTING`. Если правило применимо и паспорт «не очередного»
    // размера (или штук больше остатка) — здесь же кидаем
    // `OrderCutIssueRuleViolationException` (HTTP 409), не открывая
    // транзакцию. См. `OrderCutIssueRulesService.evaluateForIssue`,
    // `docs/domain.md §«Очередь выдачи кроя»`,
    // `docs/production-flow.md §«Issue: очередь выдачи кроя»`.
    const cutIssueRuleEnforcement =
      await this.orderCutIssueRules.evaluateForIssue(
        {
          orderId: passport.orderId,
          sizeId: passport.sizeId,
          qtyCut: passport.qtyCut,
          currentRouteStepIndex: passport.currentRouteStepIndex,
        },
        session.operation.category,
      );

    // Stage 3 «Мастер цеха» — политика выдачи кроя. Сравниваем
    // снимок паспорта с активной политикой ДО открытия транзакции,
    // чтобы при reject не плодить пустые audit-записи. Сама конкуренция
    // по `consumedQty` защищается conditional `updateMany` ниже,
    // внутри транзакции выдачи. Подробнее — в
    // `apps/api/src/modules/cut-release-policy/cut-release-policy.service.ts`.
    const policyEnforcement = await this.evaluateCutReleasePolicyForIssue(
      passport,
      session.operation.category,
    );

    // Hardening-флаг автосписания (см.
    // `prisma/schema.prisma::CompanySettings.autoIssueMaterialsOnCutRelease`,
    // `prisma/schema.prisma::CompanyDivision.autoIssueMaterialsOnCutReleaseOverride`,
    // `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrder`,
    // `docs/current-state.md §«Материалы и склад — division overrides»`).
    //
    // Effective policy читается ДО открытия транзакции — resolver
    // делает только SELECT-ы (`Order`, `CompanySettings`,
    // `CompanyDivision`) и не пишет singleton-row. Порядок:
    //   division.autoIssueMaterialsOnCutReleaseOverride
    //     ?? companySettings.autoIssueMaterialsOnCutRelease
    //     ?? false
    // Таким образом подразделение B2B может включить автосписание,
    // даже если глобальный флаг выключен, и наоборот — в «OTHER»
    // выключить при глобально включённом.
    const effectivePolicy =
      await this.companySettings.getEffectiveMaterialStockSettingsForOrder(
        passport.orderId,
      );
    const autoIssueEnabled = effectivePolicy.autoIssueMaterialsOnCutRelease;

    // Soft-route MVP: «паспорт в маршрутном потоке» = у заказа есть
    // snapshot `OrderRouteStep[]` (а значит и `currentRouteStepIndex`
    // был проставлен при `Passport.create()`). Это самый дешёвый и
    // устойчивый признак: дополнительной колонки/таблицы не нужно,
    // ровно один select по уже загруженным полям паспорта.
    const isRouteWip = passport.currentRouteStepIndex !== null;

    if (passport.currentCellId) {
      // Буферная ветка: паспорт лежит в ячейке (с маршрутом или без).
      // Списываем из WIP в одной транзакции с обновлением паспорта.
      await this.prisma.$transaction(async (tx) => {
        await tx.passport.update({
          where: { id: passport.id },
          data: {
            currentCellId: null,
            currentEmployeeId: employeeId,
            // Взять крой = встать на операцию паспорта (= операция смены,
            // либо операция переделки для возврата ОТК; зеркало scan).
            currentOperationId: targetOperationId,
            currentRouteStepIndex:
              issueTargetIndex ?? passport.currentRouteStepIndex,
            status: PassportStatus.IN_PROGRESS,
          },
        });
        const issuedEvent = await tx.passportEvent.create({
          data: {
            passportId: passport.id,
            type: PassportEventType.ISSUED_TO_EMPLOYEE,
            cellId: passport.currentCellId,
            operationId: targetOperationId,
            employeeId,
            equipmentId: session.equipmentId,
            qty: passport.qtyCut,
          },
        });
        // Foundation полуфабриката: ISSUE-движение по крою —
        // единственная точка списания остатка из ячейки. Идемпотентно
        // по `WIP_ISSUE:<eventId>`. См. `WorkInProgressService.recordIssueInTx`.
        await this.workInProgress.recordIssueInTx(tx, {
          passport: {
            id: passport.id,
            orderId: passport.orderId,
            productId: passport.productId,
            sizeId: passport.sizeId,
            color: passport.color,
            qtyCut: passport.qtyCut,
          },
          fromCell: {
            id: passport.currentCellId!,
            warehouseId: passport.currentCell?.warehouseId ?? null,
          },
          eventId: issuedEvent.id,
          employeeId,
        });
        // Audit (см. `docs/domain.md §«Audit log»`): legacy/буферная
        // ветка — фиксируем источник (ячейка) и операцию, на которой
        // швея «получила крой». `mode = FROM_CELL` — простой
        // дискриминатор для будущей фильтрации по типу выдачи.
        await this.audit.log(
          {
            event: 'PASSPORT_ISSUED',
            entityType: 'PASSPORT',
            entityId: passport.id,
            employeeId,
            payload: {
              mode: 'FROM_CELL',
              fromCellId: passport.currentCellId,
              operationId: targetOperationId,
              qty: passport.qtyCut,
            },
          },
          tx,
        );
        await this.orderCutIssueRules.consumeInTx(
          tx,
          cutIssueRuleEnforcement,
          {
            passportId: passport.id,
            orderId: passport.orderId,
            employeeId,
            qty: passport.qtyCut,
          },
        );
        await this.consumeCutReleasePolicyInTx(tx, policyEnforcement, {
          passportId: passport.id,
          employeeId,
          qty: passport.qtyCut,
          mode: 'FROM_CELL',
        });
        // Автосписание материалов при выдаче кроя (см.
        // `apps/api/src/modules/material-issues/material-issues.service.ts::createAutoCutIssueForPassport`,
        // `docs/current-state.md §«Auto cut issue»`).
        //
        // Включается hardening-флагом
        // `CompanySettings.autoIssueMaterialsOnCutRelease`
        // (default `false` — после миграции автосписание не
        // включается само). Если флаг выключен, helper НЕ
        // вызывается — выдача кроя продолжает работать штатно
        // (события, статус, currentEmployee, политика лимитов
        // сохраняются как раньше).
        //
        // Если флаг включен — идёт В ТОЙ ЖЕ транзакции: если
        // создание документа упадёт (constraint / relation),
        // выдача кроя откатится целиком — инвариант «либо и
        // выдача, и расход, либо ничего». Идемпотентность
        // обеспечивается UNIQUE `MaterialIssue.sourceKey` —
        // retry того же passport-а не создаёт дубля. Мягкие
        // отсутствия (нет WorkshopNeed, totalOrderQty <= 0,
        // unit-price отсутствует — см. `AutoCutIssueSkipReason`)
        // НЕ блокируют issueToEmployee: сервис вернёт
        // `{ skipped: true }`, и мы продолжим.
        if (autoIssueEnabled) {
          await this.materialIssues.createAutoCutIssueForPassport(
            tx,
            passport.id,
            employeeId,
          );
        }
      });

      this.logger.log(
        `event=passport.issue passportId=${passportId} employeeId=${employeeId} operationId=${targetOperationId} autoIssue=${autoIssueEnabled}`,
      );
      return this.getOne(passportId);
    }

    // currentCellId === null. Без маршрута — старое поведение: ячейка
    // обязательна, поэтому либо «уже выдан», либо «не на ячейке».
    if (!isRouteWip) {
      if (passport.currentEmployeeId) {
        throw new PassportAlreadyIssuedException();
      }
      throw new PassportNotInCellException();
    }

    // Route-WIP без ячейки: разрешаем «получить крой» прямо в маршруте.
    // Идемпотентность: тот же сотрудник на IN_PROGRESS — no-op
    // (точно так же ведёт себя `scan`, см. ADR-0003 §6).
    if (
      passport.status === PassportStatus.IN_PROGRESS &&
      passport.currentEmployeeId === employeeId
    ) {
      return this.getOne(passportId);
    }
    // Реальный конфликт: паспорт уже у другого исполнителя в работе.
    // Только этот случай оставляем как `PASSPORT_ALREADY_ISSUED` —
    // creator (status=CREATED) и пустой owner после complete-operation
    // не блокируем, иначе маршрутный поток после CUT_DIVISION /
    // между sewing-шагами не пойдёт.
    if (
      passport.status === PassportStatus.IN_PROGRESS &&
      passport.currentEmployeeId &&
      passport.currentEmployeeId !== employeeId
    ) {
      throw new PassportAlreadyIssuedException();
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentEmployeeId: employeeId,
          // Взять крой = встать на операцию паспорта (= операция смены,
          // либо операция переделки для возврата ОТК; зеркало scan).
          currentOperationId: targetOperationId,
          currentRouteStepIndex:
            issueTargetIndex ?? passport.currentRouteStepIndex,
          status: PassportStatus.IN_PROGRESS,
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.ISSUED_TO_EMPLOYEE,
          // cellId = null — у route-WIP паспорта ячейки нет.
          operationId: targetOperationId,
          employeeId,
          equipmentId: session.equipmentId,
          qty: passport.qtyCut,
        },
      });
      // Audit: route-WIP ветка («получили крой» прямо в маршруте,
      // без ячейки). `mode = ROUTE_WIP` отличает от `FROM_CELL` —
      // полезно для отчётности «сколько паспортов прошло через
      // прямую передачу из рук в руки».
      await this.audit.log(
        {
          event: 'PASSPORT_ISSUED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId,
          payload: {
            mode: 'ROUTE_WIP',
            operationId: targetOperationId,
            qty: passport.qtyCut,
          },
        },
        tx,
      );
      await this.orderCutIssueRules.consumeInTx(
        tx,
        cutIssueRuleEnforcement,
        {
          passportId: passport.id,
          orderId: passport.orderId,
          employeeId,
          qty: passport.qtyCut,
        },
      );
      await this.consumeCutReleasePolicyInTx(tx, policyEnforcement, {
        passportId: passport.id,
        employeeId,
        qty: passport.qtyCut,
        mode: 'ROUTE_WIP',
      });
      // Автосписание материалов — тот же контракт, что в
      // FROM_CELL ветке. Включается hardening-флагом
      // `CompanySettings.autoIssueMaterialsOnCutRelease`
      // (default `false`). Если выключен — helper не зовём,
      // route-WIP issue продолжает работать штатно. Если
      // включен — пишется в той же транзакции; retry идемпотентен
      // по UNIQUE `MaterialIssue.sourceKey`.
      if (autoIssueEnabled) {
        await this.materialIssues.createAutoCutIssueForPassport(
          tx,
          passport.id,
          employeeId,
        );
      }
    });

    this.logger.log(
      `event=passport.issue.routed passportId=${passportId} employeeId=${employeeId} operationId=${targetOperationId} autoIssue=${autoIssueEnabled}`,
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

    // Защита от race-condition «rework — ещё один scan на ОТК».
    // Если у паспорта есть открытый `OPERATION_REWORK_OPENED` НА ДРУГОЙ
    // операции (типично — швея переделывает после ОТК-возврата), повторный
    // scan категорией QC сдвинул бы `currentRouteStepIndex` обратно на
    // QC-шаг, и швея бы упёрлась в `PASSPORT_ISSUE_BACKWARD` при «Взять
    // крой» (инцидент 26.05.2026 на P-20260506-0069). ОТК должна
    // дождаться, пока швея переделает и снова отдаст паспорт на ОТК.
    //
    // Исключение — rework НА САМОЙ ОТК-операции: это сценарий «мастер
    // вернул паспорт на повторную проверку через set-route-step backward»
    // (см. `MasterActionsService.setRouteStep`, ветка
    // `reopenFinishedTarget`). Тут ОТК наоборот ОБЯЗАН сканировать —
    // паспорт стоит у него и ждёт re-check; гейт rework по своей же
    // операции игнорируем. См. `docs/flows.md §F5a`.
    if (session.operation.category === OperationCategory.QC) {
      const reworkPending = await this.hasOpenRework(
        passportId,
        session.operationId,
      );
      if (reworkPending) throw new PassportReworkPendingException();
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

    // Признак выпуска готовой продукции на завершённой операции (см.
    // `prisma/schema.prisma::Operation.producesFinishedGoods`,
    // `FinishedGoodsService.recordPassportOutputInTx`). Прохождение
    // операции с `producesFinishedGoods = true` фиксирует
    // `FinishedGoodsMovement PRODUCTION_RECEIPT IN`. Идемпотентно по
    // `sourceKey = PACKED_PASSPORT:<passportId>` — последующая упаковка
    // через `PackingService` не задвоит движение.
    const previousOperationProducesFinishedGoods = previousOperationId
      ? Boolean(
          (
            await this.prisma.operation.findUnique({
              where: { id: previousOperationId },
              select: { producesFinishedGoods: true },
            })
          )?.producesFinishedGoods,
        )
      : false;

    // Порядок маршрута с учётом параллельных групп (см.
    // `evaluateRouteOrder`). Запрещаем «брать» операцию раньше текущего
    // ранга (внутри одной параллельной группы — можно, это не «назад»);
    // и нельзя перейти на операцию после параллельной группы, пока её
    // операции не завершены все (ОТК ждёт обе из {КИПЕРКА, РАСПОШИВ}).
    // Идемпотентный re-scan (`sameOp && sameEmployee`) отрабатывает выше.
    const scanOrder = await this.evaluateRouteOrder(
      passport,
      session.operationId,
    );
    if (scanOrder.backward) throw new PassportScanBackwardException();
    if (scanOrder.groupIncomplete) {
      throw new PassportParallelGroupIncompleteException();
    }

    const nextRouteStepIndex =
      scanOrder.targetIndex ?? passport.currentRouteStepIndex;

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
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.OPERATION_SCAN,
          operationId: session.operationId,
          fromOperationId: previousOperationId,
          employeeId,
          equipmentId: session.equipmentId,
          qty: passport.qtyGood,
        },
      });
      // Сдельное начисление швее теперь создаётся в момент явного
      // завершения операции (`completeOperationByEmployee`), а не на
      // следующем скане — см. `EarningsService.createPendingForCompletedOperation`.
      // Audit: фиксируем переход на новую операцию — это самое
      // частое движение паспорта и самый ценный срез для разбора
      // («куда и от кого ушла партия»). Соблюдаем минимальный
      // payload: ids операций/предыдущего исполнителя + qty.
      await this.audit.log(
        {
          event: 'PASSPORT_SCANNED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId,
          payload: {
            operationId: session.operationId,
            fromOperationId: previousOperationId,
            previousEmployeeId,
            qty: passport.qtyGood,
            routeStepIndex: nextRouteStepIndex,
          },
        },
        tx,
      );
      // Выпуск готовой продукции при прохождении операции с
      // `producesFinishedGoods = true` (см. ТЗ «выпуск управляется
      // признаком на операции», `prisma/schema.prisma::Operation`,
      // `docs/current-state.md §«Готовая продукция»`). Идемпотентно
      // по `sourceKey = PACKED_PASSPORT:<passportId>`: повторный
      // scan/complete и последующая упаковка не задвоят движение.
      if (previousOperationProducesFinishedGoods) {
        await this.finishedGoods.recordPassportOutputInTx(
          tx,
          passport.id,
          employeeId,
          {
            trigger: 'OPERATION_OUTPUT',
            triggerOperationId: previousOperationId,
          },
        );
      }
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
   * **Источник истины для завершаемой операции — `activeShift.operationId`,
   * а НЕ `passport.currentOperationId`.** Это критично для route-WIP
   * сценария «issue без последующего scan»: после `issueToEmployee`
   * паспорт может остаться с `currentOperationId = CUT_DIVISION`
   * (issue не двигает шаг маршрута, см. §F3a), и наивная привязка
   * `OPERATION_FINISHED.operationId = passport.currentOperationId`
   * даёт абсурдный лог «завершил CUT_DIVISION» после работы на
   * Оверлоке. Вместо этого мы:
   *   1) берём `completedOperationId = session.operationId`;
   *   2) ищем соответствующий `OrderRouteStep` (если у заказа есть
   *      snapshot маршрута) — это будет `completedStep`;
   *   3) запрещаем двигать паспорт НАЗАД по маршруту: если
   *      `completedStep.index < passport.currentRouteStepIndex` —
   *      бросаем `PASSPORT_COMPLETE_BACKWARD` (откат — прерогатива
   *      мастера, см. `MasterActionsService.setRouteStep`);
   *   4) записываем `OPERATION_FINISHED.operationId = completedOperationId`
   *      и обновляем `passport.currentOperationId` /
   *      `currentRouteStepIndex` к завершённому шагу;
   *   5) НЕ перепрыгиваем на следующий шаг — это нужно для семантики
   *      WIP-buffer'а (complete → ✔ текущей; следующий scan → ▶
   *      следующей); см. `shopfloor-projection.ts §buildSewingRoute`.
   *
   * Что делаем в одной транзакции:
   *   - проверяем, что паспорт в `IN_PROGRESS` и закреплён за `employeeId`;
   *   - снимаем `currentEmployeeId = null` и `currentCellId = null` —
   *     паспорт уходит из `current-work` швеи в WIP-buffer;
   *   - выставляем `currentOperationId = completedOperationId`,
   *     `currentRouteStepIndex = completedStep.index` (если шаг найден);
   *   - пишем событие `OPERATION_FINISHED` с `operationId =
   *     completedOperationId` и `qty = qtyGood`.
   *
   * Безопасность (ТЗ §7.2): нельзя завершить чужой паспорт — 409
   * `PASSPORT_NOT_YOURS`. Нельзя завершать паспорт вне `IN_PROGRESS`
   * (например, сразу после `place` или после `PACKED`) — 409
   * `PASSPORT_NOT_IN_PROGRESS`. Нельзя «завершить» операцию, стоящую
   * в маршруте раньше текущего шага — 409 `PASSPORT_COMPLETE_BACKWARD`.
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
    // (см. `docs/flows.md §F8`). Кроме того, именно `session.operationId`
    // — единственный достоверный источник «что фактически завершалось».
    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      select: { operationId: true, equipmentId: true },
    });
    if (!session) throw new ShiftSessionRequiredException();

    // Операцию завершения берём из паспорта, а не вслепую из смены: если
    // ОТК вернул паспорт на переделку на другой распошив-операции, чем
    // стоит смена, авто-определяем её по паспорту (см.
    // `resolveOperationForPassport`). Это убирает «пляску со сменами» при
    // закрытии переделки и чинит пакетное завершение разнооперационных
    // паспортов. Для обычного потока возвращает `session.operationId`.
    const completedOperationId = await this.resolveOperationForPassport(
      { id: passport.id, orderId: passport.orderId },
      session,
    );

    // Та же защита, что в `issueToEmployee`: если по этой паре
    // (passport, operation) уже зафиксировано `OPERATION_FINISHED`,
    // повторное завершение запрещено. Сценарий «штатно» к этой ветке
    // приходит после повторного `ISSUED_TO_EMPLOYEE` — поскольку issue
    // уже заблокирован, до сюда не должно дойти; защита оставлена на
    // случай race-condition / прямого вызова.
    await this.assertOperationNotFinished(passport.id, completedOperationId);

    // Если у заказа есть snapshot маршрута — ищем шаг, который
    // соответствует завершаемой операции. Это нужно, чтобы корректно
    // обновить `currentRouteStepIndex` (для WIP-buffer ✔) и проверить,
    // что мы не пытаемся откатиться назад.
    // Откат назад запрещён (с учётом параллельных групп — см.
    // `evaluateRouteOrder`): если завершаемый шаг по «свёрнутому» рангу
    // идёт раньше текущего, это ошибочный flow / обход master-action →
    // 409 PASSPORT_COMPLETE_BACKWARD. Завершить операцию из той же
    // параллельной группы (КИПЕРКА после РАСПОШИВА) — НЕ «назад».
    // AND-гейт (`groupIncomplete`) к complete НЕ применяем: завершение
    // самой операции группы всегда допустимо.
    const completeOrder = await this.evaluateRouteOrder(
      passport,
      completedOperationId,
    );
    if (completeOrder.backward) {
      throw new PassportCompleteBackwardException();
    }

    const beforeSnapshot = {
      currentOperationId: passport.currentOperationId,
      currentRouteStepIndex: passport.currentRouteStepIndex,
      currentEmployeeId: passport.currentEmployeeId,
      currentCellId: passport.currentCellId,
    };
    const nextRouteStepIndex =
      completeOrder.targetIndex ?? passport.currentRouteStepIndex;
    const afterSnapshot = {
      currentOperationId: completedOperationId,
      currentRouteStepIndex: nextRouteStepIndex,
      currentEmployeeId: null,
      currentCellId: null,
    };

    // Признак выпуска готовой продукции на завершаемой операции (см.
    // `prisma/schema.prisma::Operation.producesFinishedGoods`,
    // `FinishedGoodsService.recordPassportOutputInTx`). Прохождение
    // операции с `producesFinishedGoods = true` создаёт
    // `FinishedGoodsMovement PRODUCTION_RECEIPT IN`. Идемпотентно
    // по `sourceKey = PACKED_PASSPORT:<passportId>`.
    const completedOperationProducesFinishedGoods = Boolean(
      (
        await this.prisma.operation.findUnique({
          where: { id: completedOperationId },
          select: { producesFinishedGoods: true },
        })
      )?.producesFinishedGoods,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.passport.update({
        where: { id: passport.id },
        data: {
          currentEmployeeId: null,
          currentCellId: null,
          currentOperationId: completedOperationId,
          currentRouteStepIndex: nextRouteStepIndex,
        },
      });
      const finishedEvent = await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.OPERATION_FINISHED,
          operationId: completedOperationId,
          fromOperationId: passport.currentOperationId ?? completedOperationId,
          employeeId,
          equipmentId: session.equipmentId,
          qty: passport.qtyGood,
        },
      });
      // Шаг 9 (ADR-0005): начисление PENDING_RELEASE самой швее за
      // только что завершённую операцию. Сервис сам решит, выписывать
      // ли начисление: проверит, что operation — piecework и не CUT_CUT
      // (он покрыт immediate-веткой), а employee — на сдельной оплате.
      // Подтверждение остаётся за упаковщиком в `PackingService.close`
      // (`approvePendingForPassport`). Дубли защищены `@@unique` и
      // обработкой P2002 в сервисе.
      await this.earnings.createPendingForCompletedOperation(tx, {
        passportId: passport.id,
        operationId: completedOperationId,
        employeeId,
        productId: passport.productId,
        sizeId: passport.sizeId,
        qty: passport.qtyCut,
        sourceEventId: finishedEvent.id,
      });
      // Audit: швея явно завершила свою операцию (см. ТЗ §7.2).
      // Payload расширен before/after-снэпшотами и `completedOperationId`
      // — этого достаточно для ретроспективы «кто и какую операцию
      // завершил, и куда после этого ушёл паспорт».
      await this.audit.log(
        {
          event: 'PASSPORT_OPERATION_COMPLETED',
          entityType: 'PASSPORT',
          entityId: passport.id,
          employeeId,
          payload: {
            completedOperationId,
            qty: passport.qtyGood,
            before: beforeSnapshot,
            after: afterSnapshot,
          },
        },
        tx,
      );
      // Выпуск готовой продукции при завершении операции с
      // `producesFinishedGoods = true` (см. ТЗ «выпуск управляется
      // признаком на операции», `prisma/schema.prisma::Operation`,
      // `docs/current-state.md §«Готовая продукция»`). Идемпотентно
      // по `sourceKey = PACKED_PASSPORT:<passportId>` — повторный
      // complete, последующий scan на следующей операции и упаковка
      // не задвоят движение.
      if (completedOperationProducesFinishedGoods) {
        await this.finishedGoods.recordPassportOutputInTx(
          tx,
          passport.id,
          employeeId,
          {
            trigger: 'OPERATION_OUTPUT',
            triggerOperationId: completedOperationId,
          },
        );
      }
      // Сплит-распошив больше НЕ сворачивает снапшот маршрута здесь
      // (Вариант B, см. route-mode.ts): снимок всегда остаётся сплитом,
      // а «сплит vs схлоп» вычисляется на лету для гейта и монитора. Гейт
      // инвариантен к режиму — 04 засчитывает и низ, и рукав через
      // OperationSubstitution (см. evaluateRouteOrder, substitution-aware
      // резолв целевого шага).
    });

    this.logger.log(
      `event=passport.complete-operation passportId=${passportId} employeeId=${employeeId} completedOperationId=${completedOperationId}`,
    );
    return this.getOne(passportId);
  }

  /**
   * Пакетное завершение операций сразу по нескольким паспортам швеи.
   *
   * Мотивация (UX /work): швея сначала набирает крой (сканирует много
   * паспортов), а потом завершает их по одному. Этот метод позволяет
   * закрыть выбранные разом — она отмечает чекбоксами карточки в
   * «Текущий крой» и жмёт «Завершить выбранные».
   *
   * Здесь НЕТ новой бизнес-логики: каждый паспорт проходит через тот же
   * `completeOperationByEmployee` (своя транзакция, событие
   * `OPERATION_FINISHED`, начисление, аудит, выпуск ГП, проверки
   * маршрута). Партиальный успех — сознательное решение: если один
   * паспорт упал (откат назад, не твой, не в работе), остальные всё
   * равно закрываются, а причина по упавшему возвращается в `failed`,
   * чтобы UI показал адресное сообщение. Дубликаты id схлопываем,
   * порядок сохраняем (детерминированный ответ для теста/лога).
   */
  async completeOperationsBatch(
    passportIds: string[],
    employeeId: string,
  ): Promise<BatchCompleteOperationsResultDto> {
    const unique = [...new Set(passportIds)];
    const completed: BatchCompleteOperationsResultDto['completed'] = [];
    const failed: BatchCompleteOperationsResultDto['failed'] = [];

    for (const passportId of unique) {
      try {
        const p = await this.completeOperationByEmployee(passportId, employeeId);
        completed.push({ passportId: p.id, number: p.number });
      } catch (e) {
        const { error, code } = describeBatchCompleteError(e);
        // Номер нужен только для текста ошибки в UI; провал —
        // исключительная ветка, поэтому лёгкий доп-запрос здесь
        // не бьёт по happy-path.
        const number = await this.prisma.passport
          .findUnique({
            where: { id: passportId },
            select: { number: true },
          })
          .then((row) => row?.number ?? null)
          .catch(() => null);
        failed.push({ passportId, number, error, code });
      }
    }

    this.logger.log(
      `event=passport.complete-operation-batch employeeId=${employeeId} ` +
        `requested=${unique.length} completed=${completed.length} failed=${failed.length}`,
    );
    return { completed, failed };
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
  async findByCode(
    code: string,
    options?: GetOneOptions,
  ): Promise<PassportDetailDto> {
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
    return this.getOne(row.id, options);
  }

  // -------------------------------------------------------------------------
  // CELLS (минимальный контракт под форму размещения)
  // -------------------------------------------------------------------------

  /**
   * List активных ячеек для UI размещения паспорта и формы
   * «Переместить» в `/admin/warehouses?tab=balances`.
   *
   * `warehouseId` — additive query-фильтр (см.
   * `apps/api/src/modules/passports/cells.controller.ts::list`,
   * `apps/web/components/warehouses/stock/stock-transfer-dialog.tsx`):
   *   - `undefined` / not passed → все активные ячейки (исторический
   *     контракт `GET /api/cells`, сохраняем как есть);
   *   - непустая строка → ячейки, привязанные именно к этому складу
   *     (`Cell.warehouseId = warehouseId`).
   *
   * Список ячеек «без склада» (`Cell.warehouseId IS NULL`) сознательно
   * не отдаём, когда клиент явно фильтрует по складу — это бы ввело
   * пользователя в заблуждение.
   */
  async listCells(filter: {
    warehouseId?: string;
  } = {}): Promise<CellDetailDto[]> {
    const where: Prisma.CellWhereInput = { active: true };
    if (filter.warehouseId) {
      where.warehouseId = filter.warehouseId;
    }
    const cells = await this.prisma.cell.findMany({
      where,
      include: { warehouse: true },
      orderBy: { code: 'asc' },
    });
    const cellIds = cells.map((c) => c.id);
    const contentsByCellId = await this.loadCellContentsFromWip(cellIds);
    return cells.map((c) =>
      this.toCellDto(c, contentsByCellId.get(c.id) ?? []),
    );
  }

  async getCell(id: string): Promise<CellDetailDto> {
    const cell = await this.prisma.cell.findUnique({
      where: { id },
      include: { warehouse: true },
    });
    if (!cell) throw new CellNotFoundException();
    const contentsByCellId = await this.loadCellContentsFromWip([id]);
    return this.toCellDto(cell, contentsByCellId.get(id) ?? []);
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
      include: { warehouse: true },
    });
    if (!cell) throw new CellNotFoundException();
    if (!cell.active) throw new CellInactiveException();
    const contentsByCellId = await this.loadCellContentsFromWip([cell.id]);
    return this.toCellDto(cell, contentsByCellId.get(cell.id) ?? []);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Stage 3 «Мастер цеха» — pre-check активной политики выдачи кроя.
   *
   * Возвращает `null`, если ограничение к этому issue не применимо:
   *   - нет активной политики (`isActive = true`);
   *   - и операция активной смены НЕ из категории `CUTTING`,
   *     и у паспорта `currentRouteStepIndex !== 0` (см. ТЗ §4: «политика
   *     действует только на ПЕРВОЙ операции маршрута / категории CUTTING»).
   *
   * Иначе сравниваем фильтры политики (`color`, `sizeId`) со снимком
   * паспорта и проверяем `consumedQty + qtyCut <= limitQty`. При
   * любом несоответствии бросаем `CutReleasePolicyViolationException`
   * с текстом, собранным из самой политики (см.
   * `formatCutReleasePolicyMessage`). При успехе возвращаем «билет»
   * (`policyId` + лимит/счётчик), который дальше используется внутри
   * транзакции для атомарного `consumedQty += qtyCut` (см.
   * `consumeCutReleasePolicyInTx`).
   *
   * Гонки: между этим pre-check и `consumeCutReleasePolicyInTx` другая
   * транзакция может успеть увеличить `consumedQty` — finальный
   * conditional `updateMany` ниже это поймает и снова бросит
   * VIOLATION (без записи issue). Таким образом limit держится
   * инвариантно, и нам не нужен SERIALIZABLE-режим транзакции.
   */
  private async evaluateCutReleasePolicyForIssue(
    passport: { color: string | null; sizeId: string; qtyCut: number; currentRouteStepIndex: number | null },
    operationCategory: OperationCategory,
  ): Promise<{
    policyId: string;
    limitQty: number;
    color: string | null;
    sizeId: string | null;
    sizeLabel: string | null;
    consumedBefore: number;
  } | null> {
    const policy = await this.prisma.cutReleasePolicy.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!policy) return null;

    const isFirstRouteStep = passport.currentRouteStepIndex === 0;
    const isCuttingOperation = operationCategory === OperationCategory.CUTTING;
    if (!isFirstRouteStep && !isCuttingOperation) {
      // Stage 3 сознательно не блокирует движение по маршруту дальше —
      // только первую выдачу кроя. См. ТЗ §11 «НЕ ДЕЛАТЬ».
      return null;
    }

    const sizeLabel = policy.sizeId
      ? (await this.prisma.size.findUnique({
          where: { id: policy.sizeId },
          select: { code: true },
        }))?.code ?? null
      : null;

    const colorMismatch =
      policy.color !== null && passport.color !== policy.color;
    const sizeMismatch =
      policy.sizeId !== null && passport.sizeId !== policy.sizeId;
    const limitMismatch =
      policy.consumedQty + passport.qtyCut > policy.limitQty;

    if (colorMismatch || sizeMismatch || limitMismatch) {
      throw this.cutReleasePolicy.buildViolation({
        color: policy.color,
        sizeLabel,
        limitQty: policy.limitQty,
      });
    }

    return {
      policyId: policy.id,
      limitQty: policy.limitQty,
      color: policy.color,
      sizeId: policy.sizeId,
      sizeLabel,
      consumedBefore: policy.consumedQty,
    };
  }

  /**
   * Stage 3 «Мастер цеха» — атомарная фиксация выдачи в active-политике.
   *
   * Делает conditional `updateMany`: инкремент `consumedQty` срабатывает
   * только если политика всё ещё активна (`isActive = true`) И лимит не
   * будет превышен (`consumedQty + qty <= limitQty`). Если 0 строк
   * обновлено, значит между pre-check и transaction'ом политику
   * выключили или другая транзакция «съела» остаток лимита — бросаем
   * VIOLATION с актуальным снимком политики, чтобы UI показал
   * корректный inline-message.
   *
   * Audit-событие `CUT_RELEASE_POLICY_CONSUMED` пишется в той же
   * транзакции — `entityType = CUT_RELEASE_POLICY`, `entityId = policy.id`.
   * Payload содержит `passportId`, `qty`, `beforeConsumed`,
   * `afterConsumed` — этого достаточно для разбора «куда ушёл лимит».
   */
  private async consumeCutReleasePolicyInTx(
    tx: Prisma.TransactionClient,
    enforcement: {
      policyId: string;
      limitQty: number;
      color: string | null;
      sizeId: string | null;
      sizeLabel: string | null;
      consumedBefore: number;
    } | null,
    op: {
      passportId: string;
      employeeId: string;
      qty: number;
      mode: 'FROM_CELL' | 'ROUTE_WIP';
    },
  ): Promise<void> {
    if (!enforcement) return;
    const incremented = await tx.cutReleasePolicy.updateMany({
      where: {
        id: enforcement.policyId,
        isActive: true,
        consumedQty: { lte: enforcement.limitQty - op.qty },
      },
      data: { consumedQty: { increment: op.qty } },
    });
    if (incremented.count === 0) {
      // Политика поменялась между pre-check'ом и transaction'ом
      // (выключили / новый создали / гонка по `consumedQty`). Берём
      // актуальный снимок и бросаем VIOLATION ровно с тем текстом,
      // который покажем рабочему.
      const fresh = await tx.cutReleasePolicy.findFirst({
        where: { isActive: true },
        orderBy: { updatedAt: 'desc' },
      });
      const sizeLabel = fresh?.sizeId
        ? (await tx.size.findUnique({
            where: { id: fresh.sizeId },
            select: { code: true },
          }))?.code ?? null
        : null;
      throw this.cutReleasePolicy.buildViolation({
        color: fresh?.color ?? enforcement.color,
        sizeLabel: sizeLabel ?? enforcement.sizeLabel,
        limitQty: fresh?.limitQty ?? enforcement.limitQty,
      });
    }
    await this.audit.log(
      {
        event: 'CUT_RELEASE_POLICY_CONSUMED',
        entityType: 'CUT_RELEASE_POLICY',
        entityId: enforcement.policyId,
        employeeId: op.employeeId,
        payload: {
          passportId: op.passportId,
          qty: op.qty,
          beforeConsumed: enforcement.consumedBefore,
          afterConsumed: enforcement.consumedBefore + op.qty,
          issueMode: op.mode,
        },
      },
      tx,
    );
  }

  /**
   * PHASE 2 STEP 3 — Cutter attribution.
   *
   * Возвращает сотрудника-раскройщика, на которого PassportsService.create
   * запишет immediate-начисление (через `EarningsService.createImmediateForCutter`).
   *
   * Контракт (см. JSDoc у `create()`):
   *   - `dto.cutterId` пришёл явно → ищем в БД, требуем role=CUTTER и
   *     active=true; иначе — `CUTTER_NOT_FOUND` / `CUTTER_INACTIVE`.
   *   - `dto.cutterId` пуст, но creator.role = CUTTER → возвращаем creator
   *     (исторический happy-path, где раскройщик сам выпускает паспорт).
   *   - Иначе → `CUTTER_REQUIRED` (UI должен показать select раскройщика
   *     для CUTTER_ASSISTANT / SHOP_MANAGER).
   *
   * Принимает уже загруженного `creator` — это избавляет от лишнего
   * round-trip в БД (creator уже подгружен в `create()`).
   */
  private async resolveCutter(
    cutterId: string | undefined,
    creator: { id: string; role: Role; active: boolean },
  ): Promise<{ id: string }> {
    if (cutterId) {
      const explicit = await this.prisma.employee.findUnique({
        where: { id: cutterId },
        select: { id: true, role: true, active: true },
      });
      if (!explicit || explicit.role !== Role.CUTTER) {
        throw new CutterNotFoundException();
      }
      if (!explicit.active) {
        throw new CutterInactiveException();
      }
      return { id: explicit.id };
    }
    if (creator.role === Role.CUTTER) {
      // Исторический happy-path: рабочее место раскройщика, паспорт
      // выпускается «на себя». Активность creator-а уже гарантирована
      // тем, что он залогинен (auth-flow проверяет `Employee.active`).
      return { id: creator.id };
    }
    throw new CutterRequiredException();
  }

  /**
   * Возвращает причину, по которой паспорт нельзя редактировать или
   * удалять силами автора (CUTTER_ASSISTANT/CUTTER на /work/passports).
   *
   * Используется и в `update()` / `delete()` (для блокировки backend-
   * операций), и в `listMineRecent()` (чтобы UI рисовал disabled-кнопки
   * на «двинувшихся» паспортах). Возвращает `null`, если паспорт ещё
   * полностью «свежий» — `CREATED`, без ячейки, без событий кроме
   * `CREATED`.
   *
   * Менеджеры/админ этими ограничениями не связаны: для них правка
   * чужих паспортов идёт через master-actions, а не PATCH.
   */
  private editableBlockReason(
    passport: { status: PassportStatus; currentCellId: string | null },
    hasOtherEvents: boolean,
  ): PassportEditableBlock | null {
    if (passport.status !== PassportStatus.CREATED) return 'STATUS_NOT_CREATED';
    if (passport.currentCellId) return 'PLACED_IN_CELL';
    if (hasOtherEvents) return 'HAS_EVENTS_BEYOND_CREATED';
    return null;
  }

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

  /**
   * Запрещает повторное выполнение завершённой операции по паспорту.
   * Используется в `issueToEmployee` и `completeOperationByEmployee`:
   * как только в истории `PassportEvent` появилось `OPERATION_FINISHED`
   * на (passportId, operationId), для рядового сотрудника операция
   * считается закрытой безвозвратно. Откат — только админом через
   * прямую правку БД.
   */
  /**
   * Есть ли по паспорту хоть один «открытый» rework — то есть
   * `OPERATION_REWORK_OPENED` без последующего `OPERATION_FINISHED`
   * для той же (passport, operation). Используется как guard в
   * `scanOnOperation` (категория QC) и для UI-флага `reworkPending`
   * в QC-сервисе (там есть локальная копия, чтобы не вешать
   * cross-module зависимость на private-метод).
   *
   * Реализация: одним батчем достаём последние REWORK и FINISHED по
   * `operationId`, сравниваем createdAt. Если для какого-то operationId
   * последний event — REWORK_OPENED, значит rework открыт.
   *
   * `excludeOperationId` — операция, rework по которой не должен считаться
   * блокирующим. Используется QC-гейтом в `scanOnOperation` для сценария
   * «мастер вернул паспорт на ОТК через set-route-step backward»:
   * REWORK_OPENED при этом висит на самой ОТК-операции, и ОТК наоборот
   * обязан её отсканировать — не блокируем.
   */
  async hasOpenRework(
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
    const lastByOp = new Map<
      string,
      { type: PassportEventType; createdAt: Date }
    >();
    for (const ev of events) {
      if (!ev.operationId) continue;
      if (!lastByOp.has(ev.operationId)) {
        lastByOp.set(ev.operationId, {
          type: ev.type,
          createdAt: ev.createdAt,
        });
      }
    }
    for (const [opId, last] of lastByOp) {
      if (excludeOperationId && opId === excludeOperationId) continue;
      if (last.type === PassportEventType.OPERATION_REWORK_OPENED) return true;
    }
    return false;
  }

  private async assertOperationNotFinished(
    passportId: string,
    operationId: string,
  ): Promise<void> {
    // Учитываем `OPERATION_FINISHED` только для текущего «прохода»
    // операции. Если ОТК вернул паспорт на переделку
    // (`OPERATION_REWORK_OPENED` для этой же пары passport+operation),
    // отсчёт идёт от последнего rework — старые `OPERATION_FINISHED`
    // относились к прошлому проходу и больше не блокируют. См.
    // `QcService.returnToRework` и `docs/flows.md §F5a`.
    const lastRework = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        operationId,
        type: PassportEventType.OPERATION_REWORK_OPENED,
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const finished = await this.prisma.passportEvent.findFirst({
      where: {
        passportId,
        operationId,
        type: PassportEventType.OPERATION_FINISHED,
        ...(lastRework ? { createdAt: { gt: lastRework.createdAt } } : {}),
      },
      select: { id: true },
    });
    if (finished) {
      throw new PassportOperationAlreadyFinishedException();
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

  private toDetailDto(
    row: PassportRow,
    routeHint: PassportRouteHintDto | null,
  ): PassportDetailDto {
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
      routeHint,
    };
  }

  /**
   * Собирает `PassportRouteHintDto` для UI-подсказки на /work
   * (см. STEP 8 ТЗ MVP, `docs/domain.md §«Маршруты производства»`).
   *
   * Контракт:
   *   - источник истины — `OrderRouteStep` snapshot заказа, НЕ
   *     `RouteTemplate` (snapshot самодостаточный, см. ADR / domain.md);
   *   - если у заказа нет snapshot маршрута → возвращаем `null`,
   *     UI скроет блок;
   *   - если `currentRouteStepIndex === null` → шагов считать ещё
   *     нечего: возвращаем «пустой» hint с `currentRouteStep = null`,
   *     `nextRouteStep = step[0]` (если он есть), без warning;
   *   - если `currentRouteStepIndex` вне диапазона snapshot
   *     (например, маршрут укоротили) → возвращаем «пустой» hint без
   *     warning, чтобы не падать;
   *   - `expectedOperation = currentRouteStep.operation` — единое
   *     правило с `current-work-card.tsx` (см. STEP 8 ТЗ);
   *   - `routeMismatchWithActiveShift = true` только когда у швеи
   *     есть активная смена И её `operationId` ≠ expected.
   *
   * Безопасность: метод НИКОГДА не кидает — любые ошибки чтения
   * маршрута/смены превращаются в null/false. Hint должен оставаться
   * read-only подсказкой (см. ТЗ MVP §STEP 5).
   */
  private async buildRouteHint(
    row: PassportRow,
    options?: GetOneOptions,
  ): Promise<PassportRouteHintDto | null> {
    let steps: Array<{
      index: number;
      operation: { id: string; code: string; name: string };
    }>;
    try {
      steps = await this.prisma.orderRouteStep.findMany({
        where: { orderId: row.orderId },
        orderBy: { index: 'asc' },
        select: {
          index: true,
          operation: { select: { id: true, code: true, name: true } },
        },
      });
    } catch {
      return null;
    }
    if (steps.length === 0) return null;

    const toLite = (
      s: (typeof steps)[number],
    ): PassportRouteStepLiteDto => ({
      index: s.index,
      operationId: s.operation.id,
      operationCode: s.operation.code,
      operationName: s.operation.name,
    });

    const currentIndex = row.currentRouteStepIndex;
    const currentStep =
      currentIndex !== null
        ? steps.find((s) => s.index === currentIndex) ?? null
        : null;
    const nextStep =
      currentIndex !== null
        ? steps.find((s) => s.index === currentIndex + 1) ?? null
        : steps[0] ?? null;

    let activeShiftOperationId: string | null = null;
    let activeShiftOperationName: string | null = null;
    if (options?.employeeIdForRouteHint) {
      try {
        const session = await this.prisma.shiftSession.findFirst({
          where: {
            employeeId: options.employeeIdForRouteHint,
            endedAt: null,
          },
          select: {
            operation: { select: { id: true, name: true } },
          },
        });
        if (session) {
          activeShiftOperationId = session.operation.id;
          activeShiftOperationName = session.operation.name;
        }
      } catch {
        // fail-soft: подсказка по mismatch необязательна
      }
    }

    const expectedOperationId = currentStep ? currentStep.operation.id : null;
    const expectedOperationName = currentStep
      ? currentStep.operation.name
      : null;

    const routeMismatchWithActiveShift =
      !!expectedOperationId &&
      !!activeShiftOperationId &&
      expectedOperationId !== activeShiftOperationId;

    return {
      currentRouteStep: currentStep ? toLite(currentStep) : null,
      nextRouteStep: nextStep ? toLite(nextStep) : null,
      expectedOperationId,
      expectedOperationName,
      activeShiftOperationId,
      activeShiftOperationName,
      routeMismatchWithActiveShift,
    };
  }

  private toCellDto(
    cell: Prisma.CellGetPayload<{
      include: { warehouse: true };
    }>,
    contents: CellDetailDto['contents'],
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
      contents,
    };
  }

  /**
   * Подгружает «содержимое ячеек» (срез по размерам) из
   * `WorkInProgressBalance` — единственный источник истины для
   * полуфабриката (см.
   * `apps/api/src/modules/work-in-progress/work-in-progress.service.ts`,
   * `prisma/schema.prisma::WorkInProgressBalance`).
   *
   * Историческая `CellContent` была удалена в рамках перехода к
   * единой модели полуфабриката. WIP содержит больше измерений
   * (`orderId`/`productId`/`color`), поэтому здесь мы их сворачиваем
   * по `(cellId, sizeId)` суммой qty — для UI «что в ячейке по
   * размерам» этого достаточно.
   *
   * Возвращает Map cellId → отсортированный по `Size.sortOrder` массив
   * `{ sizeId, sizeCode, sizeSortOrder, quantity }`. Размеры с
   * нулевой/отсутствующей суммой не включаются.
   */
  private async loadCellContentsFromWip(
    cellIds: string[],
  ): Promise<Map<string, CellDetailDto['contents']>> {
    const result = new Map<string, CellDetailDto['contents']>();
    if (cellIds.length === 0) return result;

    const balances = await this.prisma.workInProgressBalance.findMany({
      where: {
        cellId: { in: cellIds },
        qty: { gt: 0 },
      },
      include: {
        size: { select: { id: true, code: true, sortOrder: true } },
      },
    });

    // Свёртка (cellId, sizeId) → суммарный qty. У одной ячейки и
    // одного размера может быть несколько строк WIP (разные orderId/
    // productId/color), их складываем — на уровне CellDetailDto
    // нужна общая цифра «N штук размера M в ячейке».
    type Bucket = {
      sizeId: string;
      sizeCode: string;
      sizeSortOrder: number;
      quantity: number;
    };
    const aggregated = new Map<string, Map<string, Bucket>>();
    for (const b of balances) {
      if (!b.cellId) continue;
      let bySize = aggregated.get(b.cellId);
      if (!bySize) {
        bySize = new Map();
        aggregated.set(b.cellId, bySize);
      }
      const existing = bySize.get(b.sizeId);
      if (existing) {
        existing.quantity += b.qty;
      } else {
        bySize.set(b.sizeId, {
          sizeId: b.sizeId,
          sizeCode: b.size.code,
          sizeSortOrder: b.size.sortOrder,
          quantity: b.qty,
        });
      }
    }

    for (const [cellId, bySize] of aggregated.entries()) {
      const items = Array.from(bySize.values()).sort(
        (a, b) => a.sizeSortOrder - b.sizeSortOrder,
      );
      result.set(cellId, items);
    }
    return result;
  }
}
