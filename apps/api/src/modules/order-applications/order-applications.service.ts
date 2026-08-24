import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import {
  isOrderApplicationsEditable,
  isOrderApplicationsLateEdit,
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
import { WorkshopNeedsService } from '../workshop-needs/workshop-needs.service.js';
import {
  OrderApplicationHasPurchaseException,
  OrderApplicationOrderLockedException,
} from '../../common/errors.js';

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
 *   - менять можно на ЛЮБОЙ стадии, кроме `CANCELLED` (единый список —
 *     `ORDER_APPLICATION_EDITABLE_ORDER_STATUSES` в shared). Раньше
 *     окно кончалось на `CALCULATION`, но клиент просит добавить принт
 *     и тогда, когда тираж уже кроят: запрет не отменял расход, а
 *     заставлял вести его мимо системы.
 *   - `DRAFT` / `CALCULATION` — как и было: на `CALCULATION` правка
 *     пересобирает потребность цеха целиком
 *     (`WorkshopNeedsService.calculateForOrder`), тот же приём, что у
 *     расцветок (`resyncColorwayDerived`).
 *   - `CALCULATION_DONE` и дальше (`isOrderApplicationsLateEdit`) —
 *     «поздняя» правка: потребность синхронизируется ТОЧЕЧНО
 *     (`WorkshopNeedsService.syncApplicationNeeds`), полный пересчёт
 *     там всё равно отбился бы `WORKSHOP_NEEDS_ALREADY_REVIEWED`, а с
 *     `force` снёс бы работу закупщика по соседним строкам.
 *   - удаление в поздних статусах ограничено: нанесение, по которому
 *     потребность уже ушла в закупку, не удаляется (409
 *     `ORDER_APPLICATION_HAS_PURCHASE`) — гасить строку нужно осознанно
 *     на экране «Потребности».
 *
 * Сверка списка идёт ПО `id` (`OrderApplicationInputSchema.id`):
 * пришедшие с id строки обновляются на месте, без id — создаются,
 * отсутствующие — удаляются. Безусловный delete+create ломал бы
 * `WorkshopNeed.sourceId` (снимок ссылается на id нанесения).
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
  private static readonly log = new Logger(OrderApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workshopNeeds: WorkshopNeedsService,
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
        // Фича «Варианты просчёта»: потребность пересчитываем только у
        // варианта, ЯВНО отправленного на расчёт (тот же guard, что в
        // `OrdersService.resyncColorwayDerived`).
        calculations: {
          where: { isActive: true },
          select: { sentToCalculationAt: true },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (!isOrderApplicationsEditable(order.status)) {
      throw new OrderApplicationOrderLockedException();
    }
    // «Поздняя» правка — расчёт уже завершён (CALCULATION_DONE и
    // дальше). Отличается двумя вещами: удаление ограничено (см. ниже)
    // и потребность синхронизируется точечно, а не пересчётом.
    const lateEdit = isOrderApplicationsLateEdit(order.status);

    const orderSizeIds = new Set(order.items.map((it) => it.sizeId));

    const existing = await this.prisma.orderApplication.findMany({
      where: { orderId },
      select: { id: true, type: true, stage: true },
    });
    const existingIds = new Set(existing.map((e) => e.id));

    // Сверка по `id`: строка с известным id обновляется НА МЕСТЕ.
    // Пересоздание меняло бы id, а на него ссылается снимок потребности
    // (`WorkshopNeed.sourceId`) вместе с ценой и поставщиком.
    // Неизвестный id (старый клиент, чужая строка) трактуем как новую
    // строку — запрос не роняем.
    const keepIds = new Set(
      dto.applications
        .map((a) => a.id)
        .filter((id): id is string => !!id && existingIds.has(id)),
    );
    const doomedIds = [...existingIds].filter((id) => !keepIds.has(id));

    // Удаление после расчёта разрешено, только пока по нанесению не
    // пошла закупка: строка потребности нетронута и без движений
    // склада. Иначе — 409 с перечнем позиций (гасить их нужно осознанно
    // на экране «Потребности»).
    if (lateEdit && doomedIds.length > 0) {
      const blocking = await this.prisma.workshopNeed.findMany({
        where: {
          orderId,
          sourceType: 'ORDER_APPLICATION',
          sourceId: { in: doomedIds },
          OR: [
            { status: { not: 'CALCULATED' } },
            { manualEditAt: { not: null } },
            { stockMovements: { some: {} } },
          ],
        },
        select: { description: true },
      });
      if (blocking.length > 0) {
        const names = blocking
          .map((b) => `«${b.description}»`)
          .slice(0, 5)
          .join(', ');
        throw new OrderApplicationHasPurchaseException(
          `Нельзя удалить нанесение после завершения расчёта: по нему уже идёт закупка (${names}). ` +
            'Снимите строку на экране «Потребности», затем повторите правку.',
        );
      }
    }

    let createdCount = 0;
    let updatedCount = 0;
    // Один id — одна строка. Если клиент прислал его дважды (например,
    // скопировал нанесение, не сбросив ключ), второй раз трактуем как
    // новую строку: иначе копия молча схлопнулась бы в оригинал.
    const usedIds = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      // Удаляем только то, что не пришло в теле. Каскад сносит
      // `OrderApplicationSize` (onDelete: Cascade).
      if (doomedIds.length > 0) {
        await tx.orderApplication.deleteMany({
          where: { id: { in: doomedIds } },
        });
      }
      // Вложенный create на каждое нанесение (а не createMany), чтобы
      // в одной транзакции создать и адресацию по размерам
      // (`OrderApplicationSize`). Размеры фильтруем по фактическим
      // размерам заказа и дедупим по `sizeId`.
      for (const app of dto.applications) {
        const sizeRows = dedupeBySizeId(app.sizes ?? []).filter((s) =>
          orderSizeIds.has(s.sizeId),
        );
        const sizeCreate = sizeRows.map((s) => ({
          sizeId: s.sizeId,
          quantity:
            s.quantity == null ? null : new Prisma.Decimal(s.quantity),
        }));
        const data = {
          type: app.type,
          stage: app.stage,
          placement: app.placement ?? null,
          widthMm: app.widthMm ?? null,
          heightMm: app.heightMm ?? null,
          colorsCount: app.colorsCount ?? null,
          // Адресация по размерам старше order-level количества: при
          // непустых `sizes` тираж считается по каждому размеру, а
          // `quantity` игнорируется (контракт
          // `OrderApplicationInputSchema`). Сохранять его «на всякий
          // случай» нельзя: расчёт потребности его не видит
          // (`WorkshopNeedsService.computeApplication` при наличии
          // размеров суммирует размеры), а карточка заказа показывала
          // бы число, которое ни на что не влияет.
          quantity:
            sizeCreate.length > 0 || app.quantity == null
              ? null
              : new Prisma.Decimal(app.quantity),
          // Дефолт «шт» — на уровне БД, но передаём явно, если
          // менеджер указал свою единицу. Пустую строку Zod уже
          // нормализовал в undefined.
          unit: app.unit ?? 'шт',
          colorText: app.colorText ?? null,
          description: app.description ?? null,
          comment: app.comment ?? null,
          fileUrl: app.fileUrl ?? null,
          groupKey: app.groupKey ?? null,
          groupLabel: app.groupLabel ?? null,
        };

        if (app.id && keepIds.has(app.id) && !usedIds.has(app.id)) {
          usedIds.add(app.id);
          await tx.orderApplication.update({
            where: { id: app.id },
            data: {
              ...data,
              // Статус строки менеджер ведёт сам; если клиент его не
              // прислал — оставляем как есть, а не сбрасываем в PLANNED.
              ...(app.status ? { status: app.status } : {}),
              // Адресацию по размерам проще пересобрать: строк единицы,
              // а diff по (applicationId, sizeId) ничего не экономит.
              sizes: {
                deleteMany: {},
                ...(sizeCreate.length > 0 ? { create: sizeCreate } : {}),
              },
            },
          });
          updatedCount += 1;
          continue;
        }

        await tx.orderApplication.create({
          data: {
            orderId,
            ...data,
            status: app.status ?? 'PLANNED',
            sizes: sizeCreate.length > 0 ? { create: sizeCreate } : undefined,
          },
        });
        createdCount += 1;
      }

      await this.audit.log(
        {
          event: 'ORDER_APPLICATIONS_REPLACED',
          entityType: 'ORDER_APPLICATION',
          entityId: orderId,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId,
            // Статус на момент правки — по журналу видно, что нанесение
            // добавили уже в производстве.
            orderStatus: order.status,
            lateEdit,
            previousCount: existing.length,
            nextCount: dto.applications.length,
            createdCount,
            updatedCount,
            removedCount: doomedIds.length,
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

    // Потребность цеха: строки `WorkshopNeed` с
    // `sourceType = ORDER_APPLICATION` — производные от нанесений.
    // В `DRAFT` их ещё нет (расчёт не запускали), а на `CALCULATION`
    // они уже посчитаны и после правки устарели бы — пересобираем.
    //
    // Best-effort и осознанно: сами нанесения (источник истины) уже
    // сохранены, а пересчёт может быть законно заблокирован — строки
    // потребности уже проверены/заказаны
    // (`WORKSHOP_NEEDS_ALREADY_REVIEWED`) или по ним есть складские
    // движения (`WORKSHOP_NEEDS_HAVE_STOCK`). Ронять из-за этого
    // сохранение нанесений нельзя — иначе «разблокировали правку», а
    // она падает 409. Пишем warn: менеджер пересчитает потребность
    // руками (кнопка «Пересчитать» умеет force).
    const activeCalculation = order.calculations[0];
    const activeVariantSent =
      !activeCalculation || activeCalculation.sentToCalculationAt != null;
    if (order.status === OrderStatus.CALCULATION && activeVariantSent) {
      try {
        await this.workshopNeeds.calculateForOrder(
          orderId,
          { force: false },
          actorEmployeeId ?? null,
        );
      } catch (e) {
        OrderApplicationsService.log.warn(
          `event=order_applications.needs_recalc_skipped order=${orderId} ` +
            `reason=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else if (lateEdit) {
      // После завершения расчёта полный пересчёт не годится: он
      // пересобирает ВСЮ потребность и на запущенном заказе упрётся в
      // `WORKSHOP_NEEDS_ALREADY_REVIEWED` / `WORKSHOP_NEEDS_HAVE_STOCK`,
      // а с `force` снёс бы работу закупщика по соседним строкам.
      // Синхронизируем точечно только строки нанесений — добавленное
      // нанесение сразу доходит до потребности и себестоимости.
      //
      // Best-effort по тем же соображениям, что и выше: сами нанесения
      // (источник истины) уже сохранены, ронять их из-за неудачной
      // синхронизации нельзя.
      try {
        const res = await this.workshopNeeds.syncApplicationNeeds(
          orderId,
          actorEmployeeId ?? null,
        );
        if (res.warnings.length > 0) {
          OrderApplicationsService.log.warn(
            `event=order_applications.needs_sync_warnings order=${orderId} ` +
              `warnings=${res.warnings.join(' | ')}`,
          );
        }
      } catch (e) {
        OrderApplicationsService.log.warn(
          `event=order_applications.needs_sync_skipped order=${orderId} ` +
            `reason=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

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
      groupKey: row.groupKey,
      groupLabel: row.groupLabel,
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
