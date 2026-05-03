import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { StockService } from '../stock/stock.service.js';
import {
  MaterialIssueLineDescriptionRequiredException,
  MaterialIssueLineUnitRequiredException,
  MaterialIssueLinesRequiredException,
  MaterialIssueNotDraftForCancelException,
  MaterialIssueNotDraftForPostException,
  MaterialIssueNotFoundException,
  MaterialIssuePassportNotInOrderException,
  MaterialIssuePostedCannotCancelException,
  MaterialIssueQtyRequiredException,
  MaterialIssueUnitCostInvalidException,
  MaterialIssueWorkshopNeedNotInOrderException,
  WorkshopNeedNotFoundException,
} from '../../common/errors.js';
import type {
  CreateMaterialIssueDto,
  CreateMaterialIssueLineDto,
} from './dto/create-material-issue.dto.js';
import type { ListMaterialIssuesQuery } from './dto/list-material-issues.dto.js';

/**
 * Жизненный цикл документа `MaterialIssue` (статусы хранятся как
 * `String` в БД — см. `prisma/schema.prisma`). Статусы фиксируются
 * здесь как локальные константы, чтобы не плодить shared-package
 * файл ради MVP-итерации.
 */
export const MATERIAL_ISSUE_STATUS = {
  DRAFT: 'DRAFT',
  POSTED: 'POSTED',
  CANCELLED: 'CANCELLED',
} as const;
export type MaterialIssueStatus =
  (typeof MATERIAL_ISSUE_STATUS)[keyof typeof MATERIAL_ISSUE_STATUS];

/**
 * Источник документа `MaterialIssue` — сервисная константа (см.
 * `prisma/schema.prisma::MaterialIssue.source`,
 * `packages/shared/src/material-issues.ts::MATERIAL_ISSUE_SOURCES`).
 *
 *   - `MANUAL`         — пользовательский `POST /api/material-issues`.
 *     DTO-слой клиент `source` не принимает, дефолт колонки в БД
 *     — `'MANUAL'`.
 *   - `AUTO_CUT_ISSUE` — автосписание в той же транзакции, что и
 *     `PassportsService.issueToEmployee`. Документ создаётся сразу
 *     `POSTED`, `sourceKey = AUTO_CUT_ISSUE:<passportId>` для
 *     идемпотентности retry.
 */
export const MATERIAL_ISSUE_SOURCE = {
  MANUAL: 'MANUAL',
  AUTO_CUT_ISSUE: 'AUTO_CUT_ISSUE',
} as const;
export type MaterialIssueSource =
  (typeof MATERIAL_ISSUE_SOURCE)[keyof typeof MATERIAL_ISSUE_SOURCE];

/**
 * Технический ключ идемпотентности для `source = AUTO_CUT_ISSUE`.
 * Храним в `MaterialIssue.sourceKey` (UNIQUE) — вставка дубля
 * ловится на уровне БД, retry тот же `issueToEmployee` не
 * создаёт второго автосписания.
 *
 * Формат умышленно «плоский» (`AUTO_CUT_ISSUE:<passportId>`), а не
 * JSON: одна колонка, легко читать в админке и в audit-payload.
 */
export function buildAutoCutIssueSourceKey(passportId: string): string {
  return `${MATERIAL_ISSUE_SOURCE.AUTO_CUT_ISSUE}:${passportId}`;
}

/**
 * Сервис «Фактический расход материалов по заказу» (MVP-итерация).
 *
 * Назначение:
 *   - дать менеджеру цеха ручную фиксацию расхода материала по
 *     заказу (`MaterialIssue` + `MaterialIssueLine[]`);
 *   - получить аналитический slice «фактический расход × заказ»;
 *   - провести / отменить документ в DRAFT.
 *
 * Сознательная граница MVP (см. ТЗ):
 *   - проведение документа пишет OUT-движение в foundation-склад
 *     (`StockService.recordMaterialIssueInTx`), но БЕЗ FIFO/LIFO,
 *     БЕЗ `MaterialStockLot` и БЕЗ проверки достаточности остатка —
 *     минус на `StockBalance.qty` допустим;
 *   - `MaterialIssue.totalCost` (финансовая оценка) и
 *     `StockMovement.totalCost` (складская оценка) живут
 *     независимо: OUT-движение использует текущий
 *     `StockBalance.unitCost`, документ остаётся считаться по
 *     `MaterialIssueLine.unitCost` (не пересчитывается после stock OUT);
 *   - НЕТ master-модели `Material`;
 *   - POSTED-документ нельзя отменить (сторнирующий reversal для
 *     MaterialIssue — отдельная будущая итерация).
 *
 * Аудит — три события под `entityType = MATERIAL_ISSUE`:
 *   `MATERIAL_ISSUE_CREATED` / `MATERIAL_ISSUE_POSTED` /
 *   `MATERIAL_ISSUE_CANCELLED`. Все пишутся в той же транзакции,
 *   что и сама мутация.
 */
