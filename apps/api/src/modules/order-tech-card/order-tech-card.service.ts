import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import type {
  CreateOrderTechCardLineDto,
  CreateOrderTechCardLinesDto,
  CreateOrderTechCardParameterDto,
  OrderTechCardEditMode,
  OrderTechCardLineDto,
  OrderTechCardParametersDto,
  OrderTechCardTargetOptionDto,
  OrderTechCardVariantParamsDto,
  SetOrderTechCardParameterValueDto,
  UpdateOrderTechCardLineDto,
} from '@sewing/shared/order-tech-cards';
import {
  getTechCardParameterTarget,
  normalizeMaterialLineCells,
  type OrderTechCardParameterDto,
  type TechCardParameterBindings,
  type TechCardParameterInputType,
  type TechCardParameterOwner,
  type TechCardParameterValueSource,
} from '@sewing/shared/tech-card-parameters';
import type { MaterialCharacteristics } from '@sewing/shared/material-characteristics';
import {
  getMaterialCharacteristic,
  getMaterialSubtype,
  isKnownMaterialSubtype,
  MATERIAL_CHARACTERISTICS,
} from '@sewing/shared/material-characteristics';
import {
  computeNormPurchase,
  needsPurchaseConversion,
} from '@sewing/shared/norm-purchase';
import {
  derivePatternNormPerUnit,
  describePatternNormSource,
  matchPatternNormSources,
} from '@sewing/shared/pattern-norms';
import type { PatternNormSource } from '@sewing/shared/pattern-norms';

import { PrismaService } from '../../prisma/prisma.service.js';
import { collectPatternNormSources } from '../orders/pattern-norm-sources.js';
import { OrdersService } from '../orders/orders.service.js';

/**
 * Спецификация техкарты внутри заказа: строки материалов + значения
 * параметров по расцветкам + ad-hoc слоты.
 *
 * Устройство скопировано с `OrderColorwaysService` (см. соседний модуль):
 * каждый write заканчивается пересборкой производных и возвращает свежий
 * полный DTO.
 *
 * Почему именно resync, а не точечный UPDATE снимка: у проекта уже дважды
 * горело на том, что производные (снимок → потребность → план) собирались в
 * обход единого пути. Значение параметра меняет ячейку строки → меняет
 * потребность цеха, поэтому идём тем же путём, что и правка расцветки.
 *
 * ОКНО ПРАВКИ (шире, чем у расцветок). Расцветки правятся только пока план
 * не заморожен (`DRAFT`/`CALCULATION`) — иначе правка не поднялась бы в
 * агрегат `OrderItem`. Спецификация же от тиража не зависит: технолог
 * уточняет материал и норму и после расчёта, и в производстве. Поэтому
 * правка открыта вплоть до `IN_PRODUCTION`, но за окном планирования идёт
 * amendment-путём — `OrdersService.resyncTechCardDerived` пересобирает
 * только снимок материалов и план операций, пишет событие в журнал правок
 * и пересчитывает потребности best-effort. Закрыты только `DONE`/
 * `CANCELLED` (`ORDER_TECH_CARD_LOCKED`).
 */
/**
 * Что правка спецификации сделает с производными данными в этом статусе.
 * Единственное место, где живёт правило (бэкенд отдаёт его фронту полем
 * `editMode`, чтобы окно не переизобретало гейт у себя).
 */
