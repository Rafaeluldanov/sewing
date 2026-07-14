import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateOrderTechCardParameterDto,
  OrderTechCardParametersDto,
  OrderTechCardTargetOptionDto,
  OrderTechCardVariantParamsDto,
  SetOrderTechCardParameterValueDto,
} from '@sewing/shared/order-tech-cards';
import {
  getTechCardParameterTarget,
  type OrderTechCardParameterDto,
  type TechCardParameterBindings,
  type TechCardParameterInputType,
  type TechCardParameterOwner,
  type TechCardParameterValueSource,
} from '@sewing/shared/tech-card-parameters';

import { PrismaService } from '../../prisma/prisma.service.js';
import { OrdersService } from '../orders/orders.service.js';

/**
 * Параметры техкарты внутри заказа: значения по расцветкам + ad-hoc слоты.
 *
 * Устройство скопировано с `OrderColorwaysService` (см. соседний модуль):
 * правка только в DRAFT/CALCULATION, каждый write заканчивается
 * `OrdersService.resyncColorwayDerived` и возвращает свежий полный DTO.
 *
 * Почему именно resync, а не точечный UPDATE снимка: у проекта уже дважды
 * горело на том, что производные (снимок → потребность → план) собирались в
 * обход единого пути. Значение параметра меняет ячейку строки → меняет
 * потребность цеха, поэтому идём тем же путём, что и правка расцветки.
 */
@Injectable()
export class OrderTechCardService {
  private readonly logger = new Logger(OrderTechCardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  async listForOrder(orderId: string): Promise<OrderTechCardParametersDto> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        color: true,
        techCardId: true,
        techCard: { select: { name: true } },
        variants: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            color: true,
            techCardId: true,
            techCard: { select: { name: true } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });

