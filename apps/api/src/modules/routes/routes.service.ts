import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateRouteTemplateDto,
  ListRouteTemplatesQuery,
  RouteTemplateDetailDto,
  RouteTemplateStepDto,
  RouteTemplateStepInputDto,
  RouteTemplateSummaryDto,
  UpdateRouteTemplateDto,
} from '@sewing/shared/routes';

import type { BulkArchiveResultDto } from '@sewing/shared/archive';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { indexById, runBulkArchive } from '../../common/bulk-archive.js';
import {
  OperationNotFoundException,
  RouteTemplateCodeTakenException,
  RouteTemplateDeleteForbiddenException,
  RouteTemplateNotFoundException,
} from '../../common/errors.js';

/**
 * CRUD шаблонов маршрутов. На MVP это «soft route»: сервис сохраняет
 * упорядоченный набор операций, никаких сложных правил (ветвлений,
 * параллельных шагов, дедлайнов) — см. `docs/domain.md §«Маршруты
 * производства»`. Snapshot на заказе создаёт `OrdersService.start()`,
 * этот сервис заказы не трогает.
 *
 * Конвенции:
 *   - `index` шагов нормализуется по позиции в массиве (0-based) —
 *     UI достаточно отдать упорядоченный список без ручной нумерации;
 *   - PATCH со `steps` целиком заменяет набор (атомарно, в одной
 *     транзакции — UI никогда не увидит «полупустой» шаблон);
 *   - DELETE всегда hard-delete: `RouteTemplateStep` уезжает по
 *     каскаду, на запущенных заказах остаётся snapshot
 *     `OrderRouteStep[]`, который не зависит от существования шаблона.
 */
