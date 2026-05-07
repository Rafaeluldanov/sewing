import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OperationCategory } from '@prisma/client';
import {
  formatOrderCutIssueRuleViolationMessage,
  type BulkUpsertOrderCutIssueRulesDto,
  type OrderCutIssueQueueDto,
  type OrderCutIssueRuleBannerDto,
  type OrderCutIssueRuleBannerOrderDto,
  type OrderCutIssueRuleDto,
  type OrderCutIssueRuleStatus,
  type OrderCutIssueRulesSummaryDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  OrderCutIssueQueueDeleteNotAllowedException,
  OrderCutIssueQueueNotFoundException,
  OrderCutIssueRuleRequiredAbovePlanException,
  OrderCutIssueRuleRequiredBelowIssuedException,
  OrderCutIssueRuleSizeNotInOrderException,
  OrderCutIssueRuleViolationException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Сервис «Очередь выдачи кроя по размерам» (см.
 * `prisma/schema.prisma::OrderCutIssueRule`,
 * `docs/domain.md §«Очередь выдачи кроя»`).
 *
 * Поддерживает множественные очереди (каждая — отдельная «партия»
 * выдачи внутри заказа, идентифицируется `queueIndex`). «Текущая»
 * очередь — минимальный `queueIndex`, у которого есть незакрытые
 * строки. Блокировка выдачи и инкремент `issuedQty` всегда работают
 * в рамках текущей очереди; после её закрытия следующая
 * автоматически становится текущей.
 *
 * Контракт:
 *   - `listForOrder(orderId)` — отдать сводку: статус заказа +
 *     список всех очередей с их строками, сортировкой и derived-полями;
 *   - `bulkUpsert(actor, orderId, dto)` — сохранить форму одной
 *     очереди (`dto.queueIndex`): upsert строк этой очереди; строки
 *     этой же очереди, не пришедшие в `dto.rows`, гасятся
 *     `isActive = false`. Другие очереди заказа не трогаются;
 *   - `disableAll(actor, orderId)` — атомарно `isActive = false` для
 *     всех строк во всех очередях заказа;
 *   - `deleteQueue(actor, orderId, queueIndex)` — удалить очередь
 *     целиком; разрешено только если это последняя очередь и в ней
 *     `Σ issuedQty = 0`;
 *   - `evaluateForIssue(passport, operationCategory)` — pre-check для
 *     `PassportsService.issueToEmployee`: возвращает evaluation с
 *     id строки ТЕКУЩЕЙ очереди + `requiredQty / issuedQty`, либо
 *     `null`, если правило не применимо;
 *   - `consumeInTx(tx, evaluation, ...)` — атомарный инкремент
 *     `issuedQty` через conditional `updateMany`. Если 0 строк
 *     обновлено (race) — перечитываем актуальное состояние и кидаем
 *     VIOLATION с актуальным сообщением.
 */
@Injectable()
export class OrderCutIssueRulesService {
  private readonly logger = new Logger(OrderCutIssueRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<OrderCutIssueRulesSummaryDto> {
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
    const rows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId },
      include: { size: true },
    });
    rows.sort(this.compareRows);
    return this.buildSummary(orderId, rows.map((r) => this.toDto(r)));
  }

  // -------------------------------------------------------------------------
  // BULK UPSERT (per queue)
  // -------------------------------------------------------------------------

  /**
   * Сохранить bulk-форму одной конкретной очереди (`dto.queueIndex`).
   * Контракт:
   *   - проверяем, что заказ существует;
   *   - проверяем, что каждый `sizeId` из `rows` встречается в
   *     `OrderItem` этого заказа (иначе 400);
   *   - для каждого размера считаем `qtyPlanBySize` и проверяем,
   *     что `requiredQty (этой очереди) + Σ requiredQty по этому
   *     размеру в ДРУГИХ активных очередях <= qtyPlan` — иначе 422
   *     (сумма по очередям не должна перевышать план);
   *   - для каждой уже существующей строки этой очереди убеждаемся,
   *     что новый `requiredQty >= issuedQty`;
   *   - в одной транзакции upsert-им строки этой очереди и переводим
   *     в `isActive = false` все активные строки ЭТОЙ ЖЕ очереди,
   *     которых нет в `rows`.
   */
  async bulkUpsert(
    actor: AuthPrincipal,
    orderId: string,
    dto: BulkUpsertOrderCutIssueRulesDto,
  ): Promise<OrderCutIssueRulesSummaryDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { select: { sizeId: true, qtyPlan: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    const qtyPlanBySize = new Map<string, number>();
    for (const it of order.items) {
      qtyPlanBySize.set(
        it.sizeId,
        (qtyPlanBySize.get(it.sizeId) ?? 0) + it.qtyPlan,
      );
    }

    // Все строки заказа во ВСЕХ очередях — нужно для:
    //  (а) проверки `Σ requiredQty по другим активным очередям <= план`;
    //  (б) определения существующих строк ИМЕННО этой очереди;
    //  (в) audit-payload «что деактивируем».
    const allRows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId },
      include: { size: { select: { code: true } } },
    });
    const existingInThisQueue = allRows.filter(
      (r) => r.queueIndex === dto.queueIndex,
    );
    const existingBySizeIdInThisQueue = new Map(
      existingInThisQueue.map((r) => [r.sizeId, r]),
    );

    // Σ requiredQty по другим активным очередям, разбитая по sizeId.
    // Используется как «остаток плана» для валидации новой/обновляемой
    // строки в текущей очереди.
    const otherQueuesActiveBySize = new Map<string, number>();
    for (const r of allRows) {
      if (!r.isActive) continue;
      if (r.queueIndex === dto.queueIndex) continue;
      otherQueuesActiveBySize.set(
        r.sizeId,
        (otherQueuesActiveBySize.get(r.sizeId) ?? 0) + r.requiredQty,
      );
    }

    const dtoSizeIds = dto.rows.map((r) => r.sizeId);
    const sizeRows = dtoSizeIds.length
      ? await this.prisma.size.findMany({
          where: { id: { in: dtoSizeIds } },
          select: { id: true, code: true },
        })
      : [];
    const sizeCodeById = new Map(sizeRows.map((s) => [s.id, s.code]));

    // -- VALIDATE -----------------------------------------------------------

    for (const row of dto.rows) {
      const planQty = qtyPlanBySize.get(row.sizeId);
      if (planQty === undefined) {
        throw new OrderCutIssueRuleSizeNotInOrderException(
          sizeCodeById.get(row.sizeId),
        );
      }
      const claimedInOtherQueues = otherQueuesActiveBySize.get(row.sizeId) ?? 0;
      const remainder = Math.max(planQty - claimedInOtherQueues, 0);
      if (row.requiredQty > remainder) {
        throw new OrderCutIssueRuleRequiredAbovePlanException(
          sizeCodeById.get(row.sizeId) ?? row.sizeId,
          planQty,
          remainder,
        );
      }
      const existing = existingBySizeIdInThisQueue.get(row.sizeId);
      if (existing && row.requiredQty < existing.issuedQty) {
        throw new OrderCutIssueRuleRequiredBelowIssuedException(
          sizeCodeById.get(row.sizeId) ?? row.sizeId,
        );
      }
    }

    const dtoSizeIdSet = new Set(dtoSizeIds);
    const toDeactivate = existingInThisQueue.filter(
      (r) => r.isActive && !dtoSizeIdSet.has(r.sizeId),
    );
    // Если в гасящейся строке уже что-то выдано, мы не можем её
    // деактивировать (это сломает блокирующую логику и счётчик).
    // Но тот же кейс уже прикрыт чек-ом «requiredQty < issuedQty»
    // только для строк, которые остаются в форме. Здесь дополнительно
    // блокируем деактивацию строк с `issuedQty > 0`, чтобы менеджер
    // увидел понятную ошибку.
    for (const r of toDeactivate) {
      if (r.issuedQty > 0) {
        throw new OrderCutIssueRuleRequiredBelowIssuedException(
          allRows.find((x) => x.id === r.id)?.size.code,
        );
      }
    }

    // -- WRITE --------------------------------------------------------------

    await this.prisma.$transaction(async (tx) => {
      for (const row of dto.rows) {
        const existing = existingBySizeIdInThisQueue.get(row.sizeId);
        if (existing) {
          await tx.orderCutIssueRule.update({
            where: { id: existing.id },
            data: {
              requiredQty: row.requiredQty,
              sortOrder: row.sortOrder ?? existing.sortOrder,
              isActive: true,
            },
          });
        } else {
          await tx.orderCutIssueRule.create({
            data: {
              orderId,
              queueIndex: dto.queueIndex,
              sizeId: row.sizeId,
              requiredQty: row.requiredQty,
              issuedQty: 0,
              sortOrder: row.sortOrder ?? 0,
              isActive: true,
              createdById: actor.employeeId,
            },
          });
        }
      }

      if (toDeactivate.length > 0) {
        await tx.orderCutIssueRule.updateMany({
          where: { id: { in: toDeactivate.map((r) => r.id) } },
          data: { isActive: false },
        });
      }

      await this.audit.log(
        {
          event: 'ORDER_CUT_ISSUE_RULE_UPSERT',
          entityType: 'ORDER_CUT_ISSUE_RULE',
          entityId: orderId,
          employeeId: actor.employeeId,
          payload: {
            orderId,
            queueIndex: dto.queueIndex,
            rowsCount: dto.rows.length,
            deactivatedCount: toDeactivate.length,
            rows: dto.rows.map((r) => ({
              sizeId: r.sizeId,
              sizeCode: sizeCodeById.get(r.sizeId) ?? null,
              requiredQty: r.requiredQty,
              sortOrder: r.sortOrder ?? 0,
            })),
            deactivatedSizeIds: toDeactivate.map((r) => r.sizeId),
          },
        },
        tx,
      );
    });

    this.logger.log(
      `event=orderCutIssueRule.upsert orderId=${orderId} queueIndex=${dto.queueIndex} actor=${actor.employeeId} rows=${dto.rows.length} deactivated=${toDeactivate.length}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // DISABLE ALL
  // -------------------------------------------------------------------------

  async disableAll(
    actor: AuthPrincipal,
    orderId: string,
  ): Promise<OrderCutIssueRulesSummaryDto> {
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
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.orderCutIssueRule.updateMany({
        where: { orderId, isActive: true },
        data: { isActive: false },
      });
      if (result.count > 0) {
        await this.audit.log(
          {
            event: 'ORDER_CUT_ISSUE_RULE_DISABLED',
            entityType: 'ORDER_CUT_ISSUE_RULE',
            entityId: orderId,
            employeeId: actor.employeeId,
            payload: {
              orderId,
              deactivatedCount: result.count,
            },
          },
          tx,
        );
      }
    });
    this.logger.log(
      `event=orderCutIssueRule.disableAll orderId=${orderId} actor=${actor.employeeId}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // DISABLE QUEUE (per queueIndex)
  // -------------------------------------------------------------------------

  /**
   * Отключить одну конкретную очередь — `isActive = false` для всех
   * её активных строк. В отличие от `deleteQueue`, не требует, чтобы
   * `Σ issuedQty = 0` и не требует, чтобы очередь была последней:
   * счётчики `issuedQty` сохраняются (нужны для аудита и для случая,
   * если менеджер захочет «вернуть» очередь редактированием формы),
   * а порядок очередей не меняется. Идемпотентно: если в очереди
   * уже нет активных строк — без записи в audit.
   */
  async disableQueue(
    actor: AuthPrincipal,
    orderId: string,
    queueIndex: number,
  ): Promise<OrderCutIssueRulesSummaryDto> {
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
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.orderCutIssueRule.updateMany({
        where: { orderId, queueIndex, isActive: true },
        data: { isActive: false },
      });
      if (result.count > 0) {
        await this.audit.log(
          {
            event: 'ORDER_CUT_ISSUE_RULE_DISABLED',
            entityType: 'ORDER_CUT_ISSUE_RULE',
            entityId: orderId,
            employeeId: actor.employeeId,
            payload: {
              orderId,
              queueIndex,
              deactivatedCount: result.count,
            },
          },
          tx,
        );
      }
    });
    this.logger.log(
      `event=orderCutIssueRule.disableQueue orderId=${orderId} queueIndex=${queueIndex} actor=${actor.employeeId}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // DELETE QUEUE (last empty)
  // -------------------------------------------------------------------------

  /**
   * Удалить очередь целиком. Разрешено только если:
   *   - очередь существует (есть хоть одна строка с этим `queueIndex`);
   *   - очередь является последней (нет очередей с большим
   *     `queueIndex` у этого заказа);
   *   - в ней `Σ issuedQty = 0` (ничего ещё не выдано).
   *
   * Реальное удаление строк (а не `isActive = false`) — потому что
   * пустая очередь не несёт ни данных, ни инвариантов: её добавили
   * по ошибке, удалили обратно. Audit-событие пишется до
   * `deleteMany`.
   */
  async deleteQueue(
    actor: AuthPrincipal,
    orderId: string,
    queueIndex: number,
  ): Promise<OrderCutIssueRulesSummaryDto> {
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

    const allRows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId },
      select: { id: true, queueIndex: true, issuedQty: true },
    });
    const targetRows = allRows.filter((r) => r.queueIndex === queueIndex);
    if (targetRows.length === 0) {
      throw new OrderCutIssueQueueNotFoundException(queueIndex);
    }
    const maxQueueIndex = allRows.reduce(
      (m, r) => (r.queueIndex > m ? r.queueIndex : m),
      0,
    );
    if (queueIndex !== maxQueueIndex) {
      throw new OrderCutIssueQueueDeleteNotAllowedException(
        'Удалить можно только последнюю очередь.',
      );
    }
    const totalIssued = targetRows.reduce((s, r) => s + r.issuedQty, 0);
    if (totalIssued > 0) {
      throw new OrderCutIssueQueueDeleteNotAllowedException(
        'Нельзя удалить очередь, по которой уже что-то выдано.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.audit.log(
        {
          event: 'ORDER_CUT_ISSUE_QUEUE_DELETED',
          entityType: 'ORDER_CUT_ISSUE_RULE',
          entityId: orderId,
          employeeId: actor.employeeId,
          payload: {
            orderId,
            queueIndex,
            deletedRowsCount: targetRows.length,
          },
        },
        tx,
      );
      await tx.orderCutIssueRule.deleteMany({
        where: { orderId, queueIndex },
      });
    });

    this.logger.log(
      `event=orderCutIssueRule.deleteQueue orderId=${orderId} queueIndex=${queueIndex} actor=${actor.employeeId}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // EVALUATE / CONSUME (горячий путь, вызывается из PassportsService)
  // -------------------------------------------------------------------------

  /**
   * Pre-check очереди для `PassportsService.issueToEmployee`.
   *
   * Возвращает `null`, если правило не применимо к этому issue:
   *   - нет ни одной активной строки очереди заказа;
   *   - все активные строки выполнены во всех очередях;
   *   - операция активной смены НЕ из категории `CUTTING` И у
   *     паспорта `currentRouteStepIndex !== 0`.
   *
   * Иначе ищет «текущую очередь» (минимальный `queueIndex` с
   * незакрытыми строками) и работает в её рамках:
   *   - если паспорт «не очередного» размера в текущей очереди —
   *     `OrderCutIssueRuleViolationException`;
   *   - если паспорт ИХ размера — возвращает evaluation, который
   *     дальше консумит `consumeInTx`.
   */
  async evaluateForIssue(
    passport: {
      orderId: string;
      sizeId: string;
      qtyCut: number;
      currentRouteStepIndex: number | null;
    },
    operationCategory: OperationCategory,
  ): Promise<{
    ruleId: string;
    queueIndex: number;
    requiredQty: number;
    issuedQtyBefore: number;
    sizeCode: string;
  } | null> {
    const isCuttingOperation = operationCategory === OperationCategory.CUTTING;
    if (!isCuttingOperation) {
      // Не-CUTTING операция: правило применяется если паспорт на
      // (а) index 0 — legacy «первая выдача»; покрывает sewing-only
      //     маршруты И сценарий, когда CUTTING-шаги в маршруте есть,
      //     но раскройщики не делают `complete-operation` (паспорт
      //     остаётся на step 0 до handoff в швейный поток);
      // (б) ПЕРВОМ не-CUTTING шаге маршрута заказа (handoff после
      //     `complete-operation` на CUTTING-шагах — например, ОВР/ФУЛ
      //     при последовательно завершаемых КРОЙ → Деление кроя).
      if (passport.currentRouteStepIndex === null) return null;
      if (passport.currentRouteStepIndex !== 0) {
        const firstNonCutting = await this.prisma.orderRouteStep.findFirst({
          where: {
            orderId: passport.orderId,
            operation: { category: { not: OperationCategory.CUTTING } },
          },
          select: { index: true },
          orderBy: { index: 'asc' },
        });
        if (firstNonCutting?.index !== passport.currentRouteStepIndex) {
          return null;
        }
      }
    }

    const activeRows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId: passport.orderId, isActive: true },
      include: { size: { select: { code: true, sortOrder: true } } },
    });
    if (activeRows.length === 0) return null;

    const currentQueueIndex = this.computeCurrentQueueIndex(activeRows);
    if (currentQueueIndex === null) {
      // Все строки во всех очередях закрыты — очередь «погасла сама».
      return null;
    }

    const currentRows = activeRows.filter(
      (r) => r.queueIndex === currentQueueIndex,
    );
    const unfinishedInCurrent = currentRows.filter(
      (r) => r.issuedQty < r.requiredQty,
    );
    // По определению currentQueueIndex здесь `unfinishedInCurrent.length > 0`,
    // но проверяем явно ради читаемости (и страховки от рассинхрона).
    if (unfinishedInCurrent.length === 0) return null;

    const matched = unfinishedInCurrent.find(
      (r) => r.sizeId === passport.sizeId,
    );
    if (!matched) {
      const sortedUnfinished = [...unfinishedInCurrent].sort(this.compareRows);
      throw new OrderCutIssueRuleViolationException(
        formatOrderCutIssueRuleViolationMessage(
          sortedUnfinished.map((r) => ({
            sizeCode: r.size.code,
            remainingQty: Math.max(r.requiredQty - r.issuedQty, 0),
          })),
        ),
      );
    }

    // Паспорт того же размера, но `qtyCut` больше остатка строки —
    // блокируем единичный overshoot. `consumeInTx` conditional
    // `updateMany` ловит только гонку (issuedQty<requiredQty до
    // инкремента) и сам по себе не ограничивает величину инкремента.
    const remaining = matched.requiredQty - matched.issuedQty;
    if (passport.qtyCut > remaining) {
      const sortedUnfinished = [...unfinishedInCurrent].sort(this.compareRows);
      throw new OrderCutIssueRuleViolationException(
        formatOrderCutIssueRuleViolationMessage(
          sortedUnfinished.map((r) => ({
            sizeCode: r.size.code,
            remainingQty: Math.max(r.requiredQty - r.issuedQty, 0),
          })),
        ),
      );
    }

    return {
      ruleId: matched.id,
      queueIndex: matched.queueIndex,
      requiredQty: matched.requiredQty,
      issuedQtyBefore: matched.issuedQty,
      sizeCode: matched.size.code,
    };
  }

  /**
   * Атомарная фиксация выдачи в строке очереди (внутри
   * `prisma.$transaction` от `PassportsService.issueToEmployee`).
   *
   * Делает conditional `updateMany`: инкремент `issuedQty`
   * срабатывает только если строка всё ещё активна и размер ещё
   * не закрыт (`issuedQty < requiredQty`). Это race-guard; верхний
   * лимит (`qtyCut <= remaining`) проверяет `evaluateForIssue` ДО
   * открытия транзакции. Если здесь 0 строк обновлено — гонка/
   * деактивация; перечитываем актуальное состояние ТЕКУЩЕЙ очереди
   * и бросаем VIOLATION.
   */
  async consumeInTx(
    tx: Prisma.TransactionClient,
    evaluation: {
      ruleId: string;
      queueIndex: number;
      requiredQty: number;
      issuedQtyBefore: number;
      sizeCode: string;
    } | null,
    op: {
      passportId: string;
      orderId: string;
      employeeId: string;
      qty: number;
    },
  ): Promise<void> {
    if (!evaluation) return;
    const incremented = await tx.orderCutIssueRule.updateMany({
      where: {
        id: evaluation.ruleId,
        isActive: true,
        issuedQty: { lte: evaluation.requiredQty - op.qty },
      },
      data: { issuedQty: { increment: op.qty } },
    });
    if (incremented.count === 0) {
      // Перечитываем все активные строки заказа и бросаем VIOLATION
      // с текстом текущей очереди.
      const fresh = await tx.orderCutIssueRule.findMany({
        where: { orderId: op.orderId, isActive: true },
        include: { size: { select: { code: true, sortOrder: true } } },
      });
      const currentQueueIndex = this.computeCurrentQueueIndex(fresh);
      if (currentQueueIndex === null) {
        throw new OrderCutIssueRuleViolationException(
          'Очередь выдачи изменилась — повторите получение кроя.',
        );
      }
      const unfinished = fresh.filter(
        (r) =>
          r.queueIndex === currentQueueIndex &&
          r.issuedQty < r.requiredQty,
      );
      const sortedUnfinished = [...unfinished].sort(this.compareRows);
      throw new OrderCutIssueRuleViolationException(
        formatOrderCutIssueRuleViolationMessage(
          sortedUnfinished.map((r) => ({
            sizeCode: r.size.code,
            remainingQty: Math.max(r.requiredQty - r.issuedQty, 0),
          })),
        ),
      );
    }
    await this.audit.log(
      {
        event: 'ORDER_CUT_ISSUE_RULE_CONSUMED',
        entityType: 'ORDER_CUT_ISSUE_RULE',
        entityId: evaluation.ruleId,
        employeeId: op.employeeId,
        payload: {
          orderId: op.orderId,
          passportId: op.passportId,
          queueIndex: evaluation.queueIndex,
          sizeCode: evaluation.sizeCode,
          qty: op.qty,
          beforeIssued: evaluation.issuedQtyBefore,
          afterIssued: evaluation.issuedQtyBefore + op.qty,
        },
      },
      tx,
    );
  }

  // -------------------------------------------------------------------------
  // mapping & helpers
  // -------------------------------------------------------------------------

  private toDto(
    row: Prisma.OrderCutIssueRuleGetPayload<{
      include: { size: true };
    }>,
  ): OrderCutIssueRuleDto {
    const remainingQty = Math.max(row.requiredQty - row.issuedQty, 0);
    const progressPct =
      row.requiredQty > 0
        ? Math.min(100, Math.round((row.issuedQty / row.requiredQty) * 100))
        : 100;
    return {
      id: row.id,
      orderId: row.orderId,
      queueIndex: row.queueIndex,
      sizeId: row.sizeId,
      sizeCode: row.size.code,
      sizeLabel: row.size.code,
      requiredQty: row.requiredQty,
      issuedQty: row.issuedQty,
      remainingQty,
      progressPct,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Группируем плоский список строк (уже отсортированный) в
   * массив очередей. Очередь считается активной (`status !== OFF`),
   * если в ней есть хоть одна `isActive` строка. `isCurrent = true`
   * у одной очереди — той, у которой минимальный `queueIndex` среди
   * очередей с незакрытыми активными строками.
   */
  private buildSummary(
    orderId: string,
    rules: OrderCutIssueRuleDto[],
  ): OrderCutIssueRulesSummaryDto {
    const queueMap = new Map<number, OrderCutIssueRuleDto[]>();
    for (const r of rules) {
      const list = queueMap.get(r.queueIndex) ?? [];
      list.push(r);
      queueMap.set(r.queueIndex, list);
    }
    const queueIndexes = [...queueMap.keys()].sort((a, b) => a - b);

    // Текущая очередь = минимальный queueIndex с незакрытой активной
    // строкой.
    let currentQueueIndex: number | null = null;
    for (const idx of queueIndexes) {
      const list = queueMap.get(idx) ?? [];
      const hasUnfinishedActive = list.some(
        (r) => r.isActive && r.issuedQty < r.requiredQty,
      );
      if (hasUnfinishedActive) {
        currentQueueIndex = idx;
        break;
      }
    }

    const queues: OrderCutIssueQueueDto[] = queueIndexes.map((idx) => {
      const list = queueMap.get(idx) ?? [];
      const status = this.computeStatus(list);
      return {
        queueIndex: idx,
        status,
        isCurrent: idx === currentQueueIndex,
        rules: list,
      };
    });

    const overallStatus: OrderCutIssueRuleStatus = (() => {
      const anyActive = rules.some((r) => r.isActive);
      if (!anyActive) return 'OFF';
      const allDoneAcrossActive = rules
        .filter((r) => r.isActive)
        .every((r) => r.issuedQty >= r.requiredQty);
      return allDoneAcrossActive ? 'DONE' : 'IN_PROGRESS';
    })();

    return {
      orderId,
      status: overallStatus,
      queues,
      rules,
    };
  }

  private computeStatus(
    rules: OrderCutIssueRuleDto[],
  ): OrderCutIssueRuleStatus {
    const active = rules.filter((r) => r.isActive);
    if (active.length === 0) return 'OFF';
    const allDone = active.every((r) => r.issuedQty >= r.requiredQty);
    return allDone ? 'DONE' : 'IN_PROGRESS';
  }

  /**
   * Минимальный `queueIndex` среди активных строк с
   * `issuedQty < requiredQty`. `null`, если незакрытых активных
   * строк нет (очередь «погасла сама»).
   */
  private computeCurrentQueueIndex(
    rows: ReadonlyArray<{
      queueIndex: number;
      isActive: boolean;
      issuedQty: number;
      requiredQty: number;
    }>,
  ): number | null {
    let result: number | null = null;
    for (const r of rows) {
      if (!r.isActive) continue;
      if (r.issuedQty >= r.requiredQty) continue;
      if (result === null || r.queueIndex < result) result = r.queueIndex;
    }
    return result;
  }

  /**
   * Стабильная сортировка строк очереди для UI и сообщений
   * блокировки: очередь → пользовательский sortOrder → справочный
   * Size.sortOrder → Size.code.
   */
  private compareRows = (
    a: {
      queueIndex: number;
      sortOrder: number;
      size: { sortOrder: number; code: string };
    },
    b: {
      queueIndex: number;
      sortOrder: number;
      size: { sortOrder: number; code: string };
    },
  ): number => {
    if (a.queueIndex !== b.queueIndex) return a.queueIndex - b.queueIndex;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.size.sortOrder !== b.size.sortOrder)
      return a.size.sortOrder - b.size.sortOrder;
    return a.size.code.localeCompare(b.size.code);
  };

  // -------------------------------------------------------------------------
  // ACTIVE BANNER (UI /work — «Сейчас сканируйте: размер X, ячейки Y»)
  // -------------------------------------------------------------------------

  /**
   * Подсказка для seamstress UI: какие размеры по каким заказам
   * сейчас разрешено сканировать. Симметричен `evaluateForIssue` —
   * правило применимо только для операций категории `CUTTING` или
   * для первого шага маршрута заказа. С multi-queue: по каждому
   * заказу берётся ТЕКУЩАЯ очередь и её первый незакрытый размер.
   */
  async getActiveBannerForOperation(
    operationId: string,
  ): Promise<OrderCutIssueRuleBannerDto> {
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      select: { id: true, category: true },
    });
    if (!operation) return { applicable: false, orders: [] };

    const isCutting = operation.category === OperationCategory.CUTTING;

    const activeRows = await this.prisma.orderCutIssueRule.findMany({
      where: { isActive: true },
      include: {
        size: { select: { id: true, code: true, sortOrder: true } },
        order: { select: { id: true, number: true, status: true } },
      },
    });
    if (activeRows.length === 0) return { applicable: false, orders: [] };

    const candidateRows = activeRows.filter(
      (r) =>
        r.issuedQty < r.requiredQty && r.order.status === 'IN_PRODUCTION',
    );
    if (candidateRows.length === 0) return { applicable: false, orders: [] };

    // Группируем по orderId, в каждой группе оставляем только
    // строки текущей очереди (минимальный queueIndex с незакрытой
    // активной строкой). Если у заказа в более ранней очереди есть
    // незакрытые строки — в баннер попадут именно они.
    const byOrder = new Map<string, typeof activeRows>();
    for (const row of activeRows) {
      const list = byOrder.get(row.orderId) ?? [];
      list.push(row);
      byOrder.set(row.orderId, list);
    }

    let allowedOrderIds: Set<string>;
    if (isCutting) {
      allowedOrderIds = new Set(byOrder.keys());
    } else {
      // Для не-CUTTING операции баннер показываем, если эта операция —
      // первый не-CUTTING шаг маршрута заказа (handoff из раскройного
      // цеха в швейный поток). Симметрично `evaluateForIssue`. Покрывает
      // и «sewing-only» маршруты (первый шаг — наш SEWING), и связки
      // CUT → CUT_DIVISION → SEWING.
      const orderIds = [...byOrder.keys()];
      const steps = await this.prisma.orderRouteStep.findMany({
        where: { orderId: { in: orderIds } },
        select: {
          orderId: true,
          operationId: true,
          operation: { select: { category: true } },
        },
        orderBy: [{ orderId: 'asc' }, { index: 'asc' }],
      });
      const firstNonCuttingOpByOrder = new Map<string, string>();
      for (const s of steps) {
        if (s.operation.category === OperationCategory.CUTTING) continue;
        if (firstNonCuttingOpByOrder.has(s.orderId)) continue;
        firstNonCuttingOpByOrder.set(s.orderId, s.operationId);
      }
      allowedOrderIds = new Set();
      for (const [oid, opId] of firstNonCuttingOpByOrder) {
        if (opId === operationId) allowedOrderIds.add(oid);
      }
    }
    if (allowedOrderIds.size === 0) {
      return { applicable: false, orders: [] };
    }

    const orderCards: OrderCutIssueRuleBannerOrderDto[] = [];
    for (const [orderId, rows] of byOrder) {
      if (!allowedOrderIds.has(orderId)) continue;
      const currentQueueIndex = this.computeCurrentQueueIndex(rows);
      if (currentQueueIndex === null) continue;
      const inCurrent = rows.filter(
        (r) =>
          r.queueIndex === currentQueueIndex &&
          r.isActive &&
          r.issuedQty < r.requiredQty,
      );
      if (inCurrent.length === 0) continue;
      const sorted = [...inCurrent].sort(this.compareRows);
      const top = sorted[0];

      const cellRows = await this.prisma.passport.groupBy({
        by: ['currentCellId'],
        where: {
          orderId,
          sizeId: top.sizeId,
          currentCellId: { not: null },
          status: { in: ['CREATED', 'IN_PROGRESS'] as const },
          currentEmployeeId: null,
        },
        _count: { _all: true },
      });
      const cellIds = cellRows
        .map((c) => c.currentCellId)
        .filter((id): id is string => !!id);
      const cellMeta = cellIds.length
        ? await this.prisma.cell.findMany({
            where: { id: { in: cellIds } },
            select: { id: true, code: true },
          })
        : [];
      const codeById = new Map(cellMeta.map((c) => [c.id, c.code]));

      const cells = cellRows
        .map((c) => ({
          cellId: c.currentCellId!,
          cellCode: codeById.get(c.currentCellId!) ?? c.currentCellId!,
          passportsCount: c._count._all,
        }))
        .sort((a, b) => a.cellCode.localeCompare(b.cellCode));

      orderCards.push({
        orderId,
        orderNumber: top.order.number,
        productLabel: null,
        queueIndex: top.queueIndex,
        currentSizeId: top.sizeId,
        currentSizeCode: top.size.code,
        remainingQty: Math.max(top.requiredQty - top.issuedQty, 0),
        requiredQty: top.requiredQty,
        issuedQty: top.issuedQty,
        cells,
      });
    }

    if (orderCards.length === 0) {
      return { applicable: false, orders: [] };
    }
    orderCards.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber));
    return { applicable: true, orders: orderCards };
  }
}