    const [params, requirements] = await Promise.all([
      this.prisma.orderTechCardParameter.findMany({
        where: { orderId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.orderMaterialRequirement.findMany({
        where: { orderId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          orderVariantId: true,
          name: true,
          materialRole: true,
          parameterBindings: true,
        },
      }),
    ]);

    // Группы снимка: ≥2 расцветок → по расцветке; иначе одна order-level
    // (`orderVariantId = null`) — та же логика, что в снимке заказа.
    const groups: Array<{
      orderVariantId: string | null;
      color: string | null;
      techCardId: string | null;
      techCardName: string | null;
    }> =
      order.variants.length >= 2
        ? order.variants.map((v) => ({
            orderVariantId: v.id,
            color: v.color,
            techCardId: v.techCardId ?? order.techCardId,
            techCardName: v.techCard?.name ?? order.techCard?.name ?? null,
          }))
        : [
            {
              orderVariantId: null,
              color: order.variants[0]?.color ?? order.color,
              techCardId: order.variants[0]?.techCardId ?? order.techCardId,
              techCardName:
                order.variants[0]?.techCard?.name ?? order.techCard?.name ?? null,
            },
          ];

    const vk = (v: string | null) => v ?? '';
    const variants: OrderTechCardVariantParamsDto[] = groups.map((g) => {
      const gk = vk(g.orderVariantId);
      const rows = requirements.filter((r) => vk(r.orderVariantId) === gk);

      // Кто какую ячейку уже занял — чтобы UI не предлагал привязать второй
      // параметр в ту же ячейку (два писателя = молчаливый баг).
      const targets: OrderTechCardTargetOptionDto[] = [];
      for (const r of rows) {
        const bindings = (r.parameterBindings ??
          null) as TechCardParameterBindings | null;
        for (const target of this.targetsForLine()) {
          targets.push({
            requirementId: r.id,
            lineName: r.name,
            field: target.field,
            fieldLabel: target.label,
            valueType: target.valueType,
            unit: target.unit ?? null,
            takenByKey: bindings?.[target.field] ?? null,
          });
        }
      }

      const groupParams = params
        .filter((p) => vk(p.orderVariantId) === gk)
        .map((p) => this.toParamDto(p, rows));

      return {
        orderVariantId: g.orderVariantId,
        color: g.color,
        techCardId: g.techCardId,
        techCardName: g.techCardName,
        parameters: groupParams,
        missingRequiredCount: groupParams.filter(
          (p) => p.isRequired && (p.value == null || p.value.trim() === ''),
        ).length,
        targets,
      };
    });

    return {
      orderId: order.id,
      editable: order.status === 'DRAFT' || order.status === 'CALCULATION',
      variants,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE
  // -------------------------------------------------------------------------

  /** Заполнить/очистить значение слота. */
  async setValue(
    orderId: string,
    parameterId: string,
    dto: SetOrderTechCardParameterValueDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const param = await this.findParam(orderId, parameterId);

    const raw = dto.value?.trim() ?? '';
    this.assertValueValid(param, raw);

    await this.prisma.orderTechCardParameter.update({
      where: { id: param.id },
      data: {
        value: raw === '' ? null : raw,
        valueSource: 'MANUAL',
        valueUpdatedAt: new Date(),
        valueUpdatedById: actorEmployeeId ?? null,
      },
    });

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    this.logger.log(
      `event=order_tech_card.value_set order=${orderId} key=${param.key} value=${raw || '∅'}`,
    );
    return this.listForOrder(orderId);
  }

  /**
   * Скопировать значение слота во все остальные расцветки заказа (тот же ключ).
   * Это РАЗОВОЕ КОПИРОВАНИЕ, а не связь: разошлись потом — так решил технолог,
   * и это видно в списке. Именно поэтому у параметров нет «уровня заказа».
   */
  async applyToAllVariants(
    orderId: string,
    parameterId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const param = await this.findParam(orderId, parameterId);

    const { count } = await this.prisma.orderTechCardParameter.updateMany({
      where: { orderId, key: param.key, id: { not: param.id } },
      data: {
        value: param.value,
        valueSource: 'MANUAL',
        valueUpdatedAt: new Date(),
        valueUpdatedById: actorEmployeeId ?? null,
      },
    });

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    this.logger.log(
      `event=order_tech_card.apply_to_all order=${orderId} key=${param.key} affected=${count}`,
    );
    return this.listForOrder(orderId);
  }

  /** Завести слот, которого нет в шаблоне — только в этом заказе. */
  async createAdHoc(
    orderId: string,
    dto: CreateOrderTechCardParameterDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);

    const variantId = dto.orderVariantId ?? null;
    const duplicate = await this.prisma.orderTechCardParameter.findFirst({
      where: { orderId, orderVariantId: variantId, key: dto.key },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_PARAMETER_DUPLICATE',
        message: `Параметр «${dto.key}» уже есть у этой расцветки.`,
      });
    }

    // Цель обязана быть строкой ЭТОЙ же группы: значение параметра одной
    // расцветки не должно подставляться в ячейку другой.
    let requirement: { id: string; parameterBindings: Prisma.JsonValue | null } | null =
      null;
    if (dto.target) {
      const row = await this.prisma.orderMaterialRequirement.findFirst({
        where: {
          id: dto.target.requirementId,
          orderId,
          orderVariantId: variantId,
        },
        select: { id: true, parameterBindings: true },
      });
      if (!row) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'ORDER_MATERIAL_REQUIREMENT_NOT_FOUND',
          message: 'Строка материала не найдена в этой расцветке.',
        });
      }
      const bindings = (row.parameterBindings ??
        null) as TechCardParameterBindings | null;
      const taken = bindings?.[dto.target.field];
      if (taken) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_TECH_CARD_CELL_TAKEN',
          message: `Ячейка уже привязана к параметру «${taken}». Снимите привязку или выберите другую ячейку.`,
        });
      }
      requirement = row;
    }

    const raw = dto.value?.trim() ?? '';

    await this.prisma.$transaction(async (tx) => {
      await tx.orderTechCardParameter.create({
        data: {
          orderId,
          orderVariantId: variantId,
          key: dto.key,
          label: dto.label,
          inputType: dto.inputType,
          options:
            dto.inputType === 'ENUM' && dto.options && dto.options.length > 0
              ? (dto.options as Prisma.InputJsonValue)
              : Prisma.DbNull,
          unit: dto.unit ?? null,
          isRequired: dto.isRequired,
          // sourceTechCardId = null — признак ad-hoc: такой слот переживает
          // пересборку снимка и не удаляется при смене шаблона.
          sourceTechCardId: null,
          sourceParameterId: null,
          value: raw === '' ? null : raw,
          valueSource: 'MANUAL',
          valueUpdatedAt: raw === '' ? null : new Date(),
          valueUpdatedById: raw === '' ? null : actorEmployeeId ?? null,
          sortOrder: 1000,
        },
      });

      if (requirement && dto.target) {
        const bindings = ((requirement.parameterBindings ??
          {}) as TechCardParameterBindings) ?? {};
        await tx.orderMaterialRequirement.update({
          where: { id: requirement.id },
          data: {
            parameterBindings: {
              ...bindings,
              [dto.target.field]: dto.key,
            } as Prisma.InputJsonValue,
          },
        });
      }
    });

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    this.logger.log(
      `event=order_tech_card.adhoc_created order=${orderId} key=${dto.key} ` +
        `target=${dto.target?.field ?? 'нет'}`,
    );
    return this.listForOrder(orderId);
  }

  /** Удалить можно только ad-hoc слот: пришедший из шаблона правится в шаблоне. */
  async removeAdHoc(
    orderId: string,
    parameterId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const param = await this.findParam(orderId, parameterId);
    if (param.sourceTechCardId !== null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_PARAMETER_FROM_TEMPLATE',
        message:
          'Этот параметр пришёл из шаблона техкарты — удалить его можно только в справочнике.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.orderTechCardParameter.delete({ where: { id: param.id } });

      // Снять привязку со всех строк группы, иначе останется висячая ссылка на
      // несуществующий параметр.
      const rows = await tx.orderMaterialRequirement.findMany({
        where: { orderId, orderVariantId: param.orderVariantId },
        select: { id: true, parameterBindings: true },
      });
      for (const r of rows) {
        const bindings = (r.parameterBindings ??
          null) as TechCardParameterBindings | null;
        if (!bindings) continue;
        const next = Object.fromEntries(
          Object.entries(bindings).filter(([, key]) => key !== param.key),
        );
        if (Object.keys(next).length === Object.keys(bindings).length) continue;
        await tx.orderMaterialRequirement.update({
          where: { id: r.id },
          data: {
            parameterBindings:
              Object.keys(next).length > 0
                ? (next as Prisma.InputJsonValue)
                : Prisma.DbNull,
          },
        });
      }
    });

    await this.orders.resyncColorwayDerived(orderId, actorEmployeeId);
    this.logger.log(
      `event=order_tech_card.adhoc_removed order=${orderId} key=${param.key}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /**
   * Правка параметров разрешена там же, где правка расцветок: DRAFT и
   * CALCULATION. Дальше снимок заморожен (см. `resyncColorwayDerived`), и
   * тихий no-op вместо ошибки был бы худшим из вариантов.
   */
  private async assertEditableOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });
    if (order.status !== 'DRAFT' && order.status !== 'CALCULATION') {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_LOCKED',
        message:
          'Параметры техкарты можно менять только в черновике и на этапе расчёта.',
      });
    }
  }

  private async findParam(orderId: string, parameterId: string) {
    const param = await this.prisma.orderTechCardParameter.findFirst({
      where: { id: parameterId, orderId },
    });
    if (!param) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_TECH_CARD_PARAMETER_NOT_FOUND',
        message: 'Параметр не найден в этом заказе.',
      });
    }
    return param;
  }

  /** Значение должно соответствовать типу слота — иначе подстановка тихо не сработает. */
  private assertValueValid(
    param: { inputType: string; options: Prisma.JsonValue | null; label: string },
    raw: string,
  ): void {
    if (raw === '') return;
    if (param.inputType === 'NUMBER' && !Number.isFinite(Number(raw))) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_PARAMETER_VALUE_INVALID',
        message: `«${param.label}» — числовой параметр, «${raw}» числом не является.`,
      });
    }
    if (param.inputType === 'ENUM') {
      const options = Array.isArray(param.options)
        ? (param.options as string[])
        : [];
      if (options.length > 0 && !options.includes(raw)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_TECH_CARD_PARAMETER_VALUE_INVALID',
          message: `«${param.label}»: допустимые значения — ${options.join(', ')}.`,
        });
      }
    }
  }

  private targetsForLine() {
    // Whitelist ячеек — из shared (выводится из MATERIAL_CHARACTERISTICS).
    // Импортируем лениво через getTechCardParameterTarget, чтобы не тащить
    // весь массив: список короткий и стабильный.
    return TARGET_FIELDS.map((f) => getTechCardParameterTarget(f)!).filter(
      Boolean,
    );
  }

  private toParamDto(
    p: {
      id: string;
      orderVariantId: string | null;
      key: string;
      label: string;
      inputType: string;
      options: Prisma.JsonValue | null;
      unit: string | null;
      isRequired: boolean;
      sortOrder: number;
      owner: string;
      sourceTechCardId: string | null;
      value: string | null;
      valueSource: string;
    },
    rows: Array<{
      id: string;
      name: string;
      parameterBindings: Prisma.JsonValue | null;
    }>,
  ): OrderTechCardParameterDto {
    const targets: OrderTechCardParameterDto['targets'] = [];
    for (const r of rows) {
      const bindings = (r.parameterBindings ??
        null) as TechCardParameterBindings | null;
      if (!bindings) continue;
      for (const [field, key] of Object.entries(bindings)) {
        if (key !== p.key) continue;
        const def = getTechCardParameterTarget(field);
        targets.push({
          requirementId: r.id,
          lineName: r.name,
          field,
          fieldLabel: def?.label ?? field,
        });
      }
    }
    return {
      id: p.id,
      key: p.key,
      label: p.label,
      inputType: p.inputType as TechCardParameterInputType,
      options: Array.isArray(p.options) ? (p.options as string[]) : null,
      unit: p.unit,
      isRequired: p.isRequired,
      defaultValue: null,
      owner: p.owner as TechCardParameterOwner,
      sortOrder: p.sortOrder,
      orderVariantId: p.orderVariantId,
      value: p.value,
      valueSource: p.valueSource as TechCardParameterValueSource,
      isAdHoc: p.sourceTechCardId === null,
      targets,
    };
  }
}

/** Ячейки, которые UI предлагает как цель параметра (см. `TECH_CARD_PARAMETER_TARGETS`). */
const TARGET_FIELDS = [
  'char:density',
  'char:rollWidth',
  'char:width',
  'char:thickness',
  'char:type',
  'char:material',
  'char:size',
  'char:length',
  'core:qtyPerUnit',
  'core:fabricType',
  'core:unit',
  'core:note',
] as const;
