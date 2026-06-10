import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CompanySettingsService } from '../company-settings/company-settings.service.js';
import { StockService } from '../stock/stock.service.js';
import {
  MaterialIssueAlreadyReturnedException,
  MaterialIssueLineDescriptionRequiredException,
  MaterialIssueLineUnitRequiredException,
  MaterialIssueLinesRequiredException,
  MaterialIssueNotDraftForCancelException,
  MaterialIssueNotDraftForPostException,
  MaterialIssueNotFoundException,
  MaterialIssueNothingToReturnException,
  MaterialIssuePassportNotInOrderException,
  MaterialIssuePostedCannotCancelException,
  MaterialIssueQtyRequiredException,
  MaterialIssueReturnDuplicateLineException,
  MaterialIssueReturnLineNotFoundException,
  MaterialIssueReturnOnlyPostedException,
  MaterialIssueReturnQtyExceedsAvailableException,
  MaterialIssueUnitCostInvalidException,
  MaterialIssueWorkshopNeedNotInOrderException,
  WorkshopNeedNotFoundException,
} from '../../common/errors.js';
import type {
  CreateMaterialIssueDto,
  CreateMaterialIssueLineDto,
} from './dto/create-material-issue.dto.js';
import type { ListMaterialIssuesQuery } from './dto/list-material-issues.dto.js';
import type { ReturnMaterialIssueDto } from './dto/return-material-issue.dto.js';

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
 * Префиксы `MaterialIssueReturn.sourceKey` (UNIQUE, см.
 * `prisma/schema.prisma::MaterialIssueReturn.sourceKey`).
 *
 *   - `MATERIAL_ISSUE_RETURN_FULL:<materialIssueId>` — для полного
 *     сторно без `clientRequestId`. Защищает от двойного полного
 *     возврата (повторный запрос вернёт уже созданный документ);
 *   - `MATERIAL_ISSUE_RETURN:<materialIssueId>:<clientRequestId>` —
 *     если UI передал свой `clientRequestId` (рекомендуется: один
 *     UUID на одну форму, см. UI).
 */
export const MATERIAL_ISSUE_RETURN_SOURCE_KEY_PREFIX = {
  FULL: 'MATERIAL_ISSUE_RETURN_FULL',
  WITH_REQUEST: 'MATERIAL_ISSUE_RETURN',
} as const;

/**
 * Сгенерировать `MaterialIssueReturn.sourceKey` для идемпотентного
 * `POST /api/material-issues/:id/return`. Если клиент передал
 * `clientRequestId` — используем форму с ним (форма UI генерит UUID
 * на каждое открытие); иначе — «полное сторно по этому документу»,
 * UNIQUE-индекс защитит от случайного двойного полного возврата.
 */
