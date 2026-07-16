import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { isCutBlockingMaterialRole } from '@sewing/shared/cut-readiness';
import {
  type CreateOrderMaterialArrivalOverrideDto,
  type OrderMaterialArrivalOverrideDto,
  type OrderMaterialArrivalOverrideStatus,
  type RevokeOrderMaterialArrivalOverrideDto,
} from '@sewing/shared/order-material-arrivals';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import { ACTIVE_CALCULATION_NEED_WHERE } from '../workshop-needs/workshop-need-scope.js';

/**
 * Сервис «Ручная отметка поступления материала».
 *
 * Контракт (см. `docs/recon-soft-integration.md`,
 * `apps/api/src/modules/order-material-arrivals/order-material-arrivals.controller.ts`,
 * `prisma/schema.prisma::OrderMaterialArrivalOverride`):
 *
 *   - `markArrived(actor, orderId, dto)` — создаёт ACTIVE-overrides
 *     по blocking-потребностям заказа. Если есть `workshopNeedIds`,
 *     использует только эти строки; иначе берёт все blocking-роли
 *     (см. `CUT_BLOCKING_MATERIAL_ROLES` из shared). Дубль для
 *     потребности с уже существующим ACTIVE-override НЕ создаётся
 *     — возвращается уже существующая строка.
 *
 *   - `listForOrder(orderId)` — все overrides по заказу (включая
 *     REVOKED) — для UI/аудита.
 *
 *   - `revoke(actor, orderId, overrideId, dto)` — переводит
 *     override в REVOKED. Идемпотентен — повторный revoke возвращает
 *     текущую DTO без аудита-дубля.
 *
 * Сервис сознательно НЕ трогает:
 *   - `PurchaseReceipt` / `PurchaseReceiptLine` (не создаём фиктивную
 *     приёмку);
 *   - `CellContent` / складские остатки;
 *   - `WorkshopNeed.status`;
 *   - `Order.status`;
 *   - Passport / OperationEntry / SalaryEntry.
 *
 * Это override готовности к крою — он только прописывает запись в
 * `OrderMaterialArrivalOverride` + audit-log.
 */
