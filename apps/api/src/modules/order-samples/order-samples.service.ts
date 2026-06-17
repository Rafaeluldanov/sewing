import { Injectable, Logger } from '@nestjs/common';
import {
  OrderSampleStatus,
  OrderStatus,
  PassportEventType,
  PassportStatus,
  Role,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type {
  ApproveOrderSampleDto,
  CancelOrderSampleDto,
  OrderSampleBulkEffectDto,
  OrderSampleDto,
  OrderSampleListItemDto,
  RejectOrderSampleDto,
  StartOrderSampleDto,
} from '@sewing/shared/order-samples';

import {
  OrderSampleAlreadyActiveException,
  OrderSampleInvalidStatusException,
  OrderSampleNotFoundException,
  OrderSampleOrderInvalidStatusException,
  OrderSampleQtyExceedsOrderSizeQtyException,
  OrderSampleRejectionReasonRequiredException,
  OrderSampleSizeNotInOrderException,
} from '../../common/errors.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PassportNumberService } from '../passports/passport-number.service.js';
import { buildPassportQrPayload } from '../passports/qr.js';
import { WorkshopNeedsService } from '../workshop-needs/workshop-needs.service.js';

/**
 * Сервис «Сигнальный образец» (MVP).
 *
 * См. `docs/order-signal-sample-flow.md`,
 * `docs/order-signal-sample-recon.md`,
 * `prisma/schema.prisma::OrderSample`,
 * `packages/shared/src/order-samples.ts`.
 *
 * Ключевые инварианты:
 *   - НЕ мутируем `OrderItem.qtyPlan` — эффект на тираж считается
 *     логически через `OrderSampleBulkEffectDto.remainingQty`;
 *   - НЕ пишем `WorkshopNeed` в режиме `SAMPLE_ONLY` — materials
 *     preview-only остаётся за UI;
 *   - Sample-passport создаётся **в отдельном flow** от тиражного
 *     `PassportsService.create` (см. § «Sample-flow vs bulk-flow»
 *     ниже). Все шаги выполняются в одной `prisma.$transaction` —
 *     если что-то падает, OrderSample + Passport откатываются вместе.
 *
 * ### Sample-flow vs bulk-flow
 *
 * Тиражный `PassportsService.create` сознательно строго требует
 * `cutterId` (`@Roles CUTTER && active`), пишет immediate-сдельное
 * начисление раскройщику (ADR-0005). Это правильно для тиража, но
 * не для сигнального образца: образец — отдельный flow «попробовать
 * лекало в железе», менеджер запускает его до того, как раскройщик
 * вообще встаёт за раскрой.
 *
 * Поэтому sample-passport создаётся здесь со специально
 * «расслабленной» атрибуцией:
 *   - `cutterId` — `dto.cutterId` если передан, иначе actor
 *     (`creatorId`). Роль не проверяется (для тиража это `CUTTER`,
 *     для образца — кто угодно из активных сотрудников).
 *   - **immediate-начисление НЕ пишется** — для образца payroll
 *     out-of-scope (см. `docs/order-signal-sample-flow.md
 *     §«MVP-ограничения»`).
 *   - `currentOperationId = CUT_DIVISION` (тот же, что у тиражных
 *     паспортов) — оператор передвинет паспорт по маршруту через
 *     обычный flow `/work` (issue → scan → complete).
 *   - `currentRouteStepIndex = 0` если у заказа уже есть snapshot
 *     маршрута, иначе `null` (метаинформация sample-route в
 *     `OrderSample.routeTemplateId` остаётся отдельно).
 */
@Injectable()
export class OrderSamplesService {
  private readonly logger = new Logger(OrderSamplesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passportNumbers: PassportNumberService,
    private readonly workshopNeeds: WorkshopNeedsService,
  ) {}

  // -------------------------------------------------------------------------
  // START
  // -------------------------------------------------------------------------

  async start(
    orderId: string,
    dto: StartOrderSampleDto,
    actorEmployeeId: string,
    _actorRole: Role,
  ): Promise<OrderSampleDto> {
    // 1. Грузим заказ + items + действующие samples + snapshot маршрута.
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true } },
        samples: {
          where: {
            status: {
              in: [
                OrderSampleStatus.IN_PROGRESS,
                OrderSampleStatus.READY_FOR_APPROVAL,
              ],
            },
          },
          select: { id: true, productId: true, sizeId: true, status: true },
        },
        routeSteps: { select: { id: true } },
      },
    });
    if (!order) {
      throw new OrderSampleOrderInvalidStatusException('NOT_FOUND');
    }
    // Сигнальный образец можно запустить, НЕ запуская весь тираж в
    // производство. Допустимые статусы (см.
    // `@sewing/shared/orders::ORDER_SAMPLE_LAUNCHABLE_STATUSES` — тот
    // же список использует web-UI для кнопки «Запустить образец»):
    //   - `CALCULATION` / `CALCULATION_DONE` — образец без тиража,
    //     заказ переводится в `SAMPLE_PRODUCTION` (ниже, в транзакции);
    //   - `SAMPLE_PRODUCTION` — ещё один образец, статус не меняется;
    //   - `IN_PRODUCTION` — образец параллельно тиражу (старый flow),
    //     статус не меняется.
    // `DRAFT` исключён: образцу нужен рассчитанный план (маршрут /
    // техкарта фиксируются на этапе расчёта). `DONE` / `CANCELLED` —
    // заказ закрыт.
    const SAMPLE_LAUNCHABLE: OrderStatus[] = [
      OrderStatus.CALCULATION,
      OrderStatus.CALCULATION_DONE,
      OrderStatus.SAMPLE_PRODUCTION,
      OrderStatus.IN_PRODUCTION,
    ];
    if (!SAMPLE_LAUNCHABLE.includes(order.status)) {
      throw new OrderSampleOrderInvalidStatusException(order.status);
    }
    // Перевод заказа в «Производство сигнального образца» нужен только
    // из «расчётных» статусов. Из `SAMPLE_PRODUCTION` / `IN_PRODUCTION`
    // статус уже корректный — не трогаем.
    const shouldEnterSampleProduction =
      order.status === OrderStatus.CALCULATION ||
      order.status === OrderStatus.CALCULATION_DONE;

    // Резолвим OrderItem: если productId передан — точное совпадение
    // (orderId, productId, sizeId); иначе — единственную строку по
    // (orderId, sizeId).
    let orderItem;
    if (dto.productId) {
      orderItem = order.items.find(
        (it) => it.sizeId === dto.sizeId && it.productId === dto.productId,
      );
    } else {
      const matchingBySize = order.items.filter(
        (it) => it.sizeId === dto.sizeId,
      );
      if (matchingBySize.length === 1) {
        orderItem = matchingBySize[0];
      } else if (matchingBySize.length > 1) {
        // Несколько productId на один sizeId — требуем явный productId.
        throw new OrderSampleSizeNotInOrderException();
      }
    }
    if (!orderItem) {
      throw new OrderSampleSizeNotInOrderException();
    }
    const resolvedProductId = orderItem.productId;

    if (dto.countsTowardOrderQty && dto.qty > orderItem.qtyPlan) {
      throw new OrderSampleQtyExceedsOrderSizeQtyException(
        dto.qty,
        orderItem.qtyPlan,
      );
    }

    const hasActive = order.samples.some(
      (s) => s.productId === resolvedProductId && s.sizeId === dto.sizeId,
    );
    if (hasActive) {
      throw new OrderSampleAlreadyActiveException();
    }

    // 2. Резолвим cutter и creator. См. JSDoc класса §«Sample-flow vs
    //    bulk-flow»: для образца роль не проверяется, по умолчанию
    //    cutter = actor.
    const creator = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!creator) {
      throw new OrderSampleOrderInvalidStatusException('CREATOR_NOT_FOUND');
    }
    // Sample-flow cutter resolution (релаксированный, см. JSDoc класса):
    //   1. `dto.cutterId` указан и ссылается на активного сотрудника
    //      (роль любая) → используем его.
    //   2. Иначе → `cutterId = actorEmployeeId`. Sample НЕ падает на
    //      «не CUTTER» / «cutterId не задан» — это сознательное
    //      отличие от тиражного `PassportsService.create`.
    let cutterEmployeeId = actorEmployeeId;
    if (dto.cutterId && dto.cutterId !== actorEmployeeId) {
      const candidate = await this.prisma.employee.findUnique({
        where: { id: dto.cutterId },
        select: { id: true, active: true },
      });
      if (candidate && candidate.active) {
        cutterEmployeeId = candidate.id;
      }
      // Если кандидат не найден / неактивен — молча падаем на actor:
      // sample не должен падать на «выбран неподходящий сотрудник».
    }

    // Операция CUT_DIVISION — та же, что использует тиражный flow.
    // Оператор продолжает движение sample-passport через обычный
    // /work маршрут.
    const divisionOp = await this.prisma.operation.findUnique({
      where: { code: 'CUT_DIVISION' },
      select: { id: true },
    });
    if (!divisionOp) {
      throw new OrderSampleOrderInvalidStatusException('CUT_DIVISION_MISSING');
    }

    const initialRouteStepIndex = order.routeSteps.length > 0 ? 0 : null;
    const product = orderItem.product;
    const color = order.color ?? product.color;
    const cutDate = new Date();

    // 3. Атомарно создаём OrderSample + sample-passport + событие
    //    CREATED + аудит. Никаких immediate-начислений (см. JSDoc).
    const result = await this.prisma.$transaction(async (tx) => {
      const sample = await tx.orderSample.create({
        data: {
          orderId,
          productId: resolvedProductId,
          sizeId: dto.sizeId,
          qty: dto.qty,
          routeTemplateId: dto.routeTemplateId ?? null,
          materialMode: dto.materialMode,
          countsTowardOrderQty: dto.countsTowardOrderQty,
          status: OrderSampleStatus.IN_PROGRESS,
          comment: dto.comment ?? null,
          createdById: actorEmployeeId,
        },
      });

      // Запуск образца из «расчётных» статусов переводит заказ в
      // «Производство сигнального образца» — отдельный этап ДО полного
      // запуска тиража. Тиражный крой (`CuttingTask`) и тиражные
      // паспорта здесь НЕ создаются: это делает `OrdersService.start`
      // при последующем «Запустить в производство». Снапшоты маршрута /
      // техкарты уже зафиксированы на этапе расчёта, поэтому sample-
      // passport движется по обычному /work-маршруту.
      if (shouldEnterSampleProduction) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: OrderStatus.SAMPLE_PRODUCTION },
        });
      }

      const passportNumber = await this.passportNumbers.nextNumber(tx);
      const passport = await tx.passport.create({
        data: {
          number: passportNumber,
          // qrCode UNIQUE NOT NULL — финальный `passport:{id}` проставим
          // вторым шагом ниже, когда узнаем id.
          qrCode: `passport-pending:${passportNumber}`,
          orderId,
          productId: resolvedProductId,
          sizeId: dto.sizeId,
          color,
          rollNumber: `SAMPLE-${order.number}-${dto.sizeId.slice(-4)}`,
          cutDate,
          qtyPlan: dto.qty,
          qtyCut: dto.qty,
          qtyDefect: 0,
          qtyGood: dto.qty,
          status: PassportStatus.CREATED,
          currentOperationId: divisionOp.id,
          currentEmployeeId: actorEmployeeId,
          cutterId: cutterEmployeeId,
          creatorId: actorEmployeeId,
          currentRouteStepIndex: initialRouteStepIndex,
          sampleId: sample.id,
        },
      });
      await tx.passport.update({
        where: { id: passport.id },
        data: { qrCode: buildPassportQrPayload(passport.id) },
      });
      await tx.passportEvent.create({
        data: {
          passportId: passport.id,
          type: PassportEventType.CREATED,
          operationId: divisionOp.id,
          employeeId: actorEmployeeId,
          qty: dto.qty,
          payload: {
            rollNumber: `SAMPLE-${order.number}-${dto.sizeId.slice(-4)}`,
            color,
            origin: 'ORDER_SAMPLE',
            sampleId: sample.id,
          },
        },
      });

      // Sample-needs: считаем потребность материалов на sampleQty
      // выбранного размера и пишем `WorkshopNeed` с
      // `orderSampleId = sample.id`. См.
      // `WorkshopNeedsService.calculateForSampleInTx` — atomic в
      // рамках этой же транзакции, тиражные строки (`orderSampleId =
      // null`) не трогаются. Если у заказа нет техкарты/snapshot —
      // fail-soft: warning в audit, count=0, sample создаётся.
      const needsResult = await this.workshopNeeds.calculateForSampleInTx(
        tx,
        {
          id: sample.id,
          orderId,
          sizeId: dto.sizeId,
          qty: dto.qty,
          materialMode: dto.materialMode,
        },
        actorEmployeeId,
      );

      await this.audit.log(
        {
          event: 'ORDER_SAMPLE_STARTED',
          entityType: 'ORDER_SAMPLE',
          entityId: sample.id,
          employeeId: actorEmployeeId,
          payload: {
            orderId,
            productId: resolvedProductId,
            sizeId: dto.sizeId,
            qty: dto.qty,
            materialMode: dto.materialMode,
            countsTowardOrderQty: dto.countsTowardOrderQty,
            passportId: passport.id,
            passportNumber: passport.number,
            cutterEmployeeId,
            workshopNeedsCount: needsResult.count,
            timestamp: new Date().toISOString(),
          },
        },
        tx,
      );

      return {
        sampleId: sample.id,
        passportId: passport.id,
        needsCount: needsResult.count,
      };
    });

    this.logger.log(
      `event=order-sample.start sampleId=${result.sampleId} passportId=${result.passportId} orderId=${orderId} sizeId=${dto.sizeId} qty=${dto.qty} mode=${dto.materialMode} counts=${dto.countsTowardOrderQty} cutter=${cutterEmployeeId} needs=${result.needsCount}`,
    );

    return this.getOne(result.sampleId);
  }

  // -------------------------------------------------------------------------
  // LIST / GET ONE
  // -------------------------------------------------------------------------

  async listByOrder(orderId: string): Promise<OrderSampleListItemDto[]> {
    const rows = await this.prisma.orderSample.findMany({
      where: { orderId },
      include: {
        product: true,
        size: true,
        routeTemplate: true,
        passport: { select: { id: true, number: true, status: true, qtyCut: true } },
        order: { include: { items: { select: { sizeId: true, productId: true, qtyPlan: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toListItem(row));
  }

  async getOne(id: string): Promise<OrderSampleDto> {
    const row = await this.prisma.orderSample.findUnique({
      where: { id },
      include: {
        product: true,
        size: true,
        routeTemplate: true,
        passport: { select: { id: true, number: true, status: true, qtyCut: true } },
        order: { include: { items: { select: { sizeId: true, productId: true, qtyPlan: true } } } },
      },
    });
    if (!row) throw new OrderSampleNotFoundException();
    return this.toDetail(row);
  }

  // -------------------------------------------------------------------------
  // APPROVE / REJECT / CANCEL
  // -------------------------------------------------------------------------

  async approve(
    id: string,
    dto: ApproveOrderSampleDto,
    actorEmployeeId: string,
  ): Promise<OrderSampleDto> {
    const sample = await this.prisma.orderSample.findUnique({ where: { id } });
    if (!sample) throw new OrderSampleNotFoundException();
    if (sample.status !== OrderSampleStatus.IN_PROGRESS) {
      throw new OrderSampleInvalidStatusException(sample.status, 'approve');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderSample.update({
        where: { id },
        data: {
          status: OrderSampleStatus.APPROVED,
          approvedAt: new Date(),
          approvedById: actorEmployeeId,
          comment: dto.comment ?? sample.comment,
        },
      });
      await this.audit.log(
        {
          event: 'ORDER_SAMPLE_APPROVED',
          entityType: 'ORDER_SAMPLE',
          entityId: id,
          employeeId: actorEmployeeId,
          payload: {
            orderId: sample.orderId,
            sizeId: sample.sizeId,
            qty: sample.qty,
            countsTowardOrderQty: sample.countsTowardOrderQty,
            timestamp: new Date().toISOString(),
          },
        },
        tx,
      );
    });

    this.logger.log(`event=order-sample.approve sampleId=${id} actor=${actorEmployeeId}`);
    return this.getOne(id);
  }

  async reject(
    id: string,
    dto: RejectOrderSampleDto,
    actorEmployeeId: string,
  ): Promise<OrderSampleDto> {
    if (!dto.reason || dto.reason.trim().length === 0) {
      throw new OrderSampleRejectionReasonRequiredException();
    }

    const sample = await this.prisma.orderSample.findUnique({ where: { id } });
    if (!sample) throw new OrderSampleNotFoundException();
    if (sample.status !== OrderSampleStatus.IN_PROGRESS) {
      throw new OrderSampleInvalidStatusException(sample.status, 'reject');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderSample.update({
        where: { id },
        data: {
          status: OrderSampleStatus.REJECTED,
          rejectedAt: new Date(),
          rejectedById: actorEmployeeId,
          rejectionReason: dto.reason,
        },
      });
      await this.audit.log(
        {
          event: 'ORDER_SAMPLE_REJECTED',
          entityType: 'ORDER_SAMPLE',
          entityId: id,
          employeeId: actorEmployeeId,
          payload: {
            orderId: sample.orderId,
            rejectionReason: dto.reason,
            timestamp: new Date().toISOString(),
          },
        },
        tx,
      );
    });

    this.logger.log(`event=order-sample.reject sampleId=${id} actor=${actorEmployeeId}`);
    return this.getOne(id);
  }

  async cancel(
    id: string,
    dto: CancelOrderSampleDto,
    actorEmployeeId: string,
  ): Promise<OrderSampleDto> {
    const sample = await this.prisma.orderSample.findUnique({ where: { id } });
    if (!sample) throw new OrderSampleNotFoundException();
    if (sample.status !== OrderSampleStatus.IN_PROGRESS) {
      throw new OrderSampleInvalidStatusException(sample.status, 'cancel');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderSample.update({
        where: { id },
        data: {
          status: OrderSampleStatus.CANCELLED,
          cancelledAt: new Date(),
          comment: dto.comment ?? sample.comment,
        },
      });
      await this.audit.log(
        {
          event: 'ORDER_SAMPLE_CANCELLED',
          entityType: 'ORDER_SAMPLE',
          entityId: id,
          employeeId: actorEmployeeId,
          payload: {
            orderId: sample.orderId,
            comment: dto.comment ?? null,
            timestamp: new Date().toISOString(),
          },
        },
        tx,
      );
    });

    this.logger.log(`event=order-sample.cancel sampleId=${id} actor=${actorEmployeeId}`);
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildBulkEffect(row: SampleWithIncludes): OrderSampleBulkEffectDto {
    const orderItem = row.order.items.find(
      (it) => it.sizeId === row.sizeId && it.productId === row.productId,
    );
    const orderSizeQtyPlan = orderItem?.qtyPlan ?? 0;
    const counts = row.countsTowardOrderQty;
    const active =
      row.status === OrderSampleStatus.IN_PROGRESS ||
      row.status === OrderSampleStatus.READY_FOR_APPROVAL ||
      row.status === OrderSampleStatus.APPROVED;
    const remainingQty =
      counts && active ? Math.max(orderSizeQtyPlan - row.qty, 0) : orderSizeQtyPlan;
    const extraSampleQty = !counts && active ? row.qty : 0;
    return {
      sizeId: row.sizeId,
      sizeCode: row.size.code,
      orderSizeQtyPlan,
      sampleQty: row.qty,
      countsTowardOrderQty: counts,
      remainingQty,
      extraSampleQty,
    };
  }

  private toListItem(row: SampleWithIncludes): OrderSampleListItemDto {
    return {
      id: row.id,
      orderId: row.orderId,
      product: { id: row.product.id, name: row.product.name },
      size: {
        id: row.size.id,
        code: row.size.code,
        sortOrder: row.size.sortOrder,
      },
      qty: row.qty,
      materialMode: row.materialMode,
      countsTowardOrderQty: row.countsTowardOrderQty,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      passport: row.passport
        ? {
            id: row.passport.id,
            number: row.passport.number,
            status: row.passport.status as PassportStatus,
            qtyCut: row.passport.qtyCut,
          }
        : null,
      bulkEffect: this.buildBulkEffect(row),
    };
  }

  private toDetail(row: SampleWithIncludes): OrderSampleDto {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.number,
      product: { id: row.product.id, name: row.product.name },
      size: {
        id: row.size.id,
        code: row.size.code,
        sortOrder: row.size.sortOrder,
      },
      qty: row.qty,
      routeTemplate: row.routeTemplate
        ? {
            id: row.routeTemplate.id,
            code: row.routeTemplate.code,
            name: row.routeTemplate.name,
          }
        : null,
      materialMode: row.materialMode,
      countsTowardOrderQty: row.countsTowardOrderQty,
      status: row.status,
      comment: row.comment,
      rejectionReason: row.rejectionReason,
      createdById: row.createdById,
      approvedById: row.approvedById,
      rejectedById: row.rejectedById,
      createdAt: row.createdAt.toISOString(),
      approvedAt: row.approvedAt?.toISOString() ?? null,
      rejectedAt: row.rejectedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      passport: row.passport
        ? {
            id: row.passport.id,
            number: row.passport.number,
            status: row.passport.status as PassportStatus,
            qtyCut: row.passport.qtyCut,
          }
        : null,
      bulkEffect: this.buildBulkEffect(row),
    };
  }
}

type SampleWithIncludes = Prisma.OrderSampleGetPayload<{
  include: {
    product: true;
    size: true;
    routeTemplate: true;
    passport: { select: { id: true; number: true; status: true; qtyCut: true } };
    order: { include: { items: { select: { sizeId: true; productId: true; qtyPlan: true } } } };
  };
}>;
