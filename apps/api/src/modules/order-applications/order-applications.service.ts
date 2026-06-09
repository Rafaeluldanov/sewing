import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  ORDER_APPLICATION_STAGE_LABELS,
  ORDER_APPLICATION_STATUS_LABELS,
  ORDER_APPLICATION_TYPE_LABELS,
  type OrderApplicationDto,
  type OrderApplicationStage,
  type OrderApplicationStatus,
  type OrderApplicationType,
  type ReplaceOrderApplicationsDto,
} from '@sewing/shared/order-applications';

import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OrderApplicationOrderLockedException } from '../../common/errors.js';

/**
 * Сервис «Нанесение на заказе покупателя» (см.
 * `prisma/schema.prisma::OrderApplication`,
 * `packages/shared/src/order-applications.ts`).
 *
 * Контракт:
 *   - `listForOrder(orderId)`  — отдаёт массив `OrderApplicationDto`,
 *     уже с лейблами для UI;
 *   - `replaceForOrder(...)`   — full-replace списка нанесений
 *     одного заказа в одной транзакции (delete + createMany), плюс
 *     одна строка `ORDER_APPLICATIONS_REPLACED` в `AuditLog`.
 *
 * Замок по статусу (`ORDER_APPLICATION_ORDER_LOCKED`):
 *   - менять можно только в `DRAFT`. На `CALCULATION` /
 *     `IN_PRODUCTION` / `DONE` / `CANCELLED` — 409 (см. ТЗ
 *     §«Правила»). Чтение разрешено всегда — UI карточки заказа
 *     показывает read-only список после расчёта.
 *
 * Аудит:
 *   - `ORDER_APPLICATIONS_REPLACED` — событие на каждый успешный
 *     PUT, в payload фиксируем previousCount / nextCount /
 *     перечень типов и stage-разбивку. Минимально полезный срез,
 *     достаточный, чтобы по журналу понять «когда и сколько
 *     нанесений было на заказе».
 */
@Injectable()
export class OrderApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<OrderApplicationDto[]> {
    // Сначала проверяем, что заказ существует — иначе UI клиент
    // рискует «молча» получать пустой массив на 404-заказ.
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

    const rows = await this.prisma.orderApplication.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        // Адресация по размерам (этап «Нанесение по размерам»).
        // Сортировка по `Size.sortOrder` — стабильный для UI порядок
        // (S, M, L, …).
        sizes: {
          include: { size: true },
          orderBy: { size: { sortOrder: 'asc' } },
        },
      },
    });
    return rows.map((r) => this.toDto(r));
  }

  // -------------------------------------------------------------------------
  // REPLACE (PUT)
  // -------------------------------------------------------------------------

  async replaceForOrder(
    orderId: string,
    dto: ReplaceOrderApplicationsDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderApplicationDto[]> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        // Размеры заказа — чтобы отфильтровать адресацию нанесений
        // только на реально существующие в заказе размеры (защита от
        // рассинхрона UI и FK-ошибок).
        items: { select: { sizeId: true } },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.DRAFT) {
      throw new OrderApplicationOrderLockedException();
    }

    const orderSizeIds = new Set(order.items.map((it) => it.sizeId));

    const existing = await this.prisma.orderApplication.findMany({
      where: { orderId },
      select: { id: true, type: true, stage: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // Удаление нанесений каскадом сносит их `OrderApplicationSize`
      // (onDelete: Cascade), отдельный deleteMany не нужен.
      await tx.orderApplication.deleteMany({ where: { orderId } });
      // Вложенный create на каждое нанесение (а не createMany), чтобы
      // в одной транзакции создать и адресацию по размерам
      // (`OrderApplicationSize`). Размеры фильтруем по фактическим
      // размерам заказа и дедупим по `sizeId`.
      for (const app of dto.applications) {
        const sizeRows = dedupeBySizeId(app.sizes ?? []).filter((s) =>
          orderSizeIds.has(s.sizeId),
        );
        await tx.orderApplication.create({
          data: {
            orderId,
            type: app.type,
            stage: app.stage,
            placement: app.placement ?? null,
            widthMm: app.widthMm ?? null,
            heightMm: app.heightMm ?? null,
            colorsCount: app.colorsCount ?? null,
            quantity:
              app.quantity == null ? null : new Prisma.Decimal(app.quantity),
            // Дефолт «шт» — на уровне БД, но передаём явно, если
            // менеджер указал свою единицу. Пустую строку Zod уже
            // нормализовал в undefined.
            unit: app.unit ?? 'шт',
            colorText: app.colorText ?? null,
            description: app.description ?? null,
            comment: app.comment ?? null,
            fileUrl: app.fileUrl ?? null,
            status: app.status ?? 'PLANNED',
            sizes:
              sizeRows.length > 0
                ? {
                    create: sizeRows.map((s) => ({
                      sizeId: s.sizeId,
                      quantity:
                        s.quantity == null
                          ? null
                          : new Prisma.Decimal(s.quantity),
                    })),
                  }
                : undefined,
          },
        });
      }

      await this.audit.log(
        {
          event: 'ORDER_APPLICATIONS_REPLACED',
          entityType: 'ORDER_APPLICATION',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            previousCount: existing.length,
            nextCount: dto.applications.length,
            stages: this.countByKey(
              dto.applications.map((a) => a.stage),
            ),
            types: this.countByKey(
              dto.applications.map((a) => a.type),
            ),
          },
        },
        tx,
      );
    });

    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private toDto(row: OrderApplicationWithSizes): OrderApplicationDto {
    const type = row.type as OrderApplicationType;
    const stage = row.stage as OrderApplicationStage;
    const status = row.status as OrderApplicationStatus;
    return {
      id: row.id,
      orderId: row.orderId,
      type,
      typeLabel: ORDER_APPLICATION_TYPE_LABELS[type] ?? row.type,
      stage,
      stageLabel: ORDER_APPLICATION_STAGE_LABELS[stage] ?? row.stage,
      placement: row.placement,
      widthMm: row.widthMm,
      heightMm: row.heightMm,
      colorsCount: row.colorsCount,
      quantity: row.quantity ? row.quantity.toString() : null,
      unit: row.unit,
      colorText: row.colorText,
      description: row.description,
      comment: row.comment,
      fileUrl: row.fileUrl,
      status,
      statusLabel: ORDER_APPLICATION_STATUS_LABELS[status] ?? row.status,
      sizes: row.sizes.map((s) => ({
        sizeId: s.sizeId,
        sizeCode: s.size.code,
        quantity: s.quantity ? s.quantity.toString() : null,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private countByKey(values: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of values) out[v] = (out[v] ?? 0) + 1;
    return out;
  }
}

/**
 * Прибраться от дублей размеров внутри одного нанесения: оставляем
 * первое вхождение каждого `sizeId`. БД защищена `@@unique`, но
 * фильтруем заранее, чтобы транзакция не падала на дубле.
 */
function dedupeBySizeId<T extends { sizeId: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.sizeId)) continue;
    seen.add(r.sizeId);
    out.push(r);
  }
  return out;
}

/**
 * Тип строки `OrderApplication` с подгруженной адресацией по размерам
 * (`sizes[].size`). Совпадает с include в `listForOrder`.
 */
type OrderApplicationWithSizes = Prisma.OrderApplicationGetPayload<{
  include: { sizes: { include: { size: true } } };
}>;