export function buildMaterialIssueReturnSourceKey(
  materialIssueId: string,
  clientRequestId?: string | null,
): string {
  const trimmed =
    typeof clientRequestId === 'string' ? clientRequestId.trim() : '';
  if (trimmed.length > 0) {
    return `${MATERIAL_ISSUE_RETURN_SOURCE_KEY_PREFIX.WITH_REQUEST}:${materialIssueId}:${trimmed}`;
  }
  return `${MATERIAL_ISSUE_RETURN_SOURCE_KEY_PREFIX.FULL}:${materialIssueId}`;
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
 * Сознательная граница MVP (см. ТЗ,
 * `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`):
 *   - проведение документа пишет OUT-движение в foundation-склад
 *     (`StockService.recordMaterialIssueInTx`), БЕЗ FIFO/LIFO и
 *     БЕЗ `MaterialStockLot`;
 *   - проверка достаточности остатка управляется hardening-флагом
 *     `CompanySettings.allowNegativeMaterialStock` (default `true`).
 *     `true` — минус на `StockBalance.qty` допустим (foundation,
 *     текущее MVP-поведение). `false` — `post` и `AUTO_CUT_ISSUE`
 *     падают 409 `MATERIAL_STOCK_INSUFFICIENT` при нехватке остатка,
 *     транзакция целиком откатывается: `MaterialIssue` остаётся
 *     `DRAFT`, OUT-движение не пишется, `StockBalance` не меняется
 *     (для авто-выдачи кроя — `PassportsService.issueToEmployee`
 *     тоже откатывается);
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
    private readonly companySettings: CompanySettingsService,
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

    // Hardening-флаг (см.
    // `prisma/schema.prisma::CompanySettings.allowNegativeMaterialStock`,
    // `prisma/schema.prisma::CompanyDivision.allowNegativeMaterialStockOverride`,
    // `apps/api/src/modules/company-settings/company-settings.service.ts::getEffectiveMaterialStockSettingsForOrder`,
    // `docs/current-state.md §«Материалы и склад — division overrides»`).
    // Читаем ДО открытия транзакции: effective-resolver делает только
    // SELECT-ы и не пишет ни `CompanySettings`, ни `CompanyDivision`.
    // Порядок разрешения:
    //   division.allowNegativeMaterialStockOverride
    //     ?? companySettings.allowNegativeMaterialStock
    //     ?? true
    // При `false` `StockService.recordMaterialIssueInTx` бросит
    // `MATERIAL_STOCK_INSUFFICIENT` (409) при нехватке остатка, и
    // транзакция откатится целиком: `MaterialIssue` останется `DRAFT`,
    // OUT-движение не создастся, `StockBalance` не изменится.
    const effective =
      await this.companySettings.getEffectiveMaterialStockSettingsForOrder(
        current.orderId,
      );
    const allowNegativeStock = effective.allowNegativeMaterialStock;

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
      // и идемпотентен по `StockMovement.sourceKey`. При
      // `allowNegativeStock = false` бросает 409 `MATERIAL_STOCK_INSUFFICIENT`,
      // и весь `$transaction` откатывается (см. `StockService.recordMaterialIssueInTx`).
      await this.stock.recordMaterialIssueInTx(
        tx,
        next.id,
        employeeId ?? null,
        { allowNegativeStock },
      );

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
  // RETURN (полное сторно или частичный возврат проведённого расхода)
  //
  // См. ТЗ «Возврат / сторно проведённого списания материалов»
  // и «Частичный возврат проведённого MaterialIssue»,
  // `prisma/schema.prisma::MaterialIssueReturn` /
  // `MaterialIssueReturnLine`,
  // `apps/api/src/modules/stock/stock.service.ts::recordMaterialIssueReturnInTx`,
  // `docs/current-state.md §«Material issue return»`.
  //
  // Два режима эндпоинта `POST /api/material-issues/:id/return`:
  //   1. **Полное сторно** (`dto.lines === undefined`) — сервис сам
  //      считает «остаток к возврату» по каждой строке как
  //      `MaterialIssueLine.issuedQty − Σ ранее возвращённое` и
  //      возвращает весь остаток. Исходное MVP-поведение, оставлено
  //      ради обратной совместимости со старыми клиентами и тестами.
  //   2. **Частичный возврат** (`dto.lines !== undefined`) —
  //      возвращаем только указанные `materialIssueLineId × returnedQty`,
  //      каждый ≤ `availableToReturn`. Дубликаты, чужие строки и
  //      превышение — 409. UI всегда отправляет `lines[]`, кнопка
  //      «Заполнить всё доступное» сама проставляет полные остатки.
  //
  // Сознательные границы:
  //   - удаление / отмена возврата НЕ реализованы;
  //   - идемпотентность по `MaterialIssueReturn.sourceKey` (см.
  //     `buildMaterialIssueReturnSourceKey`) — повторный submit с
  //     тем же `clientRequestId` возвращает уже созданный документ;
  //   - исходный `MaterialIssue` НЕ удаляется и НЕ меняет статус;
  //   - `MaterialIssue.totalCost` НЕ пересчитывается — net-агрегаты
  //     считаются на read через DTO (`returnedTotalCost`,
  //     `netTotalCost`, `returnStatus`).
  // ---------------------------------------------------------------------------

  /**
   * Создать `MaterialIssueReturn` (полное сторно или частичный
   * возврат) по проведённому `MaterialIssue`. `dto.lines === undefined`
   * → полный возврат всего остатка; `dto.lines !== undefined` →
   * только указанные строки с заданным `returnedQty`. Документ
   * возврата + строки + IN-движения склада живут в одной транзакции.
   */
  async returnPostedIssue(
    id: string,
    dto: ReturnMaterialIssueDto,
    employeeId: string | null | undefined,
  ): Promise<MaterialIssueReturnDetail> {
    const sourceKey = buildMaterialIssueReturnSourceKey(id, dto.clientRequestId);

    // 1) Идемпотентность ДО открытия транзакции — это просто SELECT,
    //    cheap-path для retry/двойного submit формы. Если существующий
    //    документ найден — просто возвращаем его detail (без повторных
    //    IN-движений и без второго audit).
    const existing = await this.prisma.materialIssueReturn.findUnique({
      where: { sourceKey },
      include: MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE,
    });
    if (existing) {
      this.logger.log(
        `event=material_issue.return.idempotent_hit materialIssueId=${id} returnId=${existing.id} sourceKey=${sourceKey}`,
      );
      return toReturnDetail(existing);
    }

    // 2) Загружаем исходный `MaterialIssue` со строками и текущими
    //    возвратами, чтобы посчитать остаток к возврату.
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id },
      include: {
        lines: true,
        returns: {
          where: { status: 'POSTED' },
          select: {
            id: true,
            lines: { select: { materialIssueLineId: true, returnedQty: true } },
          },
        },
      },
    });
    if (!issue) throw new MaterialIssueNotFoundException();
    if (issue.status !== MATERIAL_ISSUE_STATUS.POSTED) {
      throw new MaterialIssueReturnOnlyPostedException();
    }

    // 3) Считаем «уже возвращено» по каждой строке (POSTED-возвраты).
    const alreadyReturnedByLine = aggregateReturnsByLine(issue.returns);

    // 4) Готовим строки возврата.
    //    - dto.lines не передан → полное сторно (исходное MVP-поведение):
    //      возвращаем весь оставшийся `remaining` по каждой строке.
    //    - dto.lines передан → частичный возврат: возвращаем только
    //      указанные `materialIssueLineId × returnedQty`. Дубликаты,
    //      несуществующие строки, превышение остатка → 409.
    interface PreparedReturnLine {
      materialIssueLineId: string;
      workshopNeedId: string | null;
      description: string;
      materialRole: string | null;
      unit: string;
      returnedQty: Prisma.Decimal;
      unitCost: Prisma.Decimal;
      totalCost: Prisma.Decimal;
      cellId: string | null;
    }

    const linesById = new Map(issue.lines.map((l) => [l.id, l]));
    const remainingByLineId = new Map<string, Prisma.Decimal>();
    for (const line of issue.lines) {
      const already =
        alreadyReturnedByLine.get(line.id)?.returnedQty ??
        new Prisma.Decimal(0);
      remainingByLineId.set(line.id, line.issuedQty.sub(already));
    }

    const prepared: PreparedReturnLine[] = [];

    if (dto.lines && dto.lines.length > 0) {
      // Частичный возврат — обрабатываем строго переданные строки.
      const seen = new Set<string>();
      for (const requested of dto.lines) {
        // 4a) Дубликаты материальных строк в одном запросе. На MVP
        //     не суммируем за клиента — попросим переотправить.
        if (seen.has(requested.materialIssueLineId)) {
          throw new MaterialIssueReturnDuplicateLineException(
            requested.materialIssueLineId,
          );
        }
        seen.add(requested.materialIssueLineId);

        // 4b) Принадлежность строки этому MaterialIssue. Если нет —
        //     это другая строка / опечатка / параллельный refresh
        //     после удаления (MaterialIssueLine cascade-сносится
        //     только вместе с самим MaterialIssue, который выше уже
        //     найден; на практике это «строка из другого документа»).
        const sourceLine = linesById.get(requested.materialIssueLineId);
        if (!sourceLine) {
          throw new MaterialIssueReturnLineNotFoundException(
            requested.materialIssueLineId,
          );
        }

        // 4c) returnedQty > 0 уже валидирован Zod-ом (positiveDecimal),
        //     но повторно проверяем как server-side guard — DTO не
        //     обязан совпадать у всех клиентов.
        const requestedQty = new Prisma.Decimal(requested.returnedQty);
        if (requestedQty.lessThanOrEqualTo(0)) {
          throw new MaterialIssueQtyRequiredException();
        }

        // 4d) Не превышаем доступное.
        const remaining =
          remainingByLineId.get(sourceLine.id) ?? new Prisma.Decimal(0);
        if (requestedQty.greaterThan(remaining)) {
          throw new MaterialIssueReturnQtyExceedsAvailableException({
            materialIssueLineId: sourceLine.id,
            description: sourceLine.description,
            unit: sourceLine.unit,
            requestedQty: requestedQty.toString(),
            availableQty: remaining.toString(),
          });
        }

        const totalCost = requestedQty
          .mul(sourceLine.unitCost)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        prepared.push({
          materialIssueLineId: sourceLine.id,
          workshopNeedId: sourceLine.workshopNeedId,
          description: sourceLine.description,
          materialRole: sourceLine.materialRole,
          unit: sourceLine.unit,
          returnedQty: requestedQty,
          unitCost: sourceLine.unitCost,
          totalCost,
          cellId: null,
        });
      }
    } else {
      // Полное сторно — возвращаем весь оставшийся остаток по всем
      // строкам (legacy-поведение MVP-1, оставлено для backward-compat
      // со старыми клиентами и тестами).
      for (const line of issue.lines) {
        const remaining =
          remainingByLineId.get(line.id) ?? new Prisma.Decimal(0);
        if (remaining.lessThanOrEqualTo(0)) continue;
        const totalCost = remaining
          .mul(line.unitCost)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        prepared.push({
          materialIssueLineId: line.id,
          workshopNeedId: line.workshopNeedId,
          description: line.description,
          materialRole: line.materialRole,
          unit: line.unit,
          returnedQty: remaining,
          unitCost: line.unitCost,
          totalCost,
          cellId: null,
        });
      }
    }
    if (prepared.length === 0) {
      // Полное сторно по уже-полностью-возвращённому документу —
      // привычный для UI код `MATERIAL_ISSUE_ALREADY_RETURNED`.
      // Частичный с пустым результатом сюда попасть не может (Zod
      // требует `lines.min(1)` и `returnedQty > 0`), но если когда-
      // нибудь попадёт (server-to-server мутация DTO) — отдаём
      // `nothing_to_return`.
      if (dto.lines && dto.lines.length > 0) {
        throw new MaterialIssueNothingToReturnException();
      }
      throw new MaterialIssueAlreadyReturnedException();
    }

    const totalCost = prepared.reduce(
      (acc, l) => acc.add(l.totalCost),
      new Prisma.Decimal(0),
    );
    const reason = dto.reason.trim();

    // 5) В одной транзакции:
    //    - create MaterialIssueReturn + lines;
    //    - StockService.recordMaterialIssueReturnInTx → IN-движения;
    //    - audit `MATERIAL_ISSUE_RETURNED`.
    //    Если на создании случился P2002 (другая параллельная попытка
    //    создала документ с тем же sourceKey раньше) — отдаём ей
    //    приоритет: возвращаем уже созданный return.
    const created = await this.prisma
      .$transaction(async (tx) => {
        const ret = await tx.materialIssueReturn.create({
          data: {
            materialIssueId: issue.id,
            orderId: issue.orderId,
            passportId: issue.passportId,
            status: 'POSTED',
            sourceKey,
            reason,
            totalCost,
            createdById: employeeId ?? null,
            lines: {
              create: prepared.map((l) => ({
                materialIssueLineId: l.materialIssueLineId,
                workshopNeedId: l.workshopNeedId,
                description: l.description,
                materialRole: l.materialRole,
                unit: l.unit,
                returnedQty: l.returnedQty,
                unitCost: l.unitCost,
                totalCost: l.totalCost,
                cellId: l.cellId,
              })),
            },
          },
          include: MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE,
        });

        await this.stock.recordMaterialIssueReturnInTx(
          tx,
          ret.id,
          employeeId ?? null,
        );

        await this.audit.log(
          {
            event: 'MATERIAL_ISSUE_RETURNED',
            entityType: 'MATERIAL_ISSUE_RETURN',
            entityId: ret.id,
            employeeId: employeeId ?? null,
            payload: this.buildReturnAuditPayload(
              issue.id,
              ret,
              employeeId ?? null,
            ) as Prisma.InputJsonValue,
          },
          tx,
        );

        return ret;
      })
      .catch(async (err) => {
        // Идемпотентность под конкурентным submit-ом: одна
        // транзакция выиграла гонку, другая словила P2002 на
        // UNIQUE `sourceKey`. Отдаём успешный result.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          const winner = await this.prisma.materialIssueReturn.findUnique({
            where: { sourceKey },
            include: MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE,
          });
          if (winner) return winner;
        }
        throw err;
      });

    this.logger.log(
      `event=material_issue.return.created materialIssueId=${issue.id} returnId=${created.id} ` +
        `lines=${created.lines.length} totalCost=${created.totalCost.toString()}`,
    );

    return toReturnDetail(created);
  }

  private buildReturnAuditPayload(
    materialIssueId: string,
    ret: Prisma.MaterialIssueReturnGetPayload<{
      include: typeof MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE;
    }>,
    employeeId: string | null,
  ): Record<string, unknown> {
    return {
      materialIssueId,
      materialIssueReturnId: ret.id,
      orderId: ret.orderId,
      passportId: ret.passportId,
      reason: ret.reason,
      totalCost: ret.totalCost.toString(),
      lines: ret.lines.map((l) => ({
        materialIssueLineId: l.materialIssueLineId,
        workshopNeedId: l.workshopNeedId,
        returnedQty: l.returnedQty.toString(),
        unit: l.unit,
        unitCost: l.unitCost.toString(),
        totalCost: l.totalCost.toString(),
      })),
      employeeId,
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
    // «ничего». Авто-строки без `cellId` (см. preparedLines выше);
    // при `allowNegativeStock = true` `StockService` выбирает самый
    // большой положительный balance по `(workshopNeedId, unit)` или
    // no-location balance, если положительного нет; при
    // `allowNegativeStock = false` — самый большой положительный с
    // `qty >= issuedQty` или 409 `MATERIAL_STOCK_INSUFFICIENT`
    // (`issueToEmployee` тоже откатывается, потому что владелец явно
    // запретил минус).
    //
    // Флаг читается effective-resolver-ом `CompanySettingsService`
    // — учитывается per-division override `CompanyDivision.allowNegativeMaterialStockOverride`
    // (см. `docs/current-state.md §«Материалы и склад — division overrides»`).
    // Ходим по `tx`, чтобы остаться в той же транзакции
    // `issueToEmployee` и не открывать повторный коннект.
    const effective =
      await this.companySettings.getEffectiveMaterialStockSettingsForOrderInTx(
        tx,
        passport.orderId,
      );
    await this.stock.recordMaterialIssueInTx(tx, issue.id, employeeId, {
      allowNegativeStock: effective.allowNegativeMaterialStock,
    });

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

/**
 * Минимально полный include для one-row сериализации
 * `MaterialIssueReturn` (используется и в detail-DTO основного
 * расхода, и в standalone-detail возврата).
 *
 * `orderBy` намеренно мутируемый (без `as const`) — Prisma 5.x
 * `MaterialIssueReturn$linesArgs.orderBy` принимает только обычные
 * массивы, не readonly tuple.
 */
const MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE = {
  lines: {
    orderBy: [{ id: 'asc' as const }],
    include: {
      cell: { select: { id: true, code: true } },
    },
  },
} satisfies Prisma.MaterialIssueReturnInclude;

const MATERIAL_ISSUE_LIST_INCLUDE = {
  order: { select: { id: true, number: true, status: true } },
  passport: { select: { id: true, number: true } },
  lines: {
    orderBy: [{ id: 'asc' as const }],
  },
  returns: {
    where: { status: 'POSTED' },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      totalCost: true,
      lines: {
        select: { materialIssueLineId: true, returnedQty: true },
      },
    },
  },
} satisfies Prisma.MaterialIssueInclude;

const MATERIAL_ISSUE_DETAIL_INCLUDE = {
  order: { select: { id: true, number: true, status: true } },
  passport: { select: { id: true, number: true } },
  lines: {
    orderBy: [{ id: 'asc' as const }],
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
  returns: {
    where: { status: 'POSTED' },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE,
  },
} satisfies Prisma.MaterialIssueInclude;

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
  /** Σ возвращённого qty по этой строке (POSTED-возвраты). */
  returnedQty: string;
  /** Σ totalCost возвращённого. */
  returnedTotalCost: string;
  /** `issuedQty - returnedQty`. */
  netIssuedQty: string;
  /** `totalCost - returnedTotalCost`. */
  netTotalCost: string;
}

export type MaterialIssueAggregateReturnStatus = 'NONE' | 'PARTIAL' | 'FULL';

export interface MaterialIssueReturnLineDetail {
  id: string;
  materialIssueLineId: string;
  workshopNeedId: string | null;
  description: string;
  materialRole: string | null;
  unit: string;
  returnedQty: string;
  unitCost: string;
  totalCost: string;
  cellId: string | null;
  cellCode: string | null;
  comment: string | null;
}

export interface MaterialIssueReturnDetail {
  id: string;
  materialIssueId: string;
  orderId: string;
  passportId: string | null;
  status: string;
  reason: string;
  totalCost: string;
  createdAt: string;
  createdById: string | null;
  lines: MaterialIssueReturnLineDetail[];
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
  returns: MaterialIssueReturnDetail[];
  returnedTotalCost: string;
  netTotalCost: string;
  returnStatus: MaterialIssueAggregateReturnStatus;
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
  returnedTotalCost: string;
  netTotalCost: string;
  returnsCount: number;
  returnStatus: MaterialIssueAggregateReturnStatus;
}

/**
 * Считает per-line `returnedQty` / `returnedTotalCost` по массиву
 * POSTED `MaterialIssueReturn`-ов (с include-ом строк). Возвращает
 * map `materialIssueLineId → { returnedQty, returnedTotalCost }` в
 * виде Decimal.
 *
 * `returnedTotalCost` суммируем как `returnedQty × MaterialIssueLine.unitCost`,
 * взяв `unitCost` из самой `MaterialIssueReturnLine.unitCost` —
 * snapshot, который сервис фиксирует в момент создания возврата
 * (см. `MaterialIssuesService.returnPostedIssue`).
 */
function aggregateReturnsByLine(
  returns: ReadonlyArray<{
    lines: ReadonlyArray<{
      materialIssueLineId: string;
      returnedQty: Prisma.Decimal;
      totalCost?: Prisma.Decimal;
    }>;
  }>,
): Map<
  string,
  { returnedQty: Prisma.Decimal; returnedTotalCost: Prisma.Decimal }
> {
  const acc = new Map<
    string,
    { returnedQty: Prisma.Decimal; returnedTotalCost: Prisma.Decimal }
  >();
  for (const r of returns) {
    for (const rl of r.lines) {
      const prev = acc.get(rl.materialIssueLineId) ?? {
        returnedQty: new Prisma.Decimal(0),
        returnedTotalCost: new Prisma.Decimal(0),
      };
      const next = {
        returnedQty: prev.returnedQty.add(rl.returnedQty),
        returnedTotalCost: prev.returnedTotalCost.add(
          rl.totalCost ?? new Prisma.Decimal(0),
        ),
      };
      acc.set(rl.materialIssueLineId, next);
    }
  }
  return acc;
}

/**
 * Совокупный return-status: `NONE` если нет ни одного возврата,
 * `FULL` если все строки `issuedQty <= returnedQty`, иначе `PARTIAL`.
 */
function computeReturnStatus(
  lines: ReadonlyArray<{ id: string; issuedQty: Prisma.Decimal }>,
  perLine: Map<string, { returnedQty: Prisma.Decimal }>,
): MaterialIssueAggregateReturnStatus {
  if (perLine.size === 0) return 'NONE';
  let totalIssued = new Prisma.Decimal(0);
  let totalReturned = new Prisma.Decimal(0);
  let allFull = true;
  for (const l of lines) {
    totalIssued = totalIssued.add(l.issuedQty);
    const r = perLine.get(l.id)?.returnedQty ?? new Prisma.Decimal(0);
    totalReturned = totalReturned.add(r);
    if (r.lt(l.issuedQty)) allFull = false;
  }
  if (totalReturned.lte(0)) return 'NONE';
  if (allFull && totalReturned.gte(totalIssued)) return 'FULL';
  return 'PARTIAL';
}

function toListItem(
  row: Prisma.MaterialIssueGetPayload<{
    include: typeof MATERIAL_ISSUE_LIST_INCLUDE;
  }>,
): MaterialIssueListItem {
  const perLine = aggregateReturnsByLine(row.returns);
  const returnedTotalCost = row.returns.reduce(
    (acc, r) => acc.add(r.totalCost),
    new Prisma.Decimal(0),
  );
  const netTotalCost = row.totalCost.sub(returnedTotalCost);
  const returnStatus = computeReturnStatus(row.lines, perLine);
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
    returnedTotalCost: returnedTotalCost.toString(),
    netTotalCost: netTotalCost.toString(),
    returnsCount: row.returns.length,
    returnStatus,
  };
}