@Injectable()
export class MaterialIssuesService {
  private readonly logger = new Logger(MaterialIssuesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------

  async create(
    dto: CreateMaterialIssueDto,
    employeeId: string | null | undefined,
  ): Promise<MaterialIssueDetail> {
    if (!dto.lines || dto.lines.length === 0) {
      throw new MaterialIssueLinesRequiredException();
    }

    const order = await this.prisma.order.findUnique({
      where: { id: dto.orderId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    if (dto.passportId) {
      const passport = await this.prisma.passport.findUnique({
        where: { id: dto.passportId },
        select: { id: true, orderId: true },
      });
      if (!passport) {
        throw new NotFoundException({
          code: 'PASSPORT_NOT_FOUND',
          message: 'Паспорт не найден',
        });
      }
      if (passport.orderId !== dto.orderId) {
        throw new MaterialIssuePassportNotInOrderException();
      }
    }

    const workshopNeedIds = Array.from(
      new Set(
        dto.lines
          .map((l) => l.workshopNeedId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    const needsById = new Map<
      string,
      {
        id: string;
        orderId: string;
        description: string;
        sourceName: string | null;
        materialRole: string | null;
        unit: string;
      }
    >();
    if (workshopNeedIds.length > 0) {
      const found = await this.prisma.workshopNeed.findMany({
        where: { id: { in: workshopNeedIds } },
        select: {
          id: true,
          orderId: true,
          description: true,
          sourceName: true,
          materialRole: true,
          unit: true,
        },
      });
      for (const n of found) needsById.set(n.id, n);
      for (const id of workshopNeedIds) {
        const need = needsById.get(id);
        if (!need) throw new WorkshopNeedNotFoundException();
        if (need.orderId !== dto.orderId) {
          throw new MaterialIssueWorkshopNeedNotInOrderException();
        }
      }
    }

    const cellIds = Array.from(
      new Set(
        dto.lines
          .map((l) => l.cellId)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    );
    if (cellIds.length > 0) {
      const found = await this.prisma.cell.findMany({
        where: { id: { in: cellIds } },
        select: { id: true },
      });
      const foundSet = new Set(found.map((c) => c.id));
      for (const cellId of cellIds) {
        if (!foundSet.has(cellId)) {
          throw new NotFoundException({
            code: 'CELL_NOT_FOUND',
            message: 'Ячейка не найдена',
          });
        }
      }
    }

    const prepared = dto.lines.map((line) =>
      this.prepareLine(line, needsById),
    );

    const totalCost = prepared.reduce(
      (acc, line) => acc.add(line.totalCost),
      new Prisma.Decimal(0),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const issue = await tx.materialIssue.create({
        data: {
          orderId: dto.orderId,
          passportId: dto.passportId ?? null,
          status: MATERIAL_ISSUE_STATUS.DRAFT,
          // Ручной create всегда `MANUAL`, `sourceKey = null`:
          // frontend DTO этих полей не принимает (см.
          // `CreateMaterialIssueSchema`), сервис выставляет их
          // явно. Автосписание при выдаче кроя идёт через отдельный
          // helper `createAutoCutIssueForPassport`.
          source: MATERIAL_ISSUE_SOURCE.MANUAL,
          sourceKey: null,
          totalCost,
          createdById: employeeId ?? null,
          lines: {
            create: prepared.map((line) => ({
              workshopNeedId: line.workshopNeedId,
              description: line.description,
              materialRole: line.materialRole,
              unit: line.unit,
              issuedQty: line.issuedQty,
              unitCost: line.unitCost,
              totalCost: line.totalCost,
              cellId: line.cellId,
              comment: line.comment,
            })),
          },
        },
        include: MATERIAL_ISSUE_DETAIL_INCLUDE,
      });

      await this.audit.log(
        {
          event: 'MATERIAL_ISSUE_CREATED',
          entityType: 'MATERIAL_ISSUE',
          entityId: issue.id,
          employeeId: employeeId ?? null,
          payload: this.buildAuditPayload(issue) as Prisma.InputJsonValue,
        },
        tx,
      );

      return issue;
    });

    this.logger.log(
      `event=material_issue.create id=${created.id} orderId=${created.orderId} ` +
        `passportId=${created.passportId ?? '-'} lines=${created.lines.length} ` +
        `totalCost=${created.totalCost.toString()}`,
    );

    return toDetail(created);
  }

  // ---------------------------------------------------------------------------
  // LIST / GET
  // ---------------------------------------------------------------------------

  async list(query: ListMaterialIssuesQuery): Promise<MaterialIssueListItem[]> {
    const where: Prisma.MaterialIssueWhereInput = {};
    if (query.orderId) where.orderId = query.orderId;
    if (query.passportId) where.passportId = query.passportId;
    if (query.status) where.status = query.status;

    const rows = await this.prisma.materialIssue.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: MATERIAL_ISSUE_LIST_INCLUDE,
    });
    return rows.map(toListItem);
  }

  async getById(id: string): Promise<MaterialIssueDetail> {
    const row = await this.prisma.materialIssue.findUnique({
      where: { id },
      include: MATERIAL_ISSUE_DETAIL_INCLUDE,
    });
    if (!row) throw new MaterialIssueNotFoundException();
    return toDetail(row);
  }

  async listByOrder(orderId: string): Promise<MaterialIssueListItem[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    return this.list({ orderId });
  }

  // ---------------------------------------------------------------------------
  // POST (provedenie / проведение)
  // ---------------------------------------------------------------------------

  async post(
    id: string,
    employeeId: string | null | undefined,
  ): Promise<MaterialIssueDetail> {
    const current = await this.prisma.materialIssue.findUnique({
      where: { id },
      include: { lines: true },
    });
    if (!current) throw new MaterialIssueNotFoundException();
    if (current.status !== MATERIAL_ISSUE_STATUS.DRAFT) {
      throw new MaterialIssueNotDraftForPostException();
    }

    const recomputedTotal = current.lines.reduce(
      (acc, line) => acc.add(line.totalCost),
      new Prisma.Decimal(0),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.materialIssue.update({
        where: { id },
        data: {
          status: MATERIAL_ISSUE_STATUS.POSTED,
          postedAt: new Date(),
          postedById: employeeId ?? null,
          totalCost: recomputedTotal,
        },
        include: MATERIAL_ISSUE_DETAIL_INCLUDE,
      });

      // Foundation складского учёта: исходящие движения по строкам
      // расхода. Идём в той же транзакции, чтобы либо «проведение
      // документа + OUT-движения», либо «ничего». Метод сам soft-
      // skip-ает строки без `workshopNeedId` / `unit` / `issuedQty <= 0`
      // и идемпотентен по `StockMovement.sourceKey`. Недостаток
      // остатка не блокируется — минус допустим (см. MVP-границы).
      await this.stock.recordMaterialIssueInTx(tx, next.id, employeeId ?? null);

      await this.audit.log(
        {
          event: 'MATERIAL_ISSUE_POSTED',
          entityType: 'MATERIAL_ISSUE',
          entityId: next.id,
          employeeId: employeeId ?? null,
          payload: {
            ...this.buildAuditPayload(next),
            previousStatus: current.status,
          } as Prisma.InputJsonValue,
        },
        tx,
      );

      return next;
    });

    this.logger.log(
      `event=material_issue.post id=${updated.id} totalCost=${updated.totalCost.toString()}`,
    );
    return toDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // CANCEL
  // ---------------------------------------------------------------------------

  async cancel(
    id: string,
    employeeId: string | null | undefined,
    reason?: string | null,
  ): Promise<MaterialIssueDetail> {
    const current = await this.prisma.materialIssue.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!current) throw new MaterialIssueNotFoundException();
    if (current.status === MATERIAL_ISSUE_STATUS.POSTED) {
      throw new MaterialIssuePostedCannotCancelException();
    }
    if (current.status !== MATERIAL_ISSUE_STATUS.DRAFT) {
      throw new MaterialIssueNotDraftForCancelException();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.materialIssue.update({
        where: { id },
        data: {
          status: MATERIAL_ISSUE_STATUS.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: employeeId ?? null,
          cancelReason: reason ?? null,
        },
        include: MATERIAL_ISSUE_DETAIL_INCLUDE,
      });

      await this.audit.log(
        {
          event: 'MATERIAL_ISSUE_CANCELLED',
          entityType: 'MATERIAL_ISSUE',
          entityId: next.id,
          employeeId: employeeId ?? null,
          payload: {
            ...this.buildAuditPayload(next),
            previousStatus: current.status,
            cancelReason: reason ?? null,
          } as Prisma.InputJsonValue,
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=material_issue.cancel id=${updated.id} reason=${reason ?? '-'}`,
    );
    return toDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private prepareLine(
    line: CreateMaterialIssueLineDto,
    needsById: Map<
      string,
      {
        id: string;
        description: string;
        sourceName: string | null;
        materialRole: string | null;
        unit: string;
      }
    >,
  ): {
    workshopNeedId: string | null;
    description: string;
    materialRole: string | null;
    unit: string;
    issuedQty: Prisma.Decimal;
    unitCost: Prisma.Decimal;
    totalCost: Prisma.Decimal;
    cellId: string | null;
    comment: string | null;
  } {
    const issuedQty = new Prisma.Decimal(line.issuedQty);
    if (issuedQty.lessThanOrEqualTo(0)) {
      throw new MaterialIssueQtyRequiredException();
    }
    const unitCost = new Prisma.Decimal(line.unitCost);
    if (unitCost.lessThan(0)) {
      throw new MaterialIssueUnitCostInvalidException();
    }

    let description = line.description?.trim() ?? '';
    let unit = line.unit?.trim() ?? '';
    let materialRole: string | null = null;
    let workshopNeedId: string | null = null;

    if (line.workshopNeedId) {
      const need = needsById.get(line.workshopNeedId);
      if (!need) {
        // По идее уже отловили выше; страховка от race-условий.
        throw new WorkshopNeedNotFoundException();
      }
      workshopNeedId = need.id;
      if (description.length === 0) {
        description = (need.description ?? need.sourceName ?? '').trim();
        if (description.length === 0) {
          // На уровне `WorkshopNeed.description` колонка NOT NULL,
          // но snapshot может быть пустой строкой — fallback на role.
          description = need.materialRole ?? 'Материал';
        }
      }
      if (unit.length === 0) {
        unit = (need.unit ?? '').trim();
      }
      materialRole = need.materialRole ?? null;
    }

    if (description.length === 0) {
      throw new MaterialIssueLineDescriptionRequiredException();
    }
    if (unit.length === 0) {
      throw new MaterialIssueLineUnitRequiredException();
    }

    const totalCost = issuedQty.mul(unitCost);

    return {
      workshopNeedId,
      description,
      materialRole,
      unit,
      issuedQty,
      unitCost,
      totalCost,
      cellId: line.cellId ?? null,
      comment: line.comment ?? null,
    };
  }

  private buildAuditPayload(
    issue: Prisma.MaterialIssueGetPayload<{
      include: typeof MATERIAL_ISSUE_DETAIL_INCLUDE;
    }>,
  ): Record<string, unknown> {
    return {
      materialIssueId: issue.id,
      orderId: issue.orderId,
      passportId: issue.passportId,
      status: issue.status,
      source: issue.source,
      sourceKey: issue.sourceKey,
      totalCost: issue.totalCost.toString(),
      lines: issue.lines.map((l) => ({
        id: l.id,
        workshopNeedId: l.workshopNeedId,
        description: l.description,
        materialRole: l.materialRole,
        unit: l.unit,
        issuedQty: l.issuedQty.toString(),
        unitCost: l.unitCost.toString(),
        totalCost: l.totalCost.toString(),
        cellId: l.cellId,
      })),
      timestamp: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // AUTO CUT ISSUE (автосписание материалов при выдаче кроя)
  //
  // См. ТЗ «Автосписание материалов при выдаче кроя» и
  // `apps/api/src/modules/passports/passports.service.ts::issueToEmployee`.
  // Вызывается ТОЛЬКО из `PassportsService.issueToEmployee`, внутри
  // активной транзакции — чтобы выдача паспорта и авто-документ
  // жили атомарно, а retry одного и того же issueToEmployee не
  // создавал дубли (UNIQUE `MaterialIssue.sourceKey`).
  //
  // Сознательные границы MVP-итерации:
  //   - НЕТ StockBalance / StockMovement / FIFO / LIFO;
  //   - НЕТ проверок складских остатков;
  //   - НЕТ master-модели Material;
  //   - POSTED-документ остаётся non-cancellable в этой итерации;
  //   - если у заказа нет подходящей WorkshopNeed / totalOrderQty
  //     не удалось посчитать / все строки дали issuedQty <= 0 —
  //     документ НЕ создаётся и issueToEmployee продолжает работать
  //     штатно (см. ТЗ §9 «Ошибки и устойчивость»).
  // ---------------------------------------------------------------------------

  /**
   * Создать автоматический `POSTED` `MaterialIssue` при выдаче кроя
   * сотруднику (см. `PassportsService.issueToEmployee`).
   *
   * Формула распределения (ТЗ §5):
   *
   *     issuedQty = WorkshopNeed.calculatedQty
   *                 * Passport.qtyCut
   *                 / totalOrderQty
   *
   * Где `totalOrderQty = Σ OrderItem.qtyPlan по orderId`
   * (канонический источник общего количества изделий в заказе —
   * `OrderItem.qtyPlan`; тот же агрегат используется `CutReadinessService`
   * и `WorkshopNeedsService`).
   *
   * Идемпотентность (ТЗ §2):
   *   1. Ищем существующий документ с `sourceKey = AUTO_CUT_ISSUE:<passportId>`
   *      — если есть, возвращаем `{ skipped: true, reason: 'already_exists' }`.
   *   2. Ищем любой неотменённый `MaterialIssue` (DRAFT/POSTED) по
   *      `passportId` — если есть ручной или другой авто-документ,
   *      повторно автосписывать не будем (чтобы не дублировать
   *      расход).
   *
   * Отбор строк (ТЗ §4): берём только `WorkshopNeed`, относящиеся к
   * материалам для производства:
   *   - исключаем `status = CANCELLED`;
   *   - исключаем `sourceType = ORDER_APPLICATION` (нанесение — это
   *     outsource-операция, не материал для кроя);
   *   - берём все остальные строки независимо от `materialRole`:
   *     `MAIN_FABRIC` / `LINING` / `THREAD` / … / `null` — всё
   *     входит в производственный расход.
   *
   * Цена (ТЗ §5 «unitCost»):
   *   - если `WorkshopNeed.quotedPrice` указана и валюта либо `RUB`,
   *     либо не задана (`null`) — берём это значение;
   *   - если валюта `USD` / любая не-RUB — `unitCost = 0`
   *     (конвертации в рубли на MVP нет);
   *   - если `quotedPrice` отсутствует — `unitCost = 0`.
   *
   * Если подходящих строк нет / `totalOrderQty <= 0` / всё даёт
   * `issuedQty <= 0` — возвращаем `{ skipped: true, reason: … }`
   * БЕЗ создания документа и БЕЗ ошибки (см. ТЗ §9).
   *
   * Audit: пишем `MATERIAL_ISSUE_CREATED` и `MATERIAL_ISSUE_POSTED`
   * в той же транзакции (см. ТЗ §8), payload содержит `source`,
   * `sourceKey`, `calculation` (`totalOrderQty`, `passportQtyCut`,
   * формулу).
   *
   * @param tx           Транзакционный клиент `issueToEmployee`-а.
   *                     Обязателен: открывать здесь независимую
   *                     транзакцию нельзя (см. ТЗ §7).
   * @param passportId   id паспорта, который только что выдали.
   * @param employeeId   Сотрудник, получающий крой (createdById /
   *                     postedById авто-документа — он же).
   */
  async createAutoCutIssueForPassport(
    tx: Prisma.TransactionClient,
    passportId: string,
    employeeId: string,
  ): Promise<
    | { created: true; materialIssueId: string; totalCost: string; linesCount: number }
    | { skipped: true; reason: AutoCutIssueSkipReason }
  > {
    const sourceKey = buildAutoCutIssueSourceKey(passportId);

    // 1) Идемпотентность по sourceKey — повторный retry того же
    //    issueToEmployee не создаёт дубль.
    const existingBySourceKey = await tx.materialIssue.findUnique({
      where: { sourceKey },
      select: { id: true },
    });
    if (existingBySourceKey) {
      this.logger.log(
        `event=material_issue.auto.skip reason=source_key_exists passportId=${passportId} materialIssueId=${existingBySourceKey.id}`,
      );
      return { skipped: true, reason: 'source_key_exists' };
    }

    // 2) Уже есть ручной или другой неотменённый документ по этому
    //    паспорту — не дублируем расход автосписанием.
    const existingByPassport = await tx.materialIssue.findFirst({
      where: {
        passportId,
        status: {
          in: [MATERIAL_ISSUE_STATUS.DRAFT, MATERIAL_ISSUE_STATUS.POSTED],
        },
      },
      select: { id: true, status: true, source: true },
    });
    if (existingByPassport) {
      this.logger.log(
        `event=material_issue.auto.skip reason=passport_already_has_issue passportId=${passportId} materialIssueId=${existingByPassport.id} status=${existingByPassport.status} source=${existingByPassport.source}`,
      );
      return { skipped: true, reason: 'passport_already_has_issue' };
    }

    const passport = await tx.passport.findUnique({
      where: { id: passportId },
      select: { id: true, orderId: true, qtyCut: true },
    });
    if (!passport) {
      // На практике issueToEmployee уже прочитал паспорт. Но в
      // изоляции снятого состояния предохраняемся — безопасный
      // skip вместо бросания из авто-помощника.
      this.logger.warn(
        `event=material_issue.auto.skip reason=passport_not_found passportId=${passportId}`,
      );
      return { skipped: true, reason: 'passport_not_found' };
    }
    if (passport.qtyCut <= 0) {
      return { skipped: true, reason: 'passport_qty_zero' };
    }

    // totalOrderQty = Σ OrderItem.qtyPlan по orderId. Канонический
    // источник, тот же, что используется в `CutReadinessService` и
    // `WorkshopNeedsService` — `Order.items[].qtyPlan`. Поле
    // `quantity` в проекте НЕ существует: размерная матрица
    // раскладывается через OrderItem.
    const orderItems = await tx.orderItem.findMany({
      where: { orderId: passport.orderId },
      select: { qtyPlan: true },
    });
    const totalOrderQty = orderItems.reduce(
      (acc, it) => acc + (it.qtyPlan ?? 0),
      0,
    );
    if (totalOrderQty <= 0) {
      this.logger.warn(
        `event=material_issue.auto.skip reason=total_order_qty_zero passportId=${passportId} orderId=${passport.orderId}`,
      );
      return { skipped: true, reason: 'total_order_qty_zero' };
    }

    // Материальные потребности цеха, попадающие в автосписание.
    // Исключаем нанесения (outsource) и отменённые строки. Оставляем
    // всё остальное — materialRole может быть `null` (например, у
    // PATTERN_SIZE_PARAMETER_VALUE), и это нормально.
    const needs = await tx.workshopNeed.findMany({
      where: {
        orderId: passport.orderId,
        status: { not: 'CANCELLED' },
        sourceType: { not: 'ORDER_APPLICATION' },
      },
      select: {
        id: true,
        description: true,
        sourceName: true,
        materialRole: true,
        unit: true,
        calculatedQty: true,
        quotedPrice: true,
        quotedCurrency: true,
      },
    });
    if (needs.length === 0) {
      this.logger.log(
        `event=material_issue.auto.skip reason=no_material_needs passportId=${passportId} orderId=${passport.orderId}`,
      );
      return { skipped: true, reason: 'no_material_needs' };
    }

    const passportQtyCut = new Prisma.Decimal(passport.qtyCut);
    const totalQtyDec = new Prisma.Decimal(totalOrderQty);
    const preparedLines: Array<{
      workshopNeedId: string;
      description: string;
      materialRole: string | null;
      unit: string;
      issuedQty: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      totalCost: Prisma.Decimal;
      cellId: null;
      comment: string | null;
    }> = [];

    for (const need of needs) {
      // issuedQty = calculatedQty * qtyCut / totalOrderQty
      // округляем до 4 знаков (совпадает с `MaterialIssueLine.issuedQty`
      // precision — Decimal(14,4), см. schema.prisma).
      const rawQty = need.calculatedQty
        .mul(passportQtyCut)
        .div(totalQtyDec);
      const issuedQty = rawQty.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
      if (issuedQty.lessThanOrEqualTo(0)) continue;

      const unitCost = resolveAutoIssueUnitCost(
        need.quotedPrice,
        need.quotedCurrency,
      );
      const totalCost = issuedQty
        .mul(unitCost)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

      // description-fallback как у ручного create (prepareLine).
      let description = (need.description ?? '').trim();
      if (description.length === 0) {
        description = (need.sourceName ?? '').trim();
      }
      if (description.length === 0) {
        description = need.materialRole ?? 'Материал';
      }

      preparedLines.push({
        workshopNeedId: need.id,
        description,
        materialRole: need.materialRole ?? null,
        unit: need.unit,
        issuedQty,
        unitCost,
        totalCost,
        cellId: null,
        comment: 'Автоматически при выдаче кроя',
      });
    }

    if (preparedLines.length === 0) {
      this.logger.log(
        `event=material_issue.auto.skip reason=all_lines_zero passportId=${passportId} orderId=${passport.orderId}`,
      );
      return { skipped: true, reason: 'all_lines_zero' };
    }

    const totalCost = preparedLines.reduce(
      (acc, l) => acc.add(l.totalCost),
      new Prisma.Decimal(0),
    );

    const now = new Date();
    const issue = await tx.materialIssue.create({
      data: {
        orderId: passport.orderId,
        passportId: passport.id,
        status: MATERIAL_ISSUE_STATUS.POSTED,
        source: MATERIAL_ISSUE_SOURCE.AUTO_CUT_ISSUE,
        sourceKey,
        totalCost,
        createdAt: now,
        postedAt: now,
        createdById: employeeId,
        postedById: employeeId,
        lines: {
          create: preparedLines.map((l) => ({
            workshopNeedId: l.workshopNeedId,
            description: l.description,
            materialRole: l.materialRole,
            unit: l.unit,
            issuedQty: l.issuedQty,
            unitCost: l.unitCost,
            totalCost: l.totalCost,
            cellId: l.cellId,
            comment: l.comment,
          })),
        },
      },
      include: MATERIAL_ISSUE_DETAIL_INCLUDE,
    });

    const calculationPayload = {
      totalOrderQty,
      passportQtyCut: passport.qtyCut,
      formula: 'WorkshopNeed.calculatedQty * Passport.qtyCut / totalOrderQty',
    };

    await this.audit.log(
      {
        event: 'MATERIAL_ISSUE_CREATED',
        entityType: 'MATERIAL_ISSUE',
        entityId: issue.id,
        employeeId,
        payload: {
          ...this.buildAuditPayload(issue),
          employeeId,
          calculation: calculationPayload,
        } as Prisma.InputJsonValue,
      },
      tx,
    );
    await this.audit.log(
      {
        event: 'MATERIAL_ISSUE_POSTED',
        entityType: 'MATERIAL_ISSUE',
        entityId: issue.id,
        employeeId,
        payload: {
          ...this.buildAuditPayload(issue),
          previousStatus: MATERIAL_ISSUE_STATUS.DRAFT,
          employeeId,
          calculation: calculationPayload,
        } as Prisma.InputJsonValue,
      },
      tx,
    );

    // Foundation складского учёта: исходящие движения по строкам
    // авто-документа. В той же транзакции, что и `issueToEmployee` —
    // либо «выдача кроя + авто-документ + OUT-движения», либо
    // «ничего». Авто-строки обычно без `cellId` (см. preparedLines
    // выше), поэтому `StockService` сам выбирает balance: самый
    // большой положительный по `(workshopNeedId, unit)` или
    // no-location, если положительного нет (см.
    // `StockService.recordMaterialIssueInTx`). Недостаток остатка не
    // блокирует `issueToEmployee` — минус допустим.
    await this.stock.recordMaterialIssueInTx(tx, issue.id, employeeId);

    this.logger.log(
      `event=material_issue.auto.created materialIssueId=${issue.id} passportId=${passport.id} orderId=${passport.orderId} ` +
        `totalOrderQty=${totalOrderQty} qtyCut=${passport.qtyCut} lines=${preparedLines.length} totalCost=${totalCost.toString()}`,
    );

    return {
      created: true,
      materialIssueId: issue.id,
      totalCost: totalCost.toString(),
      linesCount: preparedLines.length,
    };
  }
}

/**
 * Резолв `unitCost` для строки автосписания на MVP:
 *   - `quotedPrice == null`         → `0`;
 *   - `quotedPrice < 0`             → `0` (защита от мусорных данных);
 *   - валюта не задана (`null`)     → считаем рубли, берём `quotedPrice`;
 *   - валюта `RUB`                   → берём `quotedPrice`;
 *   - любая другая валюта (USD, …) → `0` (конвертации на MVP нет,
 *     см. `docs/current-state.md §«Auto cut issue»`).
 *
 * Возвращаем Decimal сразу с точностью 2 знака — согласовано с
 * `MaterialIssueLine.unitCost` (`Decimal(14,2)`).
 */
function resolveAutoIssueUnitCost(
  quotedPrice: Prisma.Decimal | null,
  quotedCurrency: string | null,
): Prisma.Decimal {
  if (quotedPrice == null) return new Prisma.Decimal(0);
  if (quotedPrice.lessThan(0)) return new Prisma.Decimal(0);
  const currency = (quotedCurrency ?? '').trim().toUpperCase();
  if (currency && currency !== 'RUB') return new Prisma.Decimal(0);
  return quotedPrice.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Причина skip у `createAutoCutIssueForPassport`. Не часть публичного
 * API — используется в логах и тестах, чтобы отличить «не было
 * потребностей» от «retry после первого auto issue».
 */
export type AutoCutIssueSkipReason =
  | 'source_key_exists'
  | 'passport_already_has_issue'
  | 'passport_not_found'
  | 'passport_qty_zero'
  | 'total_order_qty_zero'
  | 'no_material_needs'
  | 'all_lines_zero';

// ---------------------------------------------------------------------------
// includes / DTOs (источник истины для list / get)
// ---------------------------------------------------------------------------

const MATERIAL_ISSUE_LIST_INCLUDE = {
  order: { select: { id: true, number: true, status: true } },
  passport: { select: { id: true, number: true } },
  lines: {
    orderBy: [{ id: 'asc' }] as const,
  },
} as const satisfies Prisma.MaterialIssueInclude;

const MATERIAL_ISSUE_DETAIL_INCLUDE = {
  order: { select: { id: true, number: true, status: true } },
  passport: { select: { id: true, number: true } },
  lines: {
    orderBy: [{ id: 'asc' }] as const,
    include: {
      workshopNeed: {
        select: {
          id: true,
          description: true,
          materialRole: true,
          unit: true,
        },
      },
      cell: {
        select: { id: true, code: true },
      },
    },
  },
} as const satisfies Prisma.MaterialIssueInclude;

export interface MaterialIssueLineDetail {
  id: string;
  workshopNeedId: string | null;
  workshopNeed: {
    id: string;
    description: string;
    materialRole: string | null;
    unit: string;
  } | null;
  description: string;
  materialRole: string | null;
  unit: string;
  issuedQty: string;
  unitCost: string;
  totalCost: string;
  cellId: string | null;
  cellCode: string | null;
  comment: string | null;
}

export interface MaterialIssueDetail {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  passportId: string | null;
  passportNumber: string | null;
  status: MaterialIssueStatus;
  /**
   * Источник документа (`MANUAL` | `AUTO_CUT_ISSUE`, см.
   * `MATERIAL_ISSUE_SOURCE`). Технический `sourceKey` в ответе
   * НЕ отдаём — это внутренний ключ идемпотентности.
   */
  source: MaterialIssueSource;
  totalCost: string;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  createdById: string | null;
  postedById: string | null;
  cancelledById: string | null;
  cancelReason: string | null;
  lines: MaterialIssueLineDetail[];
}

export interface MaterialIssueListItem {
  id: string;
  orderId: string;
  orderNumber: string;
  passportId: string | null;
  passportNumber: string | null;
  status: MaterialIssueStatus;
  source: MaterialIssueSource;
  totalCost: string;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  linesCount: number;
}

function toListItem(
  row: Prisma.MaterialIssueGetPayload<{
    include: typeof MATERIAL_ISSUE_LIST_INCLUDE;
  }>,
): MaterialIssueListItem {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? '',
    passportId: row.passportId,
    passportNumber: row.passport?.number ?? null,
    status: row.status as MaterialIssueStatus,
    source: row.source as MaterialIssueSource,
    totalCost: row.totalCost.toString(),
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    linesCount: row.lines.length,
  };
}

function toDetail(
  row: Prisma.MaterialIssueGetPayload<{
    include: typeof MATERIAL_ISSUE_DETAIL_INCLUDE;
  }>,
): MaterialIssueDetail {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order?.number ?? '',
    orderStatus: row.order?.status ?? '',
    passportId: row.passportId,
    passportNumber: row.passport?.number ?? null,
    status: row.status as MaterialIssueStatus,
    source: row.source as MaterialIssueSource,
    totalCost: row.totalCost.toString(),
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdById: row.createdById,
    postedById: row.postedById,
    cancelledById: row.cancelledById,
    cancelReason: row.cancelReason,
    lines: row.lines.map(
      (l): MaterialIssueLineDetail => ({
        id: l.id,
        workshopNeedId: l.workshopNeedId,
        workshopNeed: l.workshopNeed
          ? {
              id: l.workshopNeed.id,
              description: l.workshopNeed.description,
              materialRole: l.workshopNeed.materialRole,
              unit: l.workshopNeed.unit,
            }
          : null,
        description: l.description,
        materialRole: l.materialRole,
        unit: l.unit,
        issuedQty: l.issuedQty.toString(),
        unitCost: l.unitCost.toString(),
        totalCost: l.totalCost.toString(),
        cellId: l.cellId,
        cellCode: l.cell?.code ?? null,
        comment: l.comment,
      }),
    ),
  };
}