export function techCardEditMode(
  status: OrderStatus | string,
): OrderTechCardEditMode {
  if (status === OrderStatus.DRAFT || status === OrderStatus.CALCULATION) {
    return 'PLAN';
  }
  if (status === OrderStatus.DONE || status === OrderStatus.CANCELLED) {
    return 'LOCKED';
  }
  return 'AMENDMENT';
}

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
        // Поразмерный план нужен, чтобы показать, ИЗ ЧЕГО сложилась норма
        // из номенклатуры (погонные метры / площади задаются по размерам).
        items: {
          select: {
            sizeId: true,
            qtyPlan: true,
            size: { select: { code: true, sortOrder: true } },
          },
        },
        variants: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            color: true,
            techCardId: true,
            techCard: { select: { name: true } },
            sizes: {
              select: {
                sizeId: true,
                qtyPlan: true,
                size: { select: { code: true, sortOrder: true } },
              },
            },
          },
        },
        patternItem: {
          select: {
            parameterNorms: {
              select: {
                id: true,
                roleKey: true,
                labelSnapshot: true,
                inputTypeSnapshot: true,
                unit: true,
                qtyPerItem: true,
              },
            },
            sizeParameterValues: {
              select: {
                categoryParameterId: true,
                roleKey: true,
                labelSnapshot: true,
                inputTypeSnapshot: true,
                unit: true,
                sizeId: true,
                value: true,
              },
            },
            materialAreas: {
              select: { materialRole: true, sizeId: true, areaM2: true },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });

    const normSources = collectPatternNormSources(order.patternItem);
    const sizeLabelById = new Map<string, string>();
    for (const it of order.items) sizeLabelById.set(it.sizeId, it.size.code);
    for (const v of order.variants) {
      for (const sz of v.sizes) sizeLabelById.set(sz.sizeId, sz.size.code);
    }

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
          unit: true,
          normUnit: true,
          qtyPerUnit: true,
          totalQty: true,
          materialRole: true,
          fabricType: true,
          densityGsm: true,
          // Нужны для пересчёта расхода в закупочную единицу.
          plannedWidthCm: true,
          resolvedColorText: true,
          selectedColorText: true,
          isManual: true,
          parameterBindings: true,
          subtypeKey: true,
          characteristics: true,
          qtySource: true,
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

      // План по размерам ЭТОЙ группы — им подписывается норма из номенклатуры.
      // ≥2 расцветок → план расцветки, иначе order-level позиции заказа.
      const variantRow =
        g.orderVariantId != null
          ? order.variants.find((v) => v.id === g.orderVariantId)
          : (order.variants[0] ?? null);
      const sizePlan =
        order.variants.length >= 2 && variantRow
          ? variantRow.sizes.map((sz) => ({
              sizeId: sz.sizeId,
              qtyPlan: sz.qtyPlan,
              sortOrder: sz.size.sortOrder,
            }))
          : order.items.map((it) => ({
              sizeId: it.sizeId,
              qtyPlan: it.qtyPlan,
              sortOrder: it.size.sortOrder,
            }));
      const sortOrderBySize = new Map(
        sizePlan.map((p) => [p.sizeId, p.sortOrder] as const),
      );
      // Источник нормы ищем ТОЛЬКО для строк, которые её оттуда и получили:
      // иначе подпись обещала бы связь, которой в снимке нет.
      const nomenclatureRows = rows.filter(
        (r) => r.qtySource === 'NOMENCLATURE',
      );
      const normByLine =
        nomenclatureRows.length > 0
          ? matchPatternNormSources(
              nomenclatureRows.map((r) => ({
                key: r.id,
                materialRole: r.materialRole,
                name: r.name,
                fabricType: r.fabricType,
                unit: r.unit,
              })),
              normSources,
            )
          : new Map<string, PatternNormSource>();

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

      // Тираж группы — им средневзвешенная норма разворачивается в расход, а
      // расход пересчитывается в закупочную единицу.
      const groupQty = sizePlan.reduce((s, p) => s + p.qtyPlan, 0);

      const lines: OrderTechCardLineDto[] = rows.map((r) => {
        const normSource = normByLine.get(r.id) ?? null;
        const derived = normSource
          ? derivePatternNormPerUnit(normSource, sizePlan)
          : null;
        // Строка развела единицы — показываем обе стороны: расход в единице
        // нормы и количество к закупке. Иначе блок закупки просто повторил бы
        // расход, и его на экране не будет.
        const split = needsPurchaseConversion(r.normUnit, r.unit)
          ? computeNormPurchase({
              normPerUnit: Number(r.qtyPerUnit.toString()),
              normUnit: r.normUnit,
              qty: groupQty,
              purchaseUnit: r.unit,
              widthCm: r.plannedWidthCm,
              densityGsm: r.densityGsm,
            })
          : null;
        return {
          id: r.id,
          name: r.name,
          unit: r.unit,
          normUnit: r.normUnit,
          qtyPerUnit: r.qtyPerUnit.toString(),
          totalQty: r.totalQty.toString(),
          totalNorm: split ? String(split.totalNorm) : null,
          purchaseProblem: split && !split.ok ? split.message : null,
          purchaseFormula: split && split.ok ? split.formula || null : null,
          materialRole: r.materialRole,
          fabricType: r.fabricType,
          densityGsm: r.densityGsm,
          colorText: r.selectedColorText ?? r.resolvedColorText ?? null,
          isManual: r.isManual,
          subtypeKey: r.subtypeKey,
          characteristics:
            (r.characteristics as MaterialCharacteristics | null) ?? null,
          qtySource:
            (r.qtySource as OrderTechCardLineDto['qtySource']) ?? null,
          qtySourceLabel: normSource
            ? describePatternNormSource(normSource)
            : null,
          // Разбивка только у поразмерных норм — плоскую расписывать нечем.
          qtyBySize: (derived?.bySize ?? [])
            .map((b) => ({
              sizeId: b.sizeId,
              sizeCode: sizeLabelById.get(b.sizeId) ?? '—',
              value: String(b.value),
              qtyPlan: b.qtyPlan,
            }))
            .sort(
              (a, b) =>
                (sortOrderBySize.get(a.sizeId) ?? 0) -
                (sortOrderBySize.get(b.sizeId) ?? 0),
            ),
          // Ячейки под параметром: их UI правит через значение параметра,
          // прямую правку backend отбивает (см. `updateLine`).
          boundFields: Object.keys(
            ((r.parameterBindings ??
              null) as TechCardParameterBindings | null) ?? {},
          ),
        };
      });

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
        lines,
      };
    });

    const editMode = techCardEditMode(order.status);
    return {
      orderId: order.id,
      editable: editMode !== 'LOCKED',
      editMode,
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

    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Параметр «${param.label}»: ${param.value ?? '—'} → ${raw || '—'}`,
      details: { parameterKey: param.key, from: param.value, to: raw || null },
    });
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

    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Параметр «${param.label}» = ${param.value ?? '—'} применён ко всем расцветкам (${count})`,
      details: { parameterKey: param.key, value: param.value, affected: count },
    });
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

    const variantId = await this.resolveSnapshotVariantId(
      orderId,
      dto.orderVariantId ?? null,
    );
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

    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Добавлен параметр «${dto.label}»${
        dto.value ? ` = ${dto.value}` : ''
      }`,
      details: {
        parameterKey: dto.key,
        target: dto.target?.field ?? null,
        value: dto.value ?? null,
      },
    });
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

    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Убран параметр «${param.label}»`,
      details: { parameterKey: param.key },
    });
    this.logger.log(
      `event=order_tech_card.adhoc_removed order=${orderId} key=${param.key}`,
    );
    return this.listForOrder(orderId);
  }

  /**
   * Добавить строку материала прямо в заказ (усилительная лента, которой нет в
   * шаблоне). Один материал — частный случай пачки из одного.
   */
  async createManualLine(
    orderId: string,
    dto: CreateOrderTechCardLineDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    const { orderVariantId, ...line } = dto;
    return this.createManualLines(
      orderId,
      { orderVariantId: orderVariantId ?? null, lines: [line] },
      actorEmployeeId,
    );
  }

  /**
   * Завести ПАЧКУ строк материала одним заходом.
   *
   * `isManual = true` — такие строки не сносятся пересборкой даже при смене
   * техкарты: шаблон о них не знает, значит и заменить их собой не может.
   * Это и есть «что меняем внутри заказа, внутри заказа и остаётся».
   *
   * Почему пачка, а не N вызовов подряд: каждое создание заканчивается
   * `resyncTechCardDerived` — пересборкой снимка материалов, плана операций и
   * потребностей цеха. Десять материалов десятью запросами — это десять
   * пересборок и десять шансов остановиться на середине с половиной строк в
   * заказе. Здесь вставка идёт ОДНОЙ транзакцией, пересборка — одна, в конце.
   *
   * `totalQty` считаем не здесь: пересборка сразу проставит тираж — один
   * путь, без второго калькулятора.
   */
  async createManualLines(
    orderId: string,
    dto: CreateOrderTechCardLinesDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const variantId = await this.resolveSnapshotVariantId(
      orderId,
      dto.orderVariantId ?? null,
    );

    // Порядок: ручные строки идут после шаблонных.
    const last = await this.prisma.orderMaterialRequirement.findFirst({
      where: { orderId, orderVariantId: variantId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true, variantColor: true },
    });
    const baseSortOrder = last?.sortOrder ?? 0;

    // Ячейки готовим ДО транзакции: характеристики бьются 409-ми, и падать
    // на середине вставки нельзя — половина пачки уже была бы в заказе.
    const rows = dto.lines.map((line, index) => {
      const colorText = line.colorText?.trim() || null;
      const subtypeKey = line.subtypeKey?.trim() || null;
      if (subtypeKey !== null && !isKnownMaterialSubtype(subtypeKey)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_TECH_CARD_UNKNOWN_SUBTYPE',
          message: `Неизвестный подтип материала «${subtypeKey}».`,
        });
      }
      // Новая строка ни под каким параметром не стоит (`parameterBindings`
      // пуст), поэтому проверка занятой ячейки здесь не нужна — нужна только
      // валидация самих значений, как в правке.
      const chars = this.buildCharacteristics(line.characteristics);
      // Роль выводим из подтипа, если её не прислали: подтип задаёт её
      // однозначно (ZIPPER → PACKAGING). Без этого `normalizeMaterialLineCells`
      // вычистила бы у молнии «Размер» и «Материал» — они разрешены только
      // роли PACKAGING, — то есть характеристики терялись бы молча, с 200 в
      // ответе.
      const materialRole =
        line.materialRole ??
        (subtypeKey ? (getMaterialSubtype(subtypeKey)?.groupRoleKey ?? null) : null);
      const cells = normalizeMaterialLineCells({
        name: line.name,
        unit: line.unit,
        qtyPerUnit: line.qtyPerUnit,
        note: line.note ?? null,
        materialRole,
        fabricType: line.fabricType?.trim() || null,
        // Зеркало `characteristics` ↔ legacy-колонки собирает сама
        // `normalizeMaterialLineCells`: downstream (потребности цеха,
        // cut-readiness, себестоимость) читает СТАРЫЕ колонки, и строка,
        // записавшая только JSON, не повлияла бы на закупку.
        densityGsm: null,
        plannedWidthCm: null,
        hardwareSizeText: null,
        hardwareMaterialText: null,
        characteristics: Object.keys(chars).length > 0 ? chars : null,
      });
      return {
        orderId,
        orderVariantId: variantId,
        variantColor: last?.variantColor ?? null,
        isManual: true,
        // Из шаблона не приходила — источника нет.
        sourceTechCardLineId: null,
        sourceTechCardId: null,
        sortOrder: baseSortOrder + 10 * (index + 1),
        name: cells.name,
        unit: cells.unit,
        // Ручная строка — частый случай расщепления: норму вводят в метрах, а
        // закупают на вес. Тираж посчитает ближайший resync через
        // `computeLineTotalQty`, поэтому единица нормы нужна уже здесь.
        normUnit: line.normUnit?.trim() || null,
        qtyPerUnit: new Prisma.Decimal(cells.qtyPerUnit),
        totalQty: new Prisma.Decimal(0),
        note: cells.note ?? null,
        materialRole: cells.materialRole ?? null,
        fabricType: cells.fabricType,
        subtypeKey,
        densityGsm: cells.densityGsm,
        plannedWidthCm: cells.plannedWidthCm,
        hardwareSizeText: cells.hardwareSizeText,
        hardwareMaterialText: cells.hardwareMaterialText,
        characteristics:
          (cells.characteristics as Prisma.InputJsonValue | null) ??
          Prisma.DbNull,
        // Цвет задаётся прямо здесь: правило `colorRule` — свойство шаблона, а
        // у ручной строки шаблона нет.
        colorRule: colorText ? 'FIXED_COLOR' : 'NO_COLOR',
        fixedColorText: colorText,
        resolvedColorText: colorText,
        requiresColorSelection: false,
        // Норму ввели прямо здесь — в номенклатуре этой строки нет, брать
        // число неоткуда, пересчёт её не переписывает.
        qtySource: 'ORDER' as const,
      };
    });

    await this.prisma.$transaction(async (tx) => {
      for (const data of rows) {
        await tx.orderMaterialRequirement.create({ data });
      }
    });

    const first = dto.lines[0]!;
    const summary =
      dto.lines.length === 1
        ? `Добавлен материал «${first.name}» — ${first.qtyPerUnit} ${first.unit}/шт`
        : `Добавлено материалов: ${dto.lines.length} — ${dto.lines
            .map((l) => l.name)
            .join(', ')}`;
    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary,
      details: {
        lines: dto.lines.map((l) => ({
          name: l.name,
          unit: l.unit,
          qtyPerUnit: l.qtyPerUnit,
          colorText: l.colorText?.trim() || null,
        })),
      },
    });
    this.logger.log(
      `event=order_tech_card.manual_lines_created order=${orderId} count=${dto.lines.length}`,
    );
    return this.listForOrder(orderId);
  }

  /**
   * Проверить и привести значения характеристик новой строки.
   *
   * Зеркало legacy-колонок и роль-зависимую очистку делает
   * `normalizeMaterialLineCells` — здесь только валидация ключей и чисел,
   * теми же 409-ми, что и в правке строки.
   */
  private buildCharacteristics(
    raw: CreateOrderTechCardLineDto['characteristics'],
  ): MaterialCharacteristics {
    const chars: MaterialCharacteristics = {};
    if (!raw) return chars;
    const known = new Set(MATERIAL_CHARACTERISTICS.map((c) => c.key));
    for (const [key, value] of Object.entries(raw)) {
      if (!known.has(key)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_TECH_CARD_UNKNOWN_CHARACTERISTIC',
          message: `Неизвестная характеристика «${key}».`,
        });
      }
      // Пусто в НОВОЙ строке — просто «не задано»: очищать нечего.
      if (value === null || (typeof value === 'string' && value.trim() === '')) {
        continue;
      }
      const def = getMaterialCharacteristic(key);
      if (def?.valueType === 'number') {
        const num = Number(String(value).replace(',', '.'));
        if (!Number.isFinite(num) || num <= 0) {
          throw new ConflictException({
            statusCode: 409,
            code: 'ORDER_TECH_CARD_CHARACTERISTIC_INVALID',
            message: `«${def.label}» — положительное число.`,
          });
        }
        chars[key] = num;
      } else {
        chars[key] = String(value).trim();
      }
    }
    return chars;
  }

  /**
   * Править можно ЛЮБУЮ строку — и шаблонную, и ручную («техкарта живёт в
   * заказе»: шаблон только сеет список, дальше строки — собственность
   * заказа; решение 16.07, обязательность снята).
   *
   * Правки переживают пересборку: ветка ПЕРЕСЧЁТА в
   * `rebuildMaterialRequirementsSnapshot` читает собственные значения
   * строки, а не шаблон (Фаза 2). Исключения, о которых заботимся здесь:
   *   - ячейка под параметром (`parameterBindings`) — прямая правка
   *     запрещена (409 `ORDER_TECH_CARD_CELL_TAKEN`): на пересчёте её всё
   *     равно перезаписало бы значение параметра — тихий откат. UI правит
   *     такую ячейку через значение параметра;
   *   - цвет — пересчёт заново выводит его из `colorRule`, поэтому правка
   *     фиксируется как `FIXED_COLOR` (очистка — `NO_COLOR`);
   *   - плотность — пишется через `normalizeMaterialLineCells`, чтобы
   *     legacy-колонка `densityGsm` и `characteristics`-JSON не разошлись
   *     (JSON в зеркале главнее — рассинхрон тихо откатил бы правку).
   *
   * `totalQty` не трогаем: `resyncTechCardDerived` пересчитает
   * (qtyPerUnit × тираж) — один путь, без второго калькулятора.
   */
  async updateLine(
    orderId: string,
    requirementId: string,
    dto: UpdateOrderTechCardLineDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const row = await this.prisma.orderMaterialRequirement.findFirst({
      where: { id: requirementId, orderId },
      select: {
        id: true,
        name: true,
        unit: true,
        normUnit: true,
        qtyPerUnit: true,
        note: true,
        materialRole: true,
        fabricType: true,
        densityGsm: true,
        plannedWidthCm: true,
        hardwareSizeText: true,
        hardwareMaterialText: true,
        characteristics: true,
        parameterBindings: true,
        subtypeKey: true,
        qtySource: true,
      },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_MATERIAL_REQUIREMENT_NOT_FOUND',
        message: 'Строка материала не найдена в этом заказе.',
      });
    }

    const bindings = (row.parameterBindings ??
      null) as TechCardParameterBindings | null;
    const assertCellFree = (fieldLabel: string, bindingKey: string): void => {
      const taken = bindings?.[bindingKey];
      if (!taken) return;
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_CELL_TAKEN',
        message:
          `«${fieldLabel}» этой строки привязана к параметру «${taken}» — ` +
          'правьте значение параметра, а не ячейку.',
      });
    };
    if (dto.name !== undefined) assertCellFree('Название', 'core:name');
    if (dto.unit !== undefined) assertCellFree('Ед. изм.', 'core:unit');
    if (dto.qtyPerUnit !== undefined) {
      assertCellFree('Норма расхода', 'core:qtyPerUnit');
    }
    if (dto.densityGsm !== undefined) assertCellFree('Плотность', 'char:density');
    if (dto.fabricType !== undefined) {
      assertCellFree('Характеристика', 'core:fabricType');
    }

    // Правку плотности кладём В ОБЕ стороны зеркала (JSON главнее legacy при
    // merge в `normalizeMaterialLineCells` — одна сторона тихо откатилась бы).
    const chars: MaterialCharacteristics = {
      ...((row.characteristics as MaterialCharacteristics | null) ?? {}),
    };
    // Legacy-колонки правим синхронно с JSON: у характеристик density /
    // rollWidth / size / material есть колонка, и очистка ТОЛЬКО в JSON
    // тихо откатилась бы обратно при merge в `normalizeMaterialLineCells`.
    const legacy = {
      densityGsm: row.densityGsm,
      plannedWidthCm: row.plannedWidthCm,
      hardwareSizeText: row.hardwareSizeText,
      hardwareMaterialText: row.hardwareMaterialText,
    };
    const clearLegacyFor = (charKey: string): void => {
      const def = getMaterialCharacteristic(charKey);
      if (!def?.legacyColumn) return;
      if (def.legacyColumn === 'densityGsm') legacy.densityGsm = null;
      if (def.legacyColumn === 'plannedWidthCm') legacy.plannedWidthCm = null;
      if (def.legacyColumn === 'hardwareSizeText') legacy.hardwareSizeText = null;
      if (def.legacyColumn === 'hardwareMaterialText') {
        legacy.hardwareMaterialText = null;
      }
    };

    if (dto.densityGsm !== undefined) {
      if (dto.densityGsm === null) {
        delete chars.density;
        legacy.densityGsm = null;
      } else {
        chars.density = dto.densityGsm;
        legacy.densityGsm = dto.densityGsm;
      }
    }

    // Подтип задаёт НАБОР характеристик: сменили подтип — значения, которых у
    // нового набора нет, уносим. Иначе в строке остался бы «размер молнии» на
    // кулирке — невидимый мусор, который поедет в описание потребности.
    let nextSubtypeKey = row.subtypeKey;
    // Роль строки, заведённой в заказе, пуста — и до появления подтипа взяться
    // ей неоткуда. Как только подтип известен, роль выводится из него: иначе
    // `normalizeMaterialLineCells` ниже вычистит характеристики, разрешённые
    // только «своей» роли (размер и материал у фурнитуры).
    let nextMaterialRole = row.materialRole;
    if (dto.subtypeKey !== undefined) {
      const raw = dto.subtypeKey?.trim() || null;
      if (raw !== null && !isKnownMaterialSubtype(raw)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_TECH_CARD_UNKNOWN_SUBTYPE',
          message: `Неизвестный подтип материала «${raw}».`,
        });
      }
      if (raw !== row.subtypeKey) {
        const allowed = new Set(
          raw ? (getMaterialSubtype(raw)?.characteristics ?? []).map((c) => c.key) : [],
        );
        for (const key of Object.keys(chars)) {
          if (allowed.has(key)) continue;
          delete chars[key];
          clearLegacyFor(key);
        }
      }
      nextSubtypeKey = raw;
      if (!nextMaterialRole && raw) {
        nextMaterialRole = getMaterialSubtype(raw)?.groupRoleKey ?? null;
      }
    }

    // Характеристики: пришедший ключ пишем, `null`/пусто — очищаем (вместе с
    // legacy-колонкой). Ячейка под слот-параметром правке не подлежит.
    const charKeys = new Set(MATERIAL_CHARACTERISTICS.map((c) => c.key));
    if (dto.characteristics !== undefined) {
      for (const [key, raw] of Object.entries(dto.characteristics)) {
        if (!charKeys.has(key)) {
          throw new ConflictException({
            statusCode: 409,
            code: 'ORDER_TECH_CARD_UNKNOWN_CHARACTERISTIC',
            message: `Неизвестная характеристика «${key}».`,
          });
        }
        const def = getMaterialCharacteristic(key);
        assertCellFree(def?.label ?? key, `char:${key}`);
        const isEmpty =
          raw === null || (typeof raw === 'string' && raw.trim() === '');
        if (isEmpty) {
          delete chars[key];
          clearLegacyFor(key);
          continue;
        }
        if (def?.valueType === 'number') {
          const num = Number(String(raw).replace(',', '.'));
          if (!Number.isFinite(num) || num <= 0) {
            throw new ConflictException({
              statusCode: 409,
              code: 'ORDER_TECH_CARD_CHARACTERISTIC_INVALID',
              message: `«${def.label}» — положительное число.`,
            });
          }
          chars[key] = num;
        } else {
          chars[key] = String(raw).trim();
        }
      }
    }

    // Характеристика строки — то самое поле, которое заменило «Подтип».
    // Приходит вместе с выведенным `subtypeKey` одним патчем.
    const nextFabricType =
      dto.fabricType === undefined
        ? row.fabricType
        : dto.fabricType?.trim() || null;

    const cells = normalizeMaterialLineCells({
      name: dto.name ?? row.name,
      unit: dto.unit ?? row.unit,
      qtyPerUnit: dto.qtyPerUnit ?? row.qtyPerUnit.toString(),
      note: row.note,
      materialRole: nextMaterialRole,
      fabricType: nextFabricType,
      densityGsm: legacy.densityGsm,
      plannedWidthCm: legacy.plannedWidthCm,
      hardwareSizeText: legacy.hardwareSizeText,
      hardwareMaterialText: legacy.hardwareMaterialText,
      characteristics: Object.keys(chars).length > 0 ? chars : null,
    });

    // Цвет: прямая правка = «пин» FIXED_COLOR (переживает пересчёт), пусто =
    // снять (NO_COLOR). `selectedColorText` гасим — в DTO он главнее
    // resolved и затенил бы новую правку.
    const trimmedColor =
      dto.colorText === undefined ? undefined : dto.colorText?.trim() || null;
    const colorData =
      trimmedColor === undefined
        ? {}
        : trimmedColor === null
          ? {
              colorRule: 'NO_COLOR',
              fixedColorText: null,
              resolvedColorText: null,
              selectedColorText: null,
              requiresColorSelection: false,
            }
          : {
              colorRule: 'FIXED_COLOR',
              fixedColorText: trimmedColor,
              resolvedColorText: trimmedColor,
              selectedColorText: null,
              requiresColorSelection: false,
            };

    // Норму правили руками → она главнее номенклатуры и переживает пересчёт
    // (`rebuildMaterialRequirementsSnapshot` освежает из номенклатуры только
    // строки с `qtySource = NOMENCLATURE`). Сбрасывается «Обновить нормы».
    const qtyEdited =
      dto.qtyPerUnit !== undefined &&
      cells.qtyPerUnit !== row.qtyPerUnit.toString();

    await this.prisma.orderMaterialRequirement.update({
      where: { id: row.id },
      data: {
        name: cells.name,
        unit: cells.unit,
        // Единица нормы идёт МИМО `MaterialLineCells`: параметризовать её
        // (`core:normUnit`) никто не просил, а протаскивание в cells потянуло
        // бы за собой targets, clearCell и зеркало характеристик.
        ...(dto.normUnit !== undefined
          ? { normUnit: dto.normUnit?.trim() || null }
          : {}),
        qtyPerUnit: new Prisma.Decimal(cells.qtyPerUnit),
        densityGsm: cells.densityGsm,
        plannedWidthCm: cells.plannedWidthCm,
        hardwareSizeText: cells.hardwareSizeText,
        hardwareMaterialText: cells.hardwareMaterialText,
        characteristics:
          (cells.characteristics as Prisma.InputJsonValue | null) ??
          Prisma.DbNull,
        fabricType: cells.fabricType,
        subtypeKey: nextSubtypeKey,
        materialRole: cells.materialRole,
        ...(qtyEdited ? { qtySource: 'ORDER' } : {}),
        ...colorData,
      },
    });

    // Сводка для журнала — только реально пришедшие поля, «было → стало».
    const changed: string[] = [];
    if (dto.name !== undefined && cells.name !== row.name) {
      changed.push(`название ${row.name} → ${cells.name}`);
    }
    if (
      dto.qtyPerUnit !== undefined &&
      cells.qtyPerUnit !== row.qtyPerUnit.toString()
    ) {
      changed.push(`норма ${row.qtyPerUnit.toString()} → ${cells.qtyPerUnit}`);
    }
    if (dto.unit !== undefined && cells.unit !== row.unit) {
      changed.push(`ед. ${row.unit} → ${cells.unit}`);
    }
    if (dto.densityGsm !== undefined && cells.densityGsm !== row.densityGsm) {
      changed.push(`плотность ${row.densityGsm ?? '—'} → ${cells.densityGsm ?? '—'}`);
    }
    if (dto.fabricType !== undefined && cells.fabricType !== row.fabricType) {
      changed.push(
        `характеристика ${row.fabricType ?? '—'} → ${cells.fabricType ?? '—'}`,
      );
    }
    if (dto.subtypeKey !== undefined && nextSubtypeKey !== row.subtypeKey) {
      const label = nextSubtypeKey
        ? (getMaterialSubtype(nextSubtypeKey)?.label ?? nextSubtypeKey)
        : '—';
      changed.push(`подтип → ${label}`);
    }
    if (dto.characteristics !== undefined) {
      const before =
        (row.characteristics as MaterialCharacteristics | null) ?? {};
      for (const key of Object.keys(dto.characteristics)) {
        const was = before[key];
        const now = (cells.characteristics ?? {})[key];
        if (String(was ?? '') === String(now ?? '')) continue;
        const def = getMaterialCharacteristic(key);
        changed.push(`${def?.label ?? key} ${was ?? '—'} → ${now ?? '—'}`);
      }
    }
    if (trimmedColor !== undefined) {
      changed.push(`цвет → ${trimmedColor ?? '—'}`);
    }
    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Материал «${row.name}»: ${
        changed.length > 0 ? changed.join(', ') : 'правка без изменений'
      }`,
      details: { requirementId: row.id, fields: Object.keys(dto) },
    });
    this.logger.log(
      `event=order_tech_card.line_updated order=${orderId} line=${row.id} ` +
        `fields=${Object.keys(dto).join(',')}`,
    );
    return this.listForOrder(orderId);
  }

  /**
   * Удалить строку — ЛЮБУЮ, и шаблонную, и ручную (решение 16.07: заказ
   * владеет своей копией техкарты; вернуть шаблонные строки — «Обновить из
   * шаблона»).
   *
   * Единственный запрет — ПОСЛЕДНЯЯ шаблонная строка группы: «строк из
   * шаблона нет» — это триггер перематериализации в
   * `rebuildMaterialRequirementsSnapshot` (так «только что выбранная
   * техкарта» получает свои строки). Удалить последнюю = ресинк тут же
   * молча воскресит все шаблонные строки — хуже понятной ошибки.
   */
  async removeLine(
    orderId: string,
    requirementId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const row = await this.prisma.orderMaterialRequirement.findFirst({
      where: { id: requirementId, orderId },
      select: { id: true, isManual: true, name: true, orderVariantId: true },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_MATERIAL_REQUIREMENT_NOT_FOUND',
        message: 'Строка материала не найдена в этом заказе.',
      });
    }
    if (!row.isManual) {
      const otherTemplateRows = await this.prisma.orderMaterialRequirement.count({
        where: {
          orderId,
          orderVariantId: row.orderVariantId,
          isManual: false,
          id: { not: row.id },
        },
      });
      if (otherTemplateRows === 0) {
        throw new ConflictException({
          statusCode: 409,
          code: 'ORDER_MATERIAL_LAST_TEMPLATE_LINE',
          message:
            'Это последняя строка из шаблона — пересборка вернула бы её обратно. ' +
            'Чтобы начать с чистого листа, смените техкарту расцветки.',
        });
      }
    }

    await this.prisma.orderMaterialRequirement.delete({ where: { id: row.id } });
    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Убран материал «${row.name}»`,
      details: { requirementId: row.id, isManual: row.isManual },
    });
    this.logger.log(
      `event=order_tech_card.line_removed order=${orderId} name=${row.name} manual=${row.isManual}`,
    );
    return this.listForOrder(orderId);
  }

  // -------------------------------------------------------------------------
  // Внутреннее
  // -------------------------------------------------------------------------

  /**
   * Спецификацию можно править везде, кроме закрытых заказов: `DONE`
   * (тираж выпущен — менять план задним числом нечестно к план-факту) и
   * `CANCELLED`. В остальных статусах правка легальна, но за окном
   * планирования идёт amendment-путём — см. `techCardEditMode`.
   */
  private async assertEditableOrder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND' });
    if (techCardEditMode(order.status) === 'LOCKED') {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_TECH_CARD_LOCKED',
        message:
          order.status === 'CANCELLED'
            ? 'Заказ отменён — спецификацию техкарты менять нельзя.'
            : 'Заказ завершён — спецификацию техкарты менять нельзя.',
      });
    }
  }

  /**
   * «Обновить нормы из номенклатуры» — снять с шаблонных строк отметку
   * «правлено в заказе» и перечитать числа из карточки номенклатуры.
   *
   * Действие мягкое (в отличие от «Обновить из шаблона»): структура строк,
   * параметры, характеристики и цвета остаются, меняются только нормы. Ручные
   * строки не трогаем никогда — их число ввели вручную, в номенклатуре его
   * нет и брать неоткуда.
   *
   * Само число подставляет пересборка снимка: она же понижает источник до
   * `TEMPLATE`, если параметра в номенклатуре не нашлось (строка честно
   * скажет «из шаблона», а не будет обещать связь).
   */
  async resetNormsFromNomenclature(
    orderId: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderTechCardParametersDto> {
    await this.assertEditableOrder(orderId);
    const { count } = await this.prisma.orderMaterialRequirement.updateMany({
      where: { orderId, isManual: false },
      data: { qtySource: 'NOMENCLATURE' },
    });
    await this.orders.resyncTechCardDerived(orderId, actorEmployeeId, {
      summary: `Нормы перечитаны из номенклатуры (строк: ${count})`,
      details: { lines: count },
    });
    this.logger.log(
      `event=order_tech_card.norms_reloaded order=${orderId} lines=${count}`,
    );
    return this.listForOrder(orderId);
  }

  /**
   * Привести `orderVariantId` из запроса к КЛЮЧУ ГРУППЫ СНИМКА.
   *
   * Снимок группируется как в `listForOrder`: при ≥2 расцветках — по
   * расцветке, при 0–1 — одна order-level группа под `orderVariantId = null`.
   * У единственной расцветки есть реальный id, и UI мог бы прислать именно
   * его; но снимок этой расцветки лежит под `null`. Записать по присланному
   * id как есть — значит положить строку/параметр в группу, которую
   * `listForOrder` не читает: пропадёт тихо (ровно баг «нет техкарты»).
   * Нормализуем: при 0–1 расцветке ключ всегда `null`. Фронт уже шлёт
   * правильный ключ, это защита контракта на стороне API.
   */
  private async resolveSnapshotVariantId(
    orderId: string,
    requested: string | null,
  ): Promise<string | null> {
    if (requested === null) return null;
    const count = await this.prisma.orderVariant.count({ where: { orderId } });
    return count >= 2 ? requested : null;
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