@Injectable()
export class OrderMaterialArrivalsService {
  private readonly logger = new Logger(OrderMaterialArrivalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  /**
   * Список overrides по заказу. Включаем REVOKED тоже, чтобы UI
   * мог показать историю и аудитор увидел весь след.
   */
  async listForOrder(
    orderId: string,
  ): Promise<OrderMaterialArrivalOverrideDto[]> {
    await this.assertOrderExists(orderId);
    const rows = await this.prisma.orderMaterialArrivalOverride.findMany({
      where: { orderId },
      include: OVERRIDE_INCLUDE,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(toDto);
  }

  // ---------------------------------------------------------------------------
  // CREATE
  // ---------------------------------------------------------------------------

  /**
   * Создать ручные отметки «Материал поступил» по blocking-потребностям
   * заказа.
   *
   * Алгоритм:
   *   1. Загрузить заказ + все его `WorkshopNeed`.
   *   2. Если в DTO есть `workshopNeedIds` — отфильтровать строки
   *      по списку (после проверки, что они принадлежат заказу).
   *      Иначе — взять все строки с blocking-ролью и status != CANCELLED.
   *   3. Для каждой выбранной строки:
   *        - если уже есть ACTIVE override → пропустить (но добавить
   *          в результат);
   *        - иначе создать новый ACTIVE override со snapshot-полями
   *          из `WorkshopNeed`.
   *   4. Один audit-event `ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED`
   *      с `entityType = ORDER` и `entityId = orderId`.
   *
   * Возвращает все ACTIVE-overrides для заказа (включая ранее
   * существовавшие) — UI рендерит их рядом с CutReadinessCard.
   */
  async markArrived(
    actor: AuthPrincipal,
    orderId: string,
    dto: CreateOrderMaterialArrivalOverrideDto,
  ): Promise<OrderMaterialArrivalOverrideDto[]> {
    this.assertCanMutate(actor);
    await this.assertOrderExists(orderId);

    // Фича «Варианты просчёта»: отметка «материал поступил» работает по
    // строкам АКТИВНОГО варианта (default-ветка ниже берёт все blocking-
    // роли — без скоупа она пометила бы и потребности вариантов
    // сравнения). Явные workshopNeedIds остаются адресными.
    const allNeeds = await this.prisma.workshopNeed.findMany({
      where: { orderId, AND: [ACTIVE_CALCULATION_NEED_WHERE] },
      select: {
        id: true,
        status: true,
        materialRole: true,
        description: true,
        sourceName: true,
        purchaseQty: true,
        calculatedQty: true,
        unit: true,
      },
    });

    // 1. Если фронт передал workshopNeedIds — оставляем только их и
    //    проверяем, что все они принадлежат заказу. Любая чужая
    //    строка → 400 (фронт/тест ошиблись с привязкой).
    let candidates: typeof allNeeds = [];
    if (dto.workshopNeedIds && dto.workshopNeedIds.length > 0) {
      const requested = new Set(dto.workshopNeedIds);
      const byId = new Map(allNeeds.map((n) => [n.id, n]));
      const missing: string[] = [];
      for (const id of requested) {
        const need = byId.get(id);
        if (!need) {
          missing.push(id);
          continue;
        }
        candidates.push(need);
      }
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'ORDER_MATERIAL_ARRIVAL_NEEDS_NOT_IN_ORDER',
          message: `Потребности не принадлежат заказу: ${missing.join(', ')}`,
        });
      }
    } else {
      // 2. Иначе — все blocking-потребности (status != CANCELLED).
      candidates = allNeeds.filter(
        (n) =>
          n.status !== 'CANCELLED' && isCutBlockingMaterialRole(n.materialRole),
      );
    }

    if (candidates.length === 0) {
      throw new BadRequestException({
        code: 'ORDER_MATERIAL_ARRIVAL_NO_BLOCKING_NEEDS',
        message:
          'У заказа нет потребностей по основным материалам, которые можно разблокировать.',
      });
    }

    // 3. Найдём существующие ACTIVE-overrides по этим потребностям —
    //    их трогать не будем (idempotent UX).
    const candidateIds = candidates.map((n) => n.id);
    const existingActive =
      await this.prisma.orderMaterialArrivalOverride.findMany({
        where: {
          orderId,
          status: 'ACTIVE',
          workshopNeedId: { in: candidateIds },
        },
        select: { id: true, workshopNeedId: true },
      });
    const existingByNeedId = new Map(
      existingActive.map((o) => [o.workshopNeedId, o.id]),
    );

    const toCreate = candidates.filter(
      (n) => !existingByNeedId.has(n.id),
    );

    let createdCount = 0;
    if (toCreate.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const need of toCreate) {
          const targetQty = need.purchaseQty ?? need.calculatedQty;
          await tx.orderMaterialArrivalOverride.create({
            data: {
              orderId,
              workshopNeedId: need.id,
              materialRole: need.materialRole,
              description: need.description ?? need.sourceName,
              qty: targetQty,
              unit: need.unit,
              status: 'ACTIVE',
              comment: dto.comment,
              createdById: actor.employeeId,
            },
          });
          createdCount += 1;
        }
        await this.audit.log(
          {
            event: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED',
            entityType: 'ORDER',
            entityId: orderId,
            employeeId: actor.employeeId,
            payload: {
              orderId,
              workshopNeedIds: toCreate.map((n) => n.id),
              overridesCount: createdCount,
              skippedExistingCount: existingByNeedId.size,
              comment: dto.comment,
            },
          },
          tx,
        );
      });
    }

    this.logger.log(
      `event=orderMaterialArrival.markArrived orderId=${orderId} actor=${actor.employeeId} created=${createdCount} skippedExisting=${existingByNeedId.size}`,
    );

    // Возвращаем актуальный список (включая существовавшие ACTIVE).
    const fresh = await this.prisma.orderMaterialArrivalOverride.findMany({
      where: {
        orderId,
        status: 'ACTIVE',
        workshopNeedId: { in: candidateIds },
      },
      include: OVERRIDE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return fresh.map(toDto);
  }

  // ---------------------------------------------------------------------------
  // REVOKE
  // ---------------------------------------------------------------------------

  /**
   * Отменить ранее созданный override. Идемпотентно: повторный
   * revoke на уже REVOKED-строке возвращает её текущее состояние
   * без записи audit-дубля.
   */
  async revoke(
    actor: AuthPrincipal,
    orderId: string,
    overrideId: string,
    dto: RevokeOrderMaterialArrivalOverrideDto,
  ): Promise<OrderMaterialArrivalOverrideDto> {
    this.assertCanMutate(actor);
    const current = await this.prisma.orderMaterialArrivalOverride.findUnique({
      where: { id: overrideId },
      include: OVERRIDE_INCLUDE,
    });
    if (!current || current.orderId !== orderId) {
      throw new NotFoundException({
        code: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE_NOT_FOUND',
        message: 'Ручная отметка поступления материала не найдена',
      });
    }
    if (current.status === 'REVOKED') {
      // Идемпотентность: повторный revoke — no-op.
      return toDto(current);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.orderMaterialArrivalOverride.update({
        where: { id: overrideId },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedById: actor.employeeId,
          revokeReason: dto.reason,
        },
        include: OVERRIDE_INCLUDE,
      });
      await this.audit.log(
        {
          event: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE_REVOKED',
          entityType: 'ORDER_MATERIAL_ARRIVAL_OVERRIDE',
          entityId: next.id,
          employeeId: actor.employeeId,
          payload: {
            orderId: next.orderId,
            workshopNeedId: next.workshopNeedId,
            materialRole: next.materialRole,
            reason: dto.reason,
          },
        },
        tx,
      );
      return next;
    });

    this.logger.log(
      `event=orderMaterialArrival.revoke overrideId=${overrideId} orderId=${orderId} actor=${actor.employeeId}`,
    );
    return toDto(updated);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private assertCanMutate(actor: AuthPrincipal): void {
    // Дополнительная страховка поверх @Roles на контроллере: внешние
    // вызовы сервиса (например, из тестов или будущих модулей)
    // должны соблюдать ту же RBAC-границу.
    if (actor.role !== 'ADMIN' && actor.role !== 'SHOP_MANAGER') {
      throw new ForbiddenException({
        code: 'FORBIDDEN_ROLE',
        message:
          'Только ADMIN и SHOP_MANAGER могут вручную отмечать поступление материала',
      });
    }
  }

  private async assertOrderExists(orderId: string): Promise<void> {
    const exists = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const OVERRIDE_INCLUDE = {
  createdBy: { select: { id: true, fullName: true } },
  revokedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.OrderMaterialArrivalOverrideInclude;

type OrderMaterialArrivalOverrideRow =
  Prisma.OrderMaterialArrivalOverrideGetPayload<{
    include: typeof OVERRIDE_INCLUDE;
  }>;

function toDto(
  row: OrderMaterialArrivalOverrideRow,
): OrderMaterialArrivalOverrideDto {
  return {
    id: row.id,
    orderId: row.orderId,
    workshopNeedId: row.workshopNeedId,
    materialRole: row.materialRole,
    description: row.description,
    qty: row.qty ? row.qty.toString() : null,
    unit: row.unit,
    status: row.status as OrderMaterialArrivalOverrideStatus,
    comment: row.comment,
    createdById: row.createdById,
    createdByName: row.createdBy?.fullName ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedById: row.revokedById,
    revokedByName: row.revokedBy?.fullName ?? null,
    revokeReason: row.revokeReason,
  };
}
