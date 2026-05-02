import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OperationCategory } from '@prisma/client';
import {
  formatOrderCutIssueRuleViolationMessage,
  type BulkUpsertOrderCutIssueRulesDto,
  type OrderCutIssueRuleDto,
  type OrderCutIssueRuleStatus,
  type OrderCutIssueRulesSummaryDto,
} from '@sewing/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  OrderCutIssueRuleRequiredAbovePlanException,
  OrderCutIssueRuleRequiredBelowIssuedException,
  OrderCutIssueRuleSizeNotInOrderException,
  OrderCutIssueRuleViolationException,
} from '../../common/errors.js';
import type { AuthPrincipal } from '../auth/auth.types.js';

/**
 * Сервис «Очередь выдачи кроя по размерам» (см.
 * `prisma/schema.prisma::OrderCutIssueRule`,
 * `docs/domain.md §«Очередь выдачи кроя»`,
 * `docs/order-flow.md §«Очередь выдачи кроя»`,
 * `docs/production-flow.md §«Issue: очередь выдачи кроя»`).
 *
 * Контракт:
 *   - `listForOrder(orderId)` — отдать список строк очереди заказа +
 *     derived-сводку для UI карточки заказа;
 *   - `bulkUpsert(actor, orderId, dto)` — сохранить форму карточки:
 *     upsert по `(orderId, sizeId)`, остальные активные строки
 *     заказа гасит `isActive = false` (bulk = source of truth формы);
 *   - `disableAll(actor, orderId)` — атомарно `isActive = false`
 *     для всех строк заказа;
 *   - `evaluateForIssue(passport, operationCategory)` — pre-check для
 *     `PassportsService.issueToEmployee`: возвращает evaluation с
 *     id строки + `requiredQty / issuedQty`, либо `null`, если
 *     правило не применимо (нет активных, все выполнены, не первая
 *     операция / не CUTTING);
 *   - `consumeInTx(tx, evaluation, ...)` — атомарный инкремент
 *     `issuedQty` через conditional `updateMany`. Если 0 строк
 *     обновлено (race с другой выдачей или с deactivate) —
 *     перечитываем актуальное состояние и кидаем VIOLATION с
 *     актуальным сообщением.
 *
 * Что сервис НЕ делает:
 *   - не пишет `PassportEvent` (модель события не имеет смысла —
 *     consumed-инкремент уже фиксируется в audit-логе и в самой
 *     строке очереди);
 *   - не сбрасывает `issuedQty` при `disableAll` или при апдейте
 *     строки (см. ТЗ §«Ограничения» — reset counters out of scope);
 *   - не делает advisory locks (атомарность гарантирует conditional
 *     `updateMany`, как у `CutReleasePolicy`).
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
    // Стабильная сортировка: пользовательский `sortOrder`, затем
    // справочный `Size.sortOrder`, затем `Size.code` для полного
    // детерминизма (на MVP `sortOrder` обычно нулевой).
    rows.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.size.sortOrder !== b.size.sortOrder)
        return a.size.sortOrder - b.size.sortOrder;
      return a.size.code.localeCompare(b.size.code);
    });
    const dtos = rows.map((r) => this.toDto(r));
    return {
      orderId,
      status: this.computeStatus(dtos),
      rules: dtos,
    };
  }

  // -------------------------------------------------------------------------
  // BULK UPSERT
  // -------------------------------------------------------------------------

  /**
   * Сохранить bulk-форму очереди (источник истины формы карточки
   * заказа). Контракт:
   *
   *   - проверяем, что заказ существует;
   *   - проверяем, что каждый `sizeId` из `rows` встречается в
   *     `OrderItem` этого заказа (иначе 400
   *     `ORDER_CUT_ISSUE_RULE_SIZE_NOT_IN_ORDER`);
   *   - для каждого размера считаем `qtyPlanBySize = Σ qtyPlan по
   *     OrderItem(orderId, sizeId)` и проверяем, что
   *     `requiredQty <= qtyPlan` (иначе 422
   *     `ORDER_CUT_ISSUE_RULE_REQUIRED_ABOVE_PLAN`);
   *   - для каждой уже существующей строки убеждаемся, что новый
   *     `requiredQty >= issuedQty` (иначе 422
   *     `ORDER_CUT_ISSUE_RULE_REQUIRED_BELOW_ISSUED`);
   *   - в одной транзакции upsert-им строки и переводим в
   *     `isActive = false` все активные строки заказа, которых нет
   *     в `rows` (сама форма — source of truth).
   *
   * Audit `ORDER_CUT_ISSUE_RULE_UPSERT` пишется одним событием на
   * заказ, payload содержит сводку: count добавленных / обновлённых
   * / деактивированных строк + список после сохранения.
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

    // Σ qtyPlan по размеру (на одном size может быть несколько
    // OrderItem с разными productId; на MVP обычно один — но
    // сумма всё равно корректна).
    const qtyPlanBySize = new Map<string, number>();
    for (const it of order.items) {
      qtyPlanBySize.set(
        it.sizeId,
        (qtyPlanBySize.get(it.sizeId) ?? 0) + it.qtyPlan,
      );
    }

    // Подтянем существующие строки сразу — это нужно и для
    // (а) проверки `requiredQty >= issuedQty`, и для (б) дешёвой
    // диагностики «какие строки деактивируются» в audit-payload.
    const existingRows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId },
      include: { size: { select: { code: true } } },
    });
    const existingBySizeId = new Map(existingRows.map((r) => [r.sizeId, r]));

    // Подтянем коды размеров из dto одним запросом — нужно для
    // понятных сообщений ошибок («Размер 4XL не входит в заказ»).
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
        // Размер не входит в заказ. Если это известный размер из
        // справочника — отдадим его код для понятного сообщения;
        // если нет — валится без кода (это ещё и страховка от
        // подмены id).
        throw new OrderCutIssueRuleSizeNotInOrderException(
          sizeCodeById.get(row.sizeId),
        );
      }
      if (row.requiredQty > planQty) {
        throw new OrderCutIssueRuleRequiredAbovePlanException(
          sizeCodeById.get(row.sizeId) ?? row.sizeId,
          planQty,
        );
      }
      const existing = existingBySizeId.get(row.sizeId);
      if (existing && row.requiredQty < existing.issuedQty) {
        throw new OrderCutIssueRuleRequiredBelowIssuedException(
          sizeCodeById.get(row.sizeId) ?? row.sizeId,
        );
      }
    }

    const dtoSizeIdSet = new Set(dtoSizeIds);
    const toDeactivate = existingRows.filter(
      (r) => r.isActive && !dtoSizeIdSet.has(r.sizeId),
    );

    // -- WRITE --------------------------------------------------------------

    await this.prisma.$transaction(async (tx) => {
      for (const row of dto.rows) {
        const existing = existingBySizeId.get(row.sizeId);
        if (existing) {
          await tx.orderCutIssueRule.update({
            where: { id: existing.id },
            data: {
              requiredQty: row.requiredQty,
              sortOrder: row.sortOrder ?? existing.sortOrder,
              // Любое явное сохранение строки в форме — это «активная»
              // строка. Если менеджер хочет деактивировать строку, он
              // должен убрать её из формы (или нажать «Отключить
              // очередь»).
              isActive: true,
            },
          });
        } else {
          await tx.orderCutIssueRule.create({
            data: {
              orderId,
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
      `event=orderCutIssueRule.upsert orderId=${orderId} actor=${actor.employeeId} rows=${dto.rows.length} deactivated=${toDeactivate.length}`,
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
      // Идемпотентность: если активных не было — не плодим audit-дубль.
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
  // EVALUATE / CONSUME (горячий путь, вызывается из PassportsService)
  // -------------------------------------------------------------------------

  /**
   * Pre-check очереди для `PassportsService.issueToEmployee`.
   *
   * Возвращает `null`, если правило не применимо к этому issue:
   *   - нет ни одной активной строки очереди заказа;
   *   - все активные строки выполнены (`issuedQty >= requiredQty`);
   *   - операция активной смены НЕ из категории `CUTTING` И у
   *     паспорта `currentRouteStepIndex !== 0` (Stage 3-семантика
   *     «только первая операция / CUTTING», см. ТЗ §6).
   *
   * Если есть незавершённые активные строки и паспорт ИХ размера —
   * возвращаем evaluation с конкретной строкой, которую дальше
   * консумит `consumeInTx`. Если паспорт «не очередного» размера —
   * сразу `OrderCutIssueRuleViolationException` с человекочитаемым
   * сообщением.
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
    requiredQty: number;
    issuedQtyBefore: number;
    sizeCode: string;
  } | null> {
    const isFirstRouteStep = passport.currentRouteStepIndex === 0;
    const isCuttingOperation = operationCategory === OperationCategory.CUTTING;
    if (!isFirstRouteStep && !isCuttingOperation) {
      // Сознательно: ограничение действует только на первую выдачу
      // кроя. Дальнейшие движения по маршруту (`scan` /
      // `complete-operation`) очередь не трогает (см. ТЗ §6,
      // зеркально CutReleasePolicy).
      return null;
    }

    const activeRows = await this.prisma.orderCutIssueRule.findMany({
      where: { orderId: passport.orderId, isActive: true },
      include: { size: { select: { code: true, sortOrder: true } } },
    });
    if (activeRows.length === 0) return null;

    const unfinishedRows = activeRows.filter(
      (r) => r.issuedQty < r.requiredQty,
    );
    if (unfinishedRows.length === 0) {
      // Все активные строки выполнены — очередь «гаснет сама».
      return null;
    }

    const matched = unfinishedRows.find((r) => r.sizeId === passport.sizeId);
    if (!matched) {
      // Паспорт «не очередного» размера — блокируем с понятным
      // списком, что осталось выдать. Сортировка та же, что в
      // `listForOrder` — UI и сообщение должны выглядеть
      // одинаково.
      const sortedUnfinished = [...unfinishedRows].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (a.size.sortOrder !== b.size.sortOrder)
          return a.size.sortOrder - b.size.sortOrder;
        return a.size.code.localeCompare(b.size.code);
      });
      throw new OrderCutIssueRuleViolationException(
        formatOrderCutIssueRuleViolationMessage(
          sortedUnfinished.map((r) => ({
            sizeCode: r.size.code,
            remainingQty: Math.max(r.requiredQty - r.issuedQty, 0),
          })),
        ),
      );
    }

    const remaining = matched.requiredQty - matched.issuedQty;
    if (passport.qtyCut > remaining) {
      // Паспорт того же размера, но «лишние» штуки за пределами
      // оставшегося лимита очереди — тоже блокируем. Сообщение
      // показывает остаток именно по этому размеру (плюс другие
      // незавершённые строки, чтобы менеджер видел весь контекст).
      const sortedUnfinished = [...unfinishedRows].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (a.size.sortOrder !== b.size.sortOrder)
          return a.size.sortOrder - b.size.sortOrder;
        return a.size.code.localeCompare(b.size.code);
      });
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
   * срабатывает только если строка всё ещё активна и лимит не
   * будет превышен (`issuedQty + qty <= requiredQty`). Если 0
   * строк обновлено — гонка по `issuedQty` или строку успели
   * деактивировать; перечитываем актуальное состояние очереди
   * заказа и бросаем VIOLATION с актуальным сообщением.
   *
   * Audit-событие `ORDER_CUT_ISSUE_RULE_CONSUMED` пишется в той же
   * транзакции — `entityType = ORDER_CUT_ISSUE_RULE`,
   * `entityId = ruleId`. Payload содержит `passportId` / `qty` /
   * `beforeIssued` / `afterIssued` / `sizeCode` / `orderId`.
   */
  async consumeInTx(
    tx: Prisma.TransactionClient,
    evaluation: {
      ruleId: string;
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
      // Между pre-check и transaction'ом строку либо погасили
      // (`isActive = false`), либо «съел» остаток другой паспорт.
      // Перечитываем актуальное состояние и бросаем VIOLATION
      // ровно с тем текстом, который покажем рабочему.
      const fresh = await tx.orderCutIssueRule.findMany({
        where: { orderId: op.orderId, isActive: true },
        include: { size: { select: { code: true, sortOrder: true } } },
      });
      const unfinished = fresh.filter((r) => r.issuedQty < r.requiredQty);
      if (unfinished.length === 0) {
        // Очередь «погасла» между pre-check и tx — выдача стала
        // свободной. Это не ошибка для UX (паспорт прошёл бы и
        // без правила), но мы УЖЕ начали транзакцию и должны её
        // откатить, чтобы счётчик не разъехался. Для простоты
        // отдадим VIOLATION с понятным текстом «правило стало
        // неактуально, попробуйте ещё раз» — fronted покажет его
        // как inline, и швея просто сделает второй scan.
        throw new OrderCutIssueRuleViolationException(
          'Очередь выдачи изменилась — повторите получение кроя.',
        );
      }
      const sortedUnfinished = [...unfinished].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        if (a.size.sortOrder !== b.size.sortOrder)
          return a.size.sortOrder - b.size.sortOrder;
        return a.size.code.localeCompare(b.size.code);
      });
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
  // mapping
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

  private computeStatus(
    rules: OrderCutIssueRuleDto[],
  ): OrderCutIssueRuleStatus {
    const active = rules.filter((r) => r.isActive);
    if (active.length === 0) return 'OFF';
    const allDone = active.every((r) => r.issuedQty >= r.requiredQty);
    return allDone ? 'DONE' : 'IN_PROGRESS';
  }
}