@Injectable()
export class RoutesService {
  private readonly logger = new Logger(RoutesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(
    query: ListRouteTemplatesQuery,
  ): Promise<RouteTemplateSummaryDto[]> {
    const where: Prisma.RouteTemplateWhereInput = {};
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.search) {
      where.OR = [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.routeTemplate.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
      include: { _count: { select: { steps: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      stepsCount: row._count.steps,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<RouteTemplateDetailDto> {
    const row = await this.prisma.routeTemplate.findUnique({
      where: { id },
      include: {
        steps: {
          orderBy: { index: 'asc' },
          include: { operation: true },
        },
      },
    });
    if (!row) throw new RouteTemplateNotFoundException();
    return this.toDetailDto(row);
  }

  /**
   * Используется `OrdersService.start()` для построения snapshot-а:
   * возвращает упорядоченный список операций активного шаблона. Если
   * шаблон не найден — кидаем 404 (ловится в orders.service); если
   * шагов нет, отдаём пустой массив, и orders.service просто пропустит
   * snapshot (см. `OrdersService.snapshotRouteIfNeeded`).
   */
  async getActiveStepsForSnapshot(
    templateId: string,
  ): Promise<
    {
      index: number;
      operationId: string;
      parallelGroup: number | null;
      rateOverride: Prisma.Decimal | null;
    }[]
  > {
    const template = await this.prisma.routeTemplate.findUnique({
      where: { id: templateId },
      include: {
        steps: {
          orderBy: { index: 'asc' },
          select: {
            index: true,
            operationId: true,
            parallelGroup: true,
            rateOverride: true,
          },
        },
      },
    });
    if (!template) throw new RouteTemplateNotFoundException();
    return template.steps.map((s) => ({
      index: s.index,
      operationId: s.operationId,
      parallelGroup: s.parallelGroup,
      rateOverride: s.rateOverride,
    }));
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateRouteTemplateDto): Promise<RouteTemplateDetailDto> {
    if (dto.steps.length > 0) {
      await this.assertOperationsExist(dto.steps.map((s) => s.operationId));
    }

    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.routeTemplate.create({
          data: {
            code: dto.code,
            name: dto.name,
            isActive: dto.isActive,
          },
        });
        if (dto.steps.length > 0) {
          const groups = RoutesService.computeParallelGroups(dto.steps);
          await tx.routeTemplateStep.createMany({
            data: dto.steps.map((s, i) => ({
              templateId: created.id,
              index: i,
              operationId: s.operationId,
              isOptional: s.isOptional ?? false,
              parallelGroup: groups[i],
              rateOverride: s.rateOverride ?? null,
            })),
          });
        }
        return created.id;
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=route_template.create id=${createdId} code=${dto.code} steps=${dto.steps.length}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // UPDATE (точечное)
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateRouteTemplateDto,
  ): Promise<RouteTemplateDetailDto> {
    const existing = await this.prisma.routeTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new RouteTemplateNotFoundException();

    if (dto.steps && dto.steps.length > 0) {
      await this.assertOperationsExist(dto.steps.map((s) => s.operationId));
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.RouteTemplateUpdateInput = {};
        if (dto.code !== undefined) data.code = dto.code;
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;

        // Этап «edge cases после переноса OrderRouteStep[] snapshot»:
        // правка только `steps` без `code/name/isActive` обязана
        // touch-нуть `RouteTemplate.updatedAt`. Это инвариант
        // `OrderOperationPlanService.getFreshnessForOrder` — он
        // считает план stale через `RouteTemplate.updatedAt` (а
        // `RouteTemplateStep.updatedAt` в схеме нет). Без этого
        // touch-а PATCH `{steps: [...]}` через API не отметил бы
        // зависимые заказы как stale, и менеджер не получил бы
        // подсказку «План операций требует пересчёта». Через admin
        // UI проблема не заметна (форма всегда шлёт всё четвёркой
        // `code/name/isActive/steps`), но прямой API-вызов раньше
        // ломал инвариант.
        //
        // Используем явный `updatedAt: new Date()` — Prisma
        // `@updatedAt` обновляет поле автоматически только если в
        // data передано хотя бы одно поле, поэтому при «голом»
        // `{steps: [...]}` приходится touch-ить вручную.
        if (dto.steps !== undefined && Object.keys(data).length === 0) {
          data.updatedAt = new Date();
        }

        if (Object.keys(data).length > 0) {
          await tx.routeTemplate.update({ where: { id }, data });
        }

        if (dto.steps !== undefined) {
          await this.replaceSteps(tx, id, dto.steps);
        }
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=route_template.update id=${id} fields=${Object.keys(dto).join(',')}`,
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  /**
   * Hard-delete шаблона маршрута.
   *
   * Этап «Архив справочников»: удаление стало вторым шагом, а не
   * первым — сначала шаблон уходит в архив (`isActive = false`), и
   * только оттуда его можно стереть. Плюс гейт по ссылкам: заказ и
   * пробник держат `routeTemplateId` с FK `RESTRICT`, и раньше такое
   * удаление падало сырой ошибкой БД — теперь отвечаем понятным 409.
   *
   * Cascade удалит `RouteTemplateStep`. На запущенных заказах
   * `OrderRouteStep` остаётся (FK на `Operation`, не на template) —
   * snapshot самодостаточный и не зависит от существования шаблона.
   */
  async remove(id: string): Promise<void> {
    const existing = await this.prisma.routeTemplate.findUnique({
      where: { id },
      select: { id: true, code: true, isActive: true },
    });
    if (!existing) throw new RouteTemplateNotFoundException();
    if (existing.isActive) {
      throw new RouteTemplateDeleteForbiddenException(
        'Удалить навсегда можно только архивный шаблон маршрута. Как удалить: сначала отправьте его в архив, затем нажмите «Удалить навсегда».',
      );
    }
    const usage = await this.describeUsage(id);
    if (usage) {
      throw new RouteTemplateDeleteForbiddenException(
        `Этот шаблон маршрута удалить навсегда нельзя: его используют ${usage}. Оставьте шаблон в архиве — в новые заказы архивные не предлагаются.`,
      );
    }

    await this.prisma.routeTemplate.delete({ where: { id } });
    this.logger.log(`event=route_template.delete id=${id}`);
  }

  /**
   * Кто держит шаблон: заказы (`Order.routeTemplateId`) и пробники
   * (`OrderSample.routeTemplateId`) — оба FK `RESTRICT`. `null` —
   * ссылок нет, удалять можно. Общий гейт для одиночного `remove()`
   * и массового `purgeMany()`.
   */
  private async describeUsage(id: string): Promise<string | null> {
    const [orderCount, sampleCount] = await Promise.all([
      this.prisma.order.count({ where: { routeTemplateId: id } }),
      this.prisma.orderSample.count({ where: { routeTemplateId: id } }),
    ]);
    const parts: string[] = [];
    if (orderCount > 0) parts.push(`заказов: ${orderCount}`);
    if (sampleCount > 0) parts.push(`пробников: ${sampleCount}`);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  // ===========================================================================
  // АРХИВ ШАБЛОНОВ МАРШРУТА — bulk archive / restore / purge
  // ===========================================================================
  //
  // Общий контур справочников админки (`@sewing/shared/archive`).
  // Архив физически — `isActive = false`: то же поле, которым шаблон
  // уже выключался из подбора в заказах, отдельной миграции не нужно.

  async archiveMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.routeTemplate.findMany({
            where: { id: { in: want } },
            select: { id: true, isActive: true },
          }),
        ),
      alreadyDone: (row) => !row.isActive,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.routeTemplate.updateMany({
            where: { id: { in: targetIds } },
            data: { isActive: false },
          });
          await this.audit.log(
            {
              event: 'ROUTE_TEMPLATES_ARCHIVED',
              entityType: 'ROUTE_TEMPLATE',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { routeTemplateIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=route_template.archive processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async restoreMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.routeTemplate.findMany({
            where: { id: { in: want } },
            select: { id: true, isActive: true },
          }),
        ),
      alreadyDone: (row) => row.isActive,
      gate: () => null,
      apply: async (_rows, targetIds) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.routeTemplate.updateMany({
            where: { id: { in: targetIds } },
            data: { isActive: true },
          });
          await this.audit.log(
            {
              event: 'ROUTE_TEMPLATES_RESTORED',
              entityType: 'ROUTE_TEMPLATE',
              entityId: targetIds[0],
              employeeId: actorEmployeeId ?? null,
              payload: { routeTemplateIds: targetIds },
            },
            tx,
          );
        });
      },
    });
    this.logger.log(
      `event=route_template.restore processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  async purgeMany(
    ids: string[],
    actorEmployeeId?: string | null,
  ): Promise<BulkArchiveResultDto> {
    const res = await runBulkArchive({
      ids,
      load: async (want) =>
        indexById(
          await this.prisma.routeTemplate.findMany({
            where: { id: { in: want } },
            select: { id: true, code: true, name: true, isActive: true },
          }),
        ),
      gate: async (row) => {
        if (row.isActive) return { reason: 'NOT_ARCHIVED' as const };
        const usage = await this.describeUsage(row.id);
        return usage
          ? {
              reason: 'IN_USE' as const,
              detail: `маршрут «${row.code}» используют ${usage}`,
            }
          : null;
      },
      apply: async (rows) => {
        for (const row of rows) {
          await this.prisma.$transaction(async (tx) => {
            await tx.routeTemplate.delete({ where: { id: row.id } });
            await this.audit.log(
              {
                event: 'ROUTE_TEMPLATE_DELETED',
                entityType: 'ROUTE_TEMPLATE',
                entityId: row.id,
                employeeId: actorEmployeeId ?? null,
                payload: { code: row.code, name: row.name, bulk: true },
              },
              tx,
            );
          });
        }
      },
    });
    this.logger.log(
      `event=route_template.purge processed=${res.processed.length} skipped=${res.skipped.length}`,
    );
    return res;
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  /**
   * Полная замена набора шагов. Простой и предсказуемый алгоритм —
   * удалить всё, вставить заново с пересчитанным `index`. Транзакция
   * гарантирует, что UI/последующие чтения не увидят промежуточное
   * состояние. Использует `Prisma.TransactionClient`, чтобы вызывать
   * из `update()` без вложенных $transaction.
   */
  private async replaceSteps(
    tx: Prisma.TransactionClient,
    templateId: string,
    steps: RouteTemplateStepInputDto[],
  ): Promise<void> {
    await tx.routeTemplateStep.deleteMany({ where: { templateId } });
    if (steps.length === 0) return;
    const groups = RoutesService.computeParallelGroups(steps);
    await tx.routeTemplateStep.createMany({
      data: steps.map((s, i) => ({
        templateId,
        index: i,
        operationId: s.operationId,
        isOptional: s.isOptional ?? false,
        parallelGroup: groups[i],
        rateOverride: s.rateOverride ?? null,
      })),
    });
  }

  /**
   * Сворачивает соседние шаги, помеченные `parallelWithPrev`, в номера
   * параллельных групп. Возвращает массив `parallelGroup` той же длины,
   * что `steps` (`null` — обычный последовательный шаг). На первом шаге
   * флаг игнорируется. Непрерывный «прогон» связанных шагов = одна
   * группа: шаги i-1..i..i+1 с `parallelWithPrev` на i и i+1 → один
   * номер. Номера локальны для шаблона (1,2,…), их абсолютное значение
   * не важно — важна лишь общность у соседей.
   */
  private static computeParallelGroups(
    steps: RouteTemplateStepInputDto[],
  ): (number | null)[] {
    const groups: (number | null)[] = steps.map(() => null);
    let gid = 0;
    for (let i = 1; i < steps.length; i += 1) {
      if (steps[i].parallelWithPrev) {
        if (groups[i - 1] === null) {
          gid += 1;
          groups[i - 1] = gid;
        }
        groups[i] = groups[i - 1];
      }
    }
    return groups;
  }

  private async assertOperationsExist(operationIds: string[]): Promise<void> {
    const uniqueIds = Array.from(new Set(operationIds));
    if (uniqueIds.length === 0) return;
    const found = await this.prisma.operation.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    if (found.length !== uniqueIds.length) {
      throw new OperationNotFoundException();
    }
  }

  private toDetailDto(
    row: Prisma.RouteTemplateGetPayload<{
      include: {
        steps: { include: { operation: true } };
      };
    }>,
  ): RouteTemplateDetailDto {
    const steps: RouteTemplateStepDto[] = row.steps.map((s) => ({
      id: s.id,
      index: s.index,
      operationId: s.operationId,
      operationCode: s.operation.code,
      operationName: s.operation.name,
      isOptional: s.isOptional,
      parallelGroup: s.parallelGroup,
      rateOverride: s.rateOverride != null ? s.rateOverride.toNumber() : null,
    }));
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      isActive: row.isActive,
      stepsCount: steps.length,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      steps,
    };
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('code'))) {
        throw new RouteTemplateCodeTakenException();
      }
      // Уникальные индексы по `(templateId, index)` и `(templateId,
      // operationId)` мы не должны словить: `replaceSteps` сначала
      // удаляет всё, потом вставляет с уникальными `index`-ами;
      // дубликаты `operationId` отсекает Zod (см. `StepsField`).
      // Если P2002 всё-таки прилетит — это инвариант сломали в коде,
      // отдадим тот же CODE_TAKEN, чтобы UI не падал в 500.
      throw new RouteTemplateCodeTakenException();
    }
  }
}