function toReturnDetail(
  row: Prisma.MaterialIssueReturnGetPayload<{
    include: typeof MATERIAL_ISSUE_RETURN_DETAIL_INCLUDE;
  }>,
): MaterialIssueReturnDetail {
  return {
    id: row.id,
    materialIssueId: row.materialIssueId,
    orderId: row.orderId,
    passportId: row.passportId,
    status: row.status,
    reason: row.reason,
    totalCost: row.totalCost.toString(),
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    lines: row.lines.map(
      (l): MaterialIssueReturnLineDetail => ({
        id: l.id,
        materialIssueLineId: l.materialIssueLineId,
        workshopNeedId: l.workshopNeedId,
        description: l.description,
        materialRole: l.materialRole,
        unit: l.unit,
        returnedQty: l.returnedQty.toString(),
        unitCost: l.unitCost.toString(),
        totalCost: l.totalCost.toString(),
        cellId: l.cellId,
        cellCode: l.cell?.code ?? null,
        comment: l.comment,
      }),
    ),
  };
}

function toDetail(
  row: Prisma.MaterialIssueGetPayload<{
    include: typeof MATERIAL_ISSUE_DETAIL_INCLUDE;
  }>,
): MaterialIssueDetail {
  const perLine = aggregateReturnsByLine(row.returns);
  const returnedTotalCost = row.returns.reduce(
    (acc, r) => acc.add(r.totalCost),
    new Prisma.Decimal(0),
  );
  const netTotalCost = row.totalCost.sub(returnedTotalCost);
  const returnStatus = computeReturnStatus(row.lines, perLine);
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
    lines: row.lines.map((l): MaterialIssueLineDetail => {
      const agg = perLine.get(l.id);
      const returnedQty = agg?.returnedQty ?? new Prisma.Decimal(0);
      const returnedLineTotalCost =
        agg?.returnedTotalCost ?? new Prisma.Decimal(0);
      const netIssuedQty = l.issuedQty.sub(returnedQty);
      const netLineTotalCost = l.totalCost.sub(returnedLineTotalCost);
      return {
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
        returnedQty: returnedQty.toString(),
        returnedTotalCost: returnedLineTotalCost.toString(),
        netIssuedQty: netIssuedQty.toString(),
        netTotalCost: netLineTotalCost.toString(),
      };
    }),
    returns: row.returns.map(toReturnDetail),
    returnedTotalCost: returnedTotalCost.toString(),
    netTotalCost: netTotalCost.toString(),
    returnStatus,
  };
}
