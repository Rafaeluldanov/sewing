import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  OrderLogisticsStatus,
  OrderOutsourceExecutionStatus,
  OrderStatus,
  PassportStatus,
} from '@prisma/client';
import type {
  CreateOrderDto,
  CreateOrderLogisticsLineDto,
  ListOrdersQuery,
  OrderDeadlineDto,
  OrderDetailDto,
  OrderListItemDto,
  OrderLogisticsLineDto,
  OrderMaterialsAndHardwareCostPolicy,
  OrderOutsourceDisplayStatus,
  Paginated,
  RouteModeOverride,
  UpdateOrderDto,
  UpdateOrderLogisticsLineDto,
} from '@sewing/shared/orders';
import {
  ORDER_LOGISTICS_STATUS_LABELS,
  ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES,
} from '@sewing/shared/orders';
import type { UpdateOrderRouteOverridesDto } from '@sewing/shared/routes';
import { normalizeColorOrNull } from '@sewing/shared/colors';
import {
  evaluateOrderDeadline,
  type EvaluateOrderDeadlineInput,
} from '@sewing/shared/order-deadlines';
import type {
  OutsourceTriggerType,
  TechCardMaterialColorRule,
} from '@sewing/shared/tech-cards';
import {
  ORDER_APPLICATION_STAGE_LABELS,
  ORDER_APPLICATION_STATUS_LABELS,
  ORDER_APPLICATION_TYPE_LABELS,
  type OrderApplicationDto,
  type OrderApplicationStage,
  type OrderApplicationStatus,
  type OrderApplicationType,
} from '@sewing/shared/order-applications';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ClientInactiveException,
  ClientNotFoundException,
  OrderInvalidStatusTransitionException,
  OrderDeleteForbiddenException,
  OrderInvalidTransitionException,
  OrderItemsRequiredException,
  OrderLockedException,
  OrderLogisticsLineNotFoundException,
  OrderMaterialRequirementColorNotRequiredException,
  OrderOperationPlanRecalculateNotAllowedException,
  OrderOutsourceRequirementInvalidTransitionException,
  OrderOutsourceRequirementNotFoundException,
  OrderOutsourceRequirementNotReadyException,
  OrderPatternRequiredException,
  OrderTechCardAlreadyStartedException,
  OrderTechCardRequiredException,
  PatternCategoryInactiveException,
  PatternCategoryNotFoundException,
  PatternInactiveException,
  PatternNotFoundException,
  RouteTemplateInactiveException,
  RouteTemplateNotFoundException,
  TechCardNotCompatibleWithCategoryException,
} from '../../common/errors.js';
import { aggregateOrder } from './order-aggregator.js';
import { mapConstructorTaskSummary } from '../constructor-tasks/constructor-task-mappers.js';
import { OrderCostEstimatesService } from './order-cost-estimates.service.js';
import { OrderNumberService } from './order-number.service.js';
import { OrderOperationPlanService } from './order-operation-plan.service.js';
import { RoutesService } from '../routes/routes.service.js';
import { TechCardsService } from '../tech-cards/tech-cards.service.js';
import { AuditService } from '../audit/audit.service.js';
import { WorkshopNeedsService } from '../workshop-needs/workshop-needs.service.js';

type OrderWithItems = Prisma.OrderGetPayload<{
  include: {
    items: { include: { size: true } };
    passports: true;
    routeTemplate: true;
    routeSteps: { include: { operation: true; sizeOverrides: true } };
    techCard: true;
    materialRequirements: true;
    outsourceRequirements: true;
    logisticsLines: true;
    client: true;
    patternItem: {
      include: {
        constructorTask: {
          include: {
            createdBy: { select: { fullName: true } };
            assignedTo: { select: { fullName: true } };
            _count: { select: { files: true; sizeRows: true } };
          };
        };
      };
    };
    applications: { include: { sizes: { include: { size: true } } } };
    /**
     * PHASE 1 «CompanyDivision как master-справочник» (см.
     * `prisma/schema.prisma::Order.companyDivisionId`,
     * `OrdersService.toDetailDto`): подгружаем краткие
     * реквизиты карточки подразделения для DTO-ответа.
     */
    companyDivision: true;
    /**
     * Этап «Склад выпуска готовой продукции» (см.
     * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`,
     * `OrdersService.toDetailDto`): подгружаем минимальные
     * реквизиты склада-получателя готовой продукции, чтобы UI
     * карточки и списка отрисовали имя/код без дополнительного
     * запроса в `/api/warehouses/:id`.
     */
    finishedGoodsWarehouse: true;
  };
}>;

type ProductLite = { id: string; name: string; color: string };

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: OrderNumberService,
    private readonly routes: RoutesService,
    private readonly techCards: TechCardsService,
    private readonly audit: AuditService,
    private readonly workshopNeeds: WorkshopNeedsService,
    private readonly costEstimates: OrderCostEstimatesService,
    // Этап 2 «План операций на заказе»: snapshot-helper, который
    // считает плановую стоимость / время по live `RouteTemplate.steps[]`
    // и пишет три snapshot-поля + warnings в `Order` (см.
    // `docs/operation-time-norms-recon.md §11`).
    private readonly orderOperationPlan: OrderOperationPlanService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(
    dto: CreateOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    // Inline-создание изделия из формы заказа (см.
    // `prisma/schema.prisma::Order.productCreationMode`). Backend сам
    // создаёт `PatternItem` + `PatternMaterialArea[]` + technical
    // `Product` по `newProductCalculation` — см. `createWithInlinePattern`.
    const productMode = dto.productMode ?? 'EXISTING_PATTERN';
    if (productMode === 'CREATE_FOR_CALCULATION') {
      return this.createWithInlinePattern(dto, actorEmployeeId);
    }
    // SEND_TO_CONSTRUCTOR ведёт себя как EXISTING_PATTERN на уровне
    // create: лекало уже создано отдельным server action-ом
    // `saveConstructorDraftAction` (см. apps/web/app/admin/orders/new/
    // constructor-task-action.ts), и в форме лежит `patternItemId`
    // указывающий на DRAFT-pattern. Эта ветка отличается только тем,
    // что мы записываем `productCreationMode = 'SEND_TO_CONSTRUCTOR'`
    // в Order — чтобы UI карточки заказа знал, что лекало пока в
    // разработке у конструктора. Сам путь создания идёт ниже по той
    // же логике, что и EXISTING_PATTERN.

    // Этап «Номенклатура = Лекала» (см. `docs/recon-soft-integration.md
    // §«Номенклатура = Лекала»`): новая admin-форма присылает только
    // `patternItemId`. Backend сам обеспечивает legacy `productId`
    // через `ensureLegacyProductForPattern()` — один Product на лекало,
    // создаётся при первом заказе и переиспользуется дальше. Старый
    // flow (CUTTER_ASSISTANT, прямой API без лекала) продолжает
    // работать с явным `productId`. Zod в `CreateOrderSchema` уже
    // гарантировал, что хотя бы одно из двух полей задано.
    if (!dto.patternItemId && !dto.productId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_PRODUCT_OR_PATTERN_REQUIRED',
        message: 'Выберите номенклатуру / лекало',
      });
    }

    // Если пришёл legacy productId — валидируем его сразу, чтобы UI
    // получил адресную PRODUCT_NOT_FOUND/PRODUCT_INACTIVE, а не падал
    // позже на FK / на ensure-helper-е.
    if (dto.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: dto.productId },
        select: { id: true, active: true },
      });
      if (!product) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'PRODUCT_NOT_FOUND',
          message: 'Изделие не найдено',
        });
      }
      if (!product.active) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'PRODUCT_INACTIVE',
          message: 'Изделие деактивировано',
        });
      }
    }

    // Проверка существования размеров + уникальности (последнее также
    // защищено Zod-схемой, но лучше не доверять клиенту).
    const sizeIds = dto.items.map((i) => i.sizeId);
    const sizes = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
    });
    if (sizes.length !== new Set(sizeIds).size) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'SIZE_NOT_FOUND',
        message: 'Один из размеров не найден в справочнике',
      });
    }
    if (new Set(sizeIds).size !== sizeIds.length) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_DUPLICATE_SIZE',
        message: 'Размер не должен повторяться в одном заказе',
      });
    }

    // Soft-route MVP: если выбран шаблон маршрута — валидируем
    // существование и активность до открытия транзакции, чтобы UI
    // получил адресную ошибку (404 ROUTE_TEMPLATE_NOT_FOUND или
    // 409 ROUTE_TEMPLATE_INACTIVE), а не общий FK-сбой.
    if (dto.routeTemplateId) {
      await this.assertRouteTemplateUsable(dto.routeTemplateId);
    }
    // Tech card MVP (ADR-0022): аналогично route — soft-protection
    // против UI, который раздаёт неактивные значения.
    if (dto.techCardId) {
      await this.techCards.assertTechCardUsable(dto.techCardId);
    }
    // Client ref MVP: при наличии clientId проверяем существование и
    // активность клиента до открытия транзакции — по тем же причинам,
    // что и `routeTemplateId`/`techCardId` (UI-адресная ошибка вместо
    // FK-сбоя).
    if (dto.clientId) {
      await this.assertClientUsable(dto.clientId);
    }
    // Soft-pattern MVP (этап 2 «Лекала»): валидируем выбранное лекало
    // до открытия транзакции — `assertPatternUsable` отдаёт адресные
    // PATTERN_NOT_FOUND / PATTERN_INACTIVE. Если внутри транзакции
    // helper не найдёт лекало — это уже race с удалением.
    if (dto.patternItemId) {
      await this.assertPatternUsable(dto.patternItemId);
    }

    const order = await this.prisma.$transaction(async (tx) => {
      // Этап «Номенклатура = Лекала»: вычисляем productId для
      // OrderItem.productId. Если задан patternItemId — он главный,
      // backend получает/создаёт legacy Product для этого лекала.
      // Иначе используем переданный legacy productId (старый flow).
      const productIdForItems = dto.patternItemId
        ? await this.ensureLegacyProductForPattern(dto.patternItemId, tx)
        : (dto.productId as string);

      // Подразделение заказа — FK на `CompanyDivision` (см.
      // `docs/domain.md §«Подразделения заказа»`). Если `companyDivisionId`
      // передан — валидируем существование карточки, чтобы UI получил
      // адресную ошибку `COMPANY_DIVISION_NOT_FOUND` вместо сырого
      // FK-сбоя. Если не передан — заказ создаётся без привязки.
      const companyDivisionIdForCreate =
        await this.resolveCompanyDivisionIdForOrder(tx, dto.companyDivisionId);

      // Этап «Склад выпуска готовой продукции»: на create принимаем
      // `null` / непустую строку / `undefined`. Резолвер кидает
      // адресную 400 / 409, если warehouse не найден / неактивен.
      const finishedGoodsWarehouseIdForCreate =
        await this.resolveFinishedGoodsWarehouseIdForOrder(
          tx,
          dto.finishedGoodsWarehouseId,
        );

      // Цвет заказа: предпочитаем явный input.color. Если его нет —
      // в legacy product-only flow подставляем `Product.color` (как
      // раньше, см. `docs/domain.md §5a`); в pattern-flow цвета по
      // умолчанию нет (карточка лекала больше не носит цвет — он
      // указывается в форме отдельно).
      let resolvedColor: string | null = normalizeColorOrNull(dto.color);
      if (!resolvedColor && !dto.patternItemId && dto.productId) {
        const legacy = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { color: true },
        });
        resolvedColor = normalizeColorOrNull(legacy?.color);
      }

      // Этап «Цена продажи за единицу»: если пришла цена > 0 без
      // явной валюты — подставляем `RUB` (см. ТЗ «default RUB при
      // price > 0»). Если цена не задана — валюту тоже не сохраняем,
      // даже если пришла — это странно как minimum, но точно не
      // блокируем; будет nullable в БД.
      const { customerUnitPrice, customerCurrency } =
        resolveCustomerPriceAndCurrency(
          dto.customerUnitPrice ?? undefined,
          dto.customerCurrency ?? undefined,
        );

      const number = await this.numbers.nextNumber(tx);
      // Размеры заказа — для фильтрации адресации нанесений по размерам
      // (этап «Нанесение по размерам»): создаём `OrderApplicationSize`
      // только для размеров, реально присутствующих в `dto.items`.
      const orderSizeIdSet = new Set(dto.items.map((i) => i.sizeId));
      const created = await tx.order.create({
        data: {
          number,
          customer: dto.customer ?? null,
          orderDate: new Date(dto.orderDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          color: resolvedColor,
          comment: dto.comment ?? null,
          status: OrderStatus.DRAFT,
          companyDivisionId: companyDivisionIdForCreate,
          routeTemplateId: dto.routeTemplateId ?? null,
          techCardId: dto.techCardId ?? null,
          patternItemId: dto.patternItemId ?? null,
          clientId: dto.clientId ?? null,
          customerUnitPrice:
            customerUnitPrice === null
              ? null
              : customerUnitPrice === undefined
                ? null
                : new Prisma.Decimal(customerUnitPrice),
          customerCurrency: customerCurrency ?? null,
          // Этап «Склад выпуска готовой продукции»:
          // resolver вернул либо `null` (не задан / `undefined`-входе),
          // либо валидный warehouse.id. На create `undefined`-режим
          // эквивалентен «не задан» — пишем `null`.
          finishedGoodsWarehouseId:
            finishedGoodsWarehouseIdForCreate ?? null,
          // Упрощённый MVP давальческого сырья / фурнитуры клиента:
          // на create обязательно фиксируем политику. Если поле не
          // пришло / пустое / null → default `INCLUDE` (старая
          // семантика — материалы и фурнитура учитываются в
          // себестоимости).
          materialsAndHardwareCostPolicy:
            resolveMaterialsAndHardwareCostPolicy(
              dto.materialsAndHardwareCostPolicy,
              'create',
            ) ?? 'INCLUDE',
          // Этап «Отправить изделие конструктору»: если в DTO режим
          // SEND_TO_CONSTRUCTOR — фиксируем это на заказе, чтобы UI
          // мог показать плашку «Лекало в разработке у конструктора»
          // и заблокировать запуск расчёта до возврата лекала.
          // Для CREATE_FOR_CALCULATION эта ветка не используется
          // (отдельный путь `createWithInlinePattern` выставляет
          // productCreationMode сам, см. ниже).
          productCreationMode:
            productMode === 'SEND_TO_CONSTRUCTOR'
              ? 'SEND_TO_CONSTRUCTOR'
              : 'EXISTING_PATTERN',
          items: {
            create: dto.items.map((i) => ({
              productId: productIdForItems,
              sizeId: i.sizeId,
              qtyPlan: i.qtyPlan,
            })),
          },
          // Этап «Нанесение на заказе покупателя»: если форма создания
          // заказа передала `applications` — создаём строки сразу же
          // в этой же транзакции через nested-write. Семантика та же,
          // что у `OrderApplicationsService.replaceForOrder`:
          //   - `unit` дефолт `'шт'`;
          //   - `status` дефолт `'PLANNED'`;
          //   - `quantity` оборачиваем в `Prisma.Decimal`;
          //   - пустые строки уже отнормированы Zod-схемой в null/undefined.
          // Маршрут / техкарта / Product / Passport не трогаются —
          // OrderApplication отдельная таблица с FK только на Order.
          applications:
            dto.applications && dto.applications.length > 0
              ? {
                  create: dto.applications.map((app) => {
                    // Адресация по размерам (этап «Нанесение по
                    // размерам»): оставляем только размеры, реально
                    // присутствующие в заказе, и дедупим по `sizeId`.
                    const sizeRows = (app.sizes ?? [])
                      .filter((s) => orderSizeIdSet.has(s.sizeId))
                      .filter(
                        (s, i, arr) =>
                          arr.findIndex((x) => x.sizeId === s.sizeId) === i,
                      );
                    return {
                      type: app.type,
                      stage: app.stage,
                      placement: app.placement ?? null,
                      widthMm: app.widthMm ?? null,
                      heightMm: app.heightMm ?? null,
                      colorsCount: app.colorsCount ?? null,
                      quantity:
                        app.quantity == null
                          ? null
                          : new Prisma.Decimal(app.quantity),
                      unit: app.unit ?? 'шт',
                      colorText: app.colorText ?? null,
                      description: app.description ?? null,
                      comment: app.comment ?? null,
                      fileUrl: app.fileUrl ?? null,
                      status: app.status ?? 'PLANNED',
                      groupKey: app.groupKey ?? null,
                      groupLabel: app.groupLabel ?? null,
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
                    };
                  }),
                }
              : undefined,
        },
        include: {
          items: { include: { size: true } },
          passports: true,
          routeTemplate: true,
          routeSteps: { include: { operation: true, sizeOverrides: true } },
          techCard: true,
          materialRequirements: true,
          outsourceRequirements: true,
          client: true,
          patternItem: true,
          // Этап «Нанесение на заказе покупателя»: на создании заказа
          // массив всегда пуст; добавляем include для строгого
          // соответствия `OrderWithItems`-типу (см. выше).
          applications: true,
          // PHASE 1: подгружаем краткие реквизиты `CompanyDivision`
          // для того же DTO-контракта, что и `getOne`.
          companyDivision: true,
          // Этап «Склад выпуска готовой продукции»: краткие реквизиты
          // выбранного склада-получателя, чтобы UI отрисовал имя/код
          // без отдельного запроса.
          finishedGoodsWarehouse: true,
        },
      });
      // Этап 2 «План операций на заказе» (см.
      // `docs/operation-time-norms-recon.md §11`): после фиксации
      // заказа и его items в той же транзакции считаем snapshot
      // плановой стоимости / времени операций. Это безопасно по
      // контракту:
      //   - если у заказа нет `routeTemplateId` или нет items с
      //     `qtyPlan > 0` — план считается `null` + warning, заказ
      //     не блокируется;
      //   - если у операций нет ставок/норм времени — отдельные
      //     warnings, остальные части плана учитываются.
      // Snapshot пишется внутри той же tx — либо заказ создан со
      // snapshot-ом, либо никто не создан (целостность).
      await this.orderOperationPlan.recalculateAndWrite(created.id, tx);

      // Этап «План операций до запуска» (см. ТЗ «Подтягивать операции
      // при выборе маршрута»): сразу после расчёта стоимости/времени
      // материализуем snapshot шагов маршрута `OrderRouteStep[]`.
      // До этого изменения snapshot шагов появлялся только в `start()`,
      // и обе вкладки карточки заказа («Операции», «Сводно по заказу»)
      // в DRAFT/CALCULATION показывали пустой список — даже когда
      // `Order.operationCostPlanRub` уже был посчитан. Если шаблон не
      // выбран, helper становится no-op (см. JSDoc).
      await this.syncOrderRouteStepsSnapshot(created.id, tx);

      // Этап «Указать в заказе» (см. ТЗ §2): если у заказа выбрана
      // техкарта — сразу собираем snapshot `OrderMaterialRequirement[]`,
      // чтобы поле «Цвет» по строкам с `colorRule = ORDER_SELECTED_COLOR`
      // было видно менеджеру в DRAFT/CALCULATION/CALCULATION_DONE
      // ещё до запуска заказа. Раньше snapshot строился только в
      // `start()`, и менеджер не мог заполнить «Цвет нужно указать
      // в заказе» до перевода в производство. На существующих
      // заказах snapshot пересоберётся при следующем `update` /
      // `startCalculation`.
      if (dto.techCardId) {
        await this.rebuildMaterialRequirementsSnapshot(created.id, tx);
      }

      // Audit (см. `docs/domain.md §«Audit log»`): создание заказа.
      // payload — минимальный «паспорт заказа»: number/productId/
      // companyDivisionId/qtyPlanTotal плюс id выбранных шаблона и
      // техкарты. Этого достаточно, чтобы по журналу понять, какой
      // заказ был заведён, кем и с каким снаряжением, без чтения
      // самого OrderItem-а. `productId` фиксируется через
      // резолвленный `productIdForItems`, чтобы по журналу было
      // видно, какой legacy Product реально лёг в OrderItem (важно
      // для заказов, где Product создан helper-ом из лекала).
      await this.audit.log(
        {
          event: 'ORDER_CREATED',
          entityType: 'ORDER',
          entityId: created.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            number: created.number,
            productId: productIdForItems,
            companyDivisionId: created.companyDivisionId,
            companyDivisionCode: created.companyDivision?.code ?? null,
            qtyPlanTotal: dto.items.reduce((s, i) => s + i.qtyPlan, 0),
            sizeIds: dto.items.map((i) => i.sizeId),
            routeTemplateId: created.routeTemplateId,
            techCardId: created.techCardId,
            patternItemId: created.patternItemId,
            clientId: created.clientId,
            // Этап «Нанесение»: фиксируем счётчик, чтобы по журналу
            // было видно, заводился ли заказ сразу с нанесениями.
            applicationsCount: dto.applications?.length ?? 0,
          },
        },
        tx,
      );
      return created;
    });

    // Перечитываем заказ через `getOne(...)`, потому что внутри
    // транзакции план операций был записан отдельным
    // `tx.order.update` в `OrderOperationPlanService.recalculateAndWrite`,
    // и in-memory `order` из `tx.order.create` всё ещё имеет
    // snapshot-поля = `null`. `getOne` отдаст актуальное состояние
    // (включая live PatternItem / techCard / routeSteps / план
    // операций) — этим же путём ходят `update` / `startCalculation` /
    // `start` / `complete`. Лишний `findUnique` на запись стоит
    // ничтожно дёшево по сравнению с консистентным DTO.
    return this.getOne(order.id);
  }

  /**
   * Этап «Номенклатура = Лекала» (см. `docs/recon-soft-integration.md
   * §«Номенклатура = Лекала»`): для выбранного `PatternItem`
   * возвращает id «технического» legacy Product, который пойдёт в
   * `OrderItem.productId` (а через него — в Passport / прочий
   * старый учёт).
   *
   * Инварианты:
   *   - один лекало = один Product (`PatternItem.legacyProductId @unique`),
   *     повторное создание заказа по тому же лекалу не плодит
   *     Product-ов;
   *   - вызывается ВНУТРИ транзакции (`tx`), чтобы создание Product
   *     и проставление `legacyProductId` были атомарными — иначе
   *     возможен дубликат Product при гонке двух параллельных
   *     `OrdersService.create()` по одному и тому же лекалу;
   *   - валидация лекала (`PATTERN_NOT_FOUND`/`PATTERN_INACTIVE`)
   *     уже сделана выше до открытия транзакции — здесь только
   *     повторная проверка existence как предохранитель.
   *
   * Если у Product, на который указывает `legacyProductId`, флаг
   * `active = false` — мы НЕ кидаем `PRODUCT_INACTIVE`: технический
   * Product управляется только бэкендом, и менеджер его в UI не
   * видит. Если кто-то вручную деактивирует такой Product — мы
   * возвращаем его как есть (паспорта по нему могут быть «вечно
   * активны»). Это сознательная мягкость, чтобы случайный admin-
   * cleanup не блокировал создание новых заказов по лекалу.
   */
  async ensureLegacyProductForPattern(
    patternItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const pattern = await tx.patternItem.findUnique({
      where: { id: patternItemId },
      select: {
        id: true,
        name: true,
        status: true,
        legacyProductId: true,
        constructorTask: { select: { status: true } },
      },
    });
    if (!pattern) throw new PatternNotFoundException();
    // DRAFT-pattern допускается, если рядом висит активная
    // `ConstructorTask` (NEW/IN_PROGRESS/PENDING_ACCEPT/REWORK) —
    // менеджер собирает заказ вокруг лекала, которое ещё разрабатывает
    // конструктор. Запуск в производство (`start`) всё равно требует
    // ACTIVE — он валидируется отдельно. См. `assertPatternUsable`.
    const taskStatus = pattern.constructorTask?.status;
    const taskIsActive =
      taskStatus === 'NEW' ||
      taskStatus === 'IN_PROGRESS' ||
      taskStatus === 'PENDING_ACCEPT' ||
      taskStatus === 'REWORK';
    const draftAllowed = pattern.status === 'DRAFT' && taskIsActive;
    if (pattern.status !== 'ACTIVE' && !draftAllowed) {
      throw new PatternInactiveException();
    }

    // Уже привязан Product → используем его. Дополнительно проверяем,
    // что он реально существует (на случай ручного DELETE FROM
    // Product без обновления PatternItem.legacyProductId — FK
    // `ON DELETE SET NULL` обычно это не допускает, но защитимся).
    if (pattern.legacyProductId) {
      const existing = await tx.product.findUnique({
        where: { id: pattern.legacyProductId },
        select: { id: true },
      });
      if (existing) return existing.id;
      // Привязка осталась «висящей» — продолжаем как будто её нет,
      // helper создаст новый Product ниже.
    }

    // Создаём «технический» Product. `name` копируем с лекала
    // (для UI / отчётов / истории паспортов). `color` в схеме
    // обязателен → пишем пустую строку: цвет конкретного заказа
    // живёт на `Order.color`, и UI берёт его оттуда, не из
    // `Product.color`. `active = true` — без этого старые проверки
    // PRODUCT_INACTIVE могли бы упасть на legacy-консьюмерах.
    const created = await tx.product.create({
      data: {
        name: pattern.name,
        color: '',
        active: true,
      },
      select: { id: true },
    });
    await tx.patternItem.update({
      where: { id: patternItemId },
      data: { legacyProductId: created.id },
    });
    return created.id;
  }

  // -------------------------------------------------------------------------
  // CREATE (CREATE_FOR_CALCULATION)
  // -------------------------------------------------------------------------

  /**
   * Inline-сценарий «Создать изделие → Сделать расчёт» (см.
   * `prisma/schema.prisma::Order.productCreationMode`,
   * `apps/web/app/admin/orders/new/create-product-modal.tsx`).
   *
   * Атомарно создаёт `PatternItem` + `PatternMaterialArea[]` +
   * technical `Product` + `Order` + `OrderItem[]` в одной транзакции.
   * Делает те же snapshot-вызовы, что и стандартная ветка create —
   * `startCalculation` после этого проходит без отличий.
   */
  private async createWithInlinePattern(
    dto: CreateOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const calc = dto.newProductCalculation;
    if (!calc) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_NEW_PRODUCT_CALCULATION_REQUIRED',
        message:
          'Для режима «Создать изделие» нужны данные нового изделия',
      });
    }

    // Опционально: группа номенклатуры. Если выбрана, валидируем
    // existence/активность и собираем `AREA_M2_BY_SIZE`-параметры
    // для проверки совместимости areas[].roleKey. Если не выбрана —
    // продолжаем без категории (PatternItem.categoryId = null).
    type PatternCategoryWithParameters = Prisma.PatternCategoryGetPayload<{
      include: {
        parameters: { where: { status: 'ACTIVE' }; orderBy: { sortOrder: 'asc' } };
      };
    }>;
    let category: PatternCategoryWithParameters | null = null;
    let requiredRoleKeys = new Set<string>();
    if (calc.categoryId) {
      category = await this.prisma.patternCategory.findUnique({
        where: { id: calc.categoryId },
        include: {
          parameters: {
            where: { status: 'ACTIVE' },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });
      if (!category) throw new PatternCategoryNotFoundException();
      if (category.status !== 'ACTIVE') {
        throw new PatternCategoryInactiveException();
      }
      requiredRoleKeys = new Set(
        category.parameters
          .filter((p) => p.inputType === 'AREA_M2_BY_SIZE')
          .map((p) => p.roleKey),
      );

      // areas[].roleKey валидируем только если категория задана —
      // иначе backend принимает любые строки (фактически их не должно
      // быть, UI не покажет колонки расхода).
      for (let i = 0; i < calc.sizes.length; i += 1) {
        const row = calc.sizes[i];
        for (let j = 0; j < row.areas.length; j += 1) {
          const a = row.areas[j];
          if (!requiredRoleKeys.has(a.roleKey)) {
            throw new BadRequestException({
              statusCode: 400,
              code: 'ORDER_NEW_PRODUCT_AREA_ROLE_INVALID',
              message: `Параметр «${a.roleKey}» не входит в группу «${category.name}»`,
              path: ['newProductCalculation', 'sizes', i, 'areas', j, 'roleKey'],
            });
          }
        }
      }
    }

    // Размеры — валидируем existence только если хоть один передан.
    if (calc.sizes.length > 0) {
      const sizeIds = Array.from(new Set(calc.sizes.map((s) => s.sizeId)));
      const knownSizes = await this.prisma.size.findMany({
        where: { id: { in: sizeIds } },
        select: { id: true },
      });
      if (knownSizes.length !== sizeIds.length) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'SIZE_NOT_FOUND',
          message: 'Один из размеров не найден в справочнике',
        });
      }
    }

    // Опционально: техкарта. Если выбрана — валидируем активность.
    // Совместимость с категорией проверяем только когда заданы оба.
    if (calc.techCardId) {
      await this.techCards.assertTechCardUsable(calc.techCardId);
      if (category && requiredRoleKeys.size > 0) {
        await this.assertTechCardCompatibleWithCategory(
          calc.techCardId,
          requiredRoleKeys,
        );
      }
    }

    if (dto.routeTemplateId) {
      await this.assertRouteTemplateUsable(dto.routeTemplateId);
    }
    if (dto.clientId) {
      await this.assertClientUsable(dto.clientId);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.numbers.nextNumber(tx);

      const newPattern = await tx.patternItem.create({
        data: {
          name: category
            ? `${category.name} / заказ ${number}`
            : `Новое изделие · заказ ${number}`,
          article: `CUSTOM-${number}`,
          categoryId: category?.id ?? null,
          status: 'ACTIVE',
        },
      });

      const materialAreasData: Prisma.PatternMaterialAreaCreateManyInput[] =
        [];
      for (const row of calc.sizes) {
        for (const a of row.areas) {
          materialAreasData.push({
            patternItemId: newPattern.id,
            sizeId: row.sizeId,
            materialRole: a.roleKey,
            areaM2: new Prisma.Decimal(a.areaM2),
          });
        }
      }
      if (materialAreasData.length > 0) {
        await tx.patternMaterialArea.createMany({
          data: materialAreasData,
        });
      }

      const legacyProductId = await this.ensureLegacyProductForPattern(
        newPattern.id,
        tx,
      );

      const companyDivisionIdForCreate =
        await this.resolveCompanyDivisionIdForOrder(
          tx,
          dto.companyDivisionId,
        );
      const finishedGoodsWarehouseIdForCreate =
        await this.resolveFinishedGoodsWarehouseIdForOrder(
          tx,
          dto.finishedGoodsWarehouseId,
        );
      const { customerUnitPrice, customerCurrency } =
        resolveCustomerPriceAndCurrency(
          dto.customerUnitPrice ?? undefined,
          dto.customerCurrency ?? undefined,
        );

      const orderRow = await tx.order.create({
        data: {
          number,
          customer: dto.customer ?? null,
          orderDate: new Date(dto.orderDate),
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          color: normalizeColorOrNull(dto.color),
          comment: dto.comment ?? null,
          status: OrderStatus.DRAFT,
          companyDivisionId: companyDivisionIdForCreate,
          routeTemplateId: dto.routeTemplateId ?? null,
          techCardId: calc.techCardId ?? null,
          patternItemId: newPattern.id,
          clientId: dto.clientId ?? null,
          customerUnitPrice:
            customerUnitPrice == null
              ? null
              : new Prisma.Decimal(customerUnitPrice),
          customerCurrency: customerCurrency ?? null,
          finishedGoodsWarehouseId:
            finishedGoodsWarehouseIdForCreate ?? null,
          materialsAndHardwareCostPolicy:
            resolveMaterialsAndHardwareCostPolicy(
              dto.materialsAndHardwareCostPolicy,
              'create',
            ) ?? 'INCLUDE',
          productCreationMode: 'CREATE_FOR_CALCULATION',
          patternDevelopmentCostRub:
            calc.patternDevelopmentCostRub == null
              ? null
              : new Prisma.Decimal(calc.patternDevelopmentCostRub),
          patternDevelopmentCostInCostPrice:
            calc.patternDevelopmentCostInCostPrice ?? true,
          // items создаются только если размеры переданы. Допустимо
          // создать заказ-черновик без OrderItem'ов — расчёт потом
          // потребует их через `startCalculation` (`ORDER_ITEMS_REQUIRED`).
          ...(calc.sizes.length > 0
            ? {
                items: {
                  create: calc.sizes.map((row) => ({
                    productId: legacyProductId,
                    sizeId: row.sizeId,
                    qtyPlan: row.qtyPlan,
                  })),
                },
              }
            : {}),
        },
      });

      await this.orderOperationPlan.recalculateAndWrite(orderRow.id, tx);
      await this.syncOrderRouteStepsSnapshot(orderRow.id, tx);
      await this.rebuildMaterialRequirementsSnapshot(orderRow.id, tx);

      await this.audit.log(
        {
          event: 'ORDER_CREATED',
          entityType: 'ORDER',
          entityId: orderRow.id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            number: orderRow.number,
            productId: legacyProductId,
            companyDivisionId: orderRow.companyDivisionId,
            qtyPlanTotal: calc.sizes.reduce(
              (s, i) => s + i.qtyPlan,
              0,
            ),
            sizeIds: calc.sizes.map((s) => s.sizeId),
            routeTemplateId: orderRow.routeTemplateId,
            techCardId: orderRow.techCardId,
            patternItemId: orderRow.patternItemId,
            clientId: orderRow.clientId,
            productCreationMode: 'CREATE_FOR_CALCULATION',
            inlinePatternCategoryId: category?.id ?? null,
            inlinePatternMaterialAreaCount: materialAreasData.length,
            patternDevelopmentCostRub:
              calc.patternDevelopmentCostRub ?? null,
          },
        },
        tx,
      );

      return orderRow;
    });

    return this.getOne(created.id);
  }

  /**
   * Inline-создание изделия: проверяет, что у выбранной техкарты есть
   * `TechCardMaterialLine.materialRole` для каждого `AREA_M2_BY_SIZE`-
   * параметра категории. Иначе кидает 409
   * `TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY` с `missingRoleKeys`.
   */
  private async assertTechCardCompatibleWithCategory(
    techCardId: string,
    requiredRoleKeys: Set<string>,
  ): Promise<void> {
    if (requiredRoleKeys.size === 0) return;
    const lines = await this.prisma.techCardMaterialLine.findMany({
      where: { techCardId },
      select: { materialRole: true },
    });
    const present = new Set<string>();
    for (const l of lines) {
      if (l.materialRole) present.add(l.materialRole);
    }
    const missing: string[] = [];
    for (const role of requiredRoleKeys) {
      if (!present.has(role)) missing.push(role);
    }
    if (missing.length > 0) {
      throw new TechCardNotCompatibleWithCategoryException(missing);
    }
  }

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(query: ListOrdersQuery): Promise<Paginated<OrderListItemDto>> {
    const where: Prisma.OrderWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.clientId) where.clientId = query.clientId;
    if (query.companyDivisionId)
      where.companyDivisionId = query.companyDivisionId;
    if (query.search && query.search.length > 0) {
      where.number = { contains: query.search, mode: 'insensitive' };
    }

    const orderBy: Prisma.OrderOrderByWithRelationInput = ((): Prisma.OrderOrderByWithRelationInput => {
      switch (query.sort) {
        case 'orderDate_asc':
          return { orderDate: 'asc' };
        case 'orderDate_desc':
          return { orderDate: 'desc' };
        case 'createdAt_asc':
          return { createdAt: 'asc' };
        case 'createdAt_desc':
        default:
          return { createdAt: 'desc' };
      }
    })();

    // Deadline-фильтр считается AFTER Prisma-выборки: бакет заказа
    // зависит от derived `qtyFinished` (Σ Passport.qtyGood по PACKED) и
    // от текущей даты, что в `WHERE` не выразить. Поэтому при наличии
    // `deadline` мы не используем БД-пагинацию: берём всю выборку,
    // считаем deadline, фильтруем, режем уже в памяти. На MVP-объёмах
    // (тысячи заказов) это не проблема. Для остальных запросов
    // оставляем чистую БД-пагинацию.
    const useDeadlineFilter = query.deadline !== undefined;
    const dbRows = await this.prisma.order.findMany({
      where,
      orderBy,
      ...(useDeadlineFilter
        ? {}
        : {
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
      include: {
        items: { include: { product: true } },
        routeTemplate: true,
        client: { select: { id: true, name: true } },
        // Soft-pattern MVP (этап 2 «Лекала»): тонкий select по
        // карточке лекала. Snapshot-поля `patternNameSnapshot` /
        // `patternArticleSnapshot` / `patternPreviewSnapshotUrl`
        // лежат на самом `Order` — отдельный include для них не
        // нужен.
        patternItem: {
          select: {
            id: true,
            name: true,
            article: true,
            previewImageUrl: true,
            // Этап «Конструкторское бюро»: один лёгкий select по
            // связанной задаче — UI на `/admin/orders` показывает
            // маленький бейдж рядом со статусом заказа, если задача
            // в активном состоянии (NEW/IN_PROGRESS/PENDING_ACCEPT/REWORK).
            constructorTask: {
              select: { id: true, status: true },
            },
          },
        },
        // PHASE 1: краткие реквизиты карточки подразделения для
        // `OrderListItemDto.companyDivision`. Snapshot нам тут не
        // нужен — UI рисует current `name`/`code` из live-карточки.
        companyDivision: {
          select: { id: true, code: true, name: true },
        },
        // Этап «Склад выпуска готовой продукции»: тонкий select для
        // `OrderListItemDto.finishedGoodsWarehouse`. Это
        // **управленческое** поле — `StockBalance` / `StockMovement`
        // не затрагивается.
        finishedGoodsWarehouse: {
          select: { id: true, name: true, code: true },
        },
        // Тонкий select по паспортам: только то, что нужно для
        // qtyFinishedTotal. Полный include паспортов сюда не нужен.
        passports: { select: { qtyGood: true, status: true } },
      },
    });

    const totalPromise = useDeadlineFilter
      ? Promise.resolve(0) // переоценим ниже
      : this.prisma.order.count({ where });

    const allItems: OrderListItemDto[] = dbRows.map((o) =>
      this.toListItemDto(o),
    );

    let items = allItems;
    let total = await totalPromise;
    if (useDeadlineFilter) {
      const filtered = allItems.filter(
        (i) => i.deadline?.status === query.deadline,
      );
      total = filtered.length;
      const start = (query.page - 1) * query.pageSize;
      items = filtered.slice(start, start + query.pageSize);
    }

    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Маппер БД-строки заказа в `OrderListItemDto`. Вынесен из `list`,
   * чтобы deadline-фильтр и обычная пагинация работали через одну
   * формулу подсчёта `qtyFinishedTotal` и `deadline` (см.
   * `evaluateOrderDeadline` в `@sewing/shared/order-deadlines`).
   *
   * `qtyFinishedTotal` считается как Σ `Passport.qtyGood` по паспортам
   * заказа в статусе `PACKED` — та же семантика, что в
   * `aggregateOrder` (см. `apps/api/src/modules/orders/order-aggregator.ts`),
   * только без размер-разреза.
   */
  private toListItemDto(o: {
    id: string;
    number: string;
    orderDate: Date;
    createdAt: Date;
    updatedAt: Date;
    inProductionAt: Date | null;
    status: OrderStatus;
    color: string | null;
    comment: string | null;
    customer: string | null;
    clientId: string | null;
    client: { id: string; name: string } | null;
    dueDate: Date | null;
    /**
     * Подразделение заказа — FK на master-справочник `CompanyDivision`.
     * `null` — заказ создан без привязки к подразделению.
     */
    companyDivisionId: string | null;
    companyDivision: { id: string; code: string; name: string } | null;
    routeTemplateId: string | null;
    routeTemplate: { code: string; name: string } | null;
    routeModeOverride: RouteModeOverride;
    patternItemId: string | null;
    patternItem: {
      id: string;
      name: string;
      article: string;
      previewImageUrl: string | null;
      constructorTask: { id: string; status: string } | null;
    } | null;
    patternNameSnapshot: string | null;
    patternArticleSnapshot: string | null;
    patternPreviewSnapshotUrl: string | null;
    customerUnitPrice: Prisma.Decimal | null;
    customerCurrency: string | null;
    /**
     * Этап «Склад выпуска готовой продукции» (см.
     * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`).
     * Управленческое поле — не влияет на StockBalance / StockMovement.
     */
    finishedGoodsWarehouseId: string | null;
    finishedGoodsWarehouse: {
      id: string;
      name: string;
      code: string | null;
    } | null;
    /**
     * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
     * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`).
     * В БД хранится строкой; маппер ниже сужает к
     * `OrderMaterialsAndHardwareCostPolicy`.
     */
    materialsAndHardwareCostPolicy: string;
    operationCostPlanRub: Prisma.Decimal | null;
    operationTimePlanSec: number | null;
    operationPlanCalculatedAt: Date | null;
    operationPlanWarnings: Prisma.JsonValue | null;
    /** Inline-создание изделия из формы заказа. */
    productCreationMode: string;
    patternDevelopmentCostRub: Prisma.Decimal | null;
    items: { qtyPlan: number; product: { id: string; name: string; color: string } | null }[];
    passports: { qtyGood: number; status: PassportStatus }[];
  }): OrderListItemDto {
    const firstItem = o.items[0];
    const product = firstItem?.product
      ? {
          id: firstItem.product.id,
          name: firstItem.product.name,
          color: firstItem.product.color,
        }
      : null;
    const qtyPlanTotal = o.items.reduce((s, i) => s + i.qtyPlan, 0);
    const qtyFinishedTotal = o.passports.reduce(
      (s, p) => (p.status === PassportStatus.PACKED ? s + p.qtyGood : s),
      0,
    );
    const deadline = evaluateDeadlineForDto({
      status: o.status,
      dueDate: o.dueDate,
      qtyPlan: qtyPlanTotal,
      qtyFinished: qtyFinishedTotal,
    });
    return {
      id: o.id,
      number: o.number,
      orderDate: o.orderDate.toISOString(),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
      inProductionAt: o.inProductionAt ? o.inProductionAt.toISOString() : null,
      status: o.status,
      productId: product?.id ?? null,
      productName: product?.name ?? null,
      color: o.color ?? product?.color ?? null,
      comment: o.comment,
      customer: o.customer,
      clientId: o.clientId,
      client: o.client ? { id: o.client.id, name: o.client.name } : null,
      dueDate: o.dueDate ? o.dueDate.toISOString() : null,
      qtyPlanTotal,
      qtyFinishedTotal,
      deadline,
      companyDivisionId: o.companyDivisionId,
      companyDivision: o.companyDivision
        ? {
            id: o.companyDivision.id,
            code: o.companyDivision.code,
            name: o.companyDivision.name,
          }
        : null,
      routeTemplateId: o.routeTemplateId,
      routeTemplateCode: o.routeTemplate?.code ?? null,
      routeTemplateName: o.routeTemplate?.name ?? null,
      routeModeOverride: o.routeModeOverride,
      // Soft-pattern MVP (этап 2 «Лекала»): live-поля карточки
      // лекала + snapshot-поля заказа. UI выбирает, что показать
      // (см. правило в `OrderListItemDto`-комментарии).
      patternItemId: o.patternItemId,
      patternName: o.patternItem?.name ?? null,
      patternArticle: o.patternItem?.article ?? null,
      patternPreviewImageUrl: o.patternItem?.previewImageUrl ?? null,
      patternNameSnapshot: o.patternNameSnapshot,
      patternArticleSnapshot: o.patternArticleSnapshot,
      patternPreviewSnapshotUrl: o.patternPreviewSnapshotUrl,
      // Этап «Цена продажи за единицу»: nullable Decimal → string,
      // nullable currency → string. UI на это рассчитан (см.
      // `OrderListItemDto.customerUnitPrice`).
      customerUnitPrice: o.customerUnitPrice
        ? o.customerUnitPrice.toString()
        : null,
      customerCurrency:
        (o.customerCurrency as 'RUB' | 'USD' | null) ?? null,
      // Этап «Склад выпуска готовой продукции»: краткие реквизиты
      // выбранного склада-получателя (id + name + code) либо `null`,
      // если склад не выбран. Это управленческое поле, в плоскости
      // склада материалов оно ничего не меняет.
      finishedGoodsWarehouseId: o.finishedGoodsWarehouseId,
      finishedGoodsWarehouse: o.finishedGoodsWarehouse
        ? {
            id: o.finishedGoodsWarehouse.id,
            name: o.finishedGoodsWarehouse.name,
            code: o.finishedGoodsWarehouse.code,
          }
        : null,
      // Упрощённый MVP давальческого сырья / фурнитуры клиента:
      // нормализованная политика учёта (`INCLUDE` / `EXCLUDE`).
      // Backend кладёт всегда — default `INCLUDE` для исторических
      // заказов после миграции.
      materialsAndHardwareCostPolicy:
        normalizeMaterialsAndHardwareCostPolicy(
          o.materialsAndHardwareCostPolicy,
        ),
      // Этап 2 «План операций на заказе»: snapshot полей в API.
      // Decimal сериализуется строкой (`toString`), warnings —
      // нормализуются через helper, который не падает на не-массивах
      // (исторические/ручные правки могут лежать в JSONB как угодно).
      operationCostPlanRub: o.operationCostPlanRub
        ? o.operationCostPlanRub.toString()
        : null,
      operationTimePlanSec: o.operationTimePlanSec ?? null,
      operationPlanCalculatedAt: o.operationPlanCalculatedAt
        ? o.operationPlanCalculatedAt.toISOString()
        : null,
      operationPlanWarnings: normalizeOperationPlanWarnings(
        o.operationPlanWarnings,
      ),
      productCreationMode: normalizeProductCreationMode(o.productCreationMode),
      patternDevelopmentCostRub: o.patternDevelopmentCostRub
        ? o.patternDevelopmentCostRub.toString()
        : null,
      // Этап «Конструкторское бюро»: id и статус связанной задачи,
      // если pattern был создан через flow «Отправить конструктору».
      // UI на `/admin/orders` показывает маленький бейдж в колонке
      // «Статус» только для активных статусов (см. шаблон).
      constructorTaskId: o.patternItem?.constructorTask?.id ?? null,
      constructorTaskStatus: o.patternItem?.constructorTask?.status ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // DETAIL
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        items: { include: { size: true, product: true } },
        passports: true,
        routeTemplate: true,
        routeSteps: {
          orderBy: { index: 'asc' },
          include: { operation: true, sizeOverrides: true },
        },
        techCard: true,
        materialRequirements: { orderBy: { sortOrder: 'asc' } },
        outsourceRequirements: { orderBy: { sortOrder: 'asc' } },
        // Ручные строки логистики заказа — рендерятся в конце таблицы
        // «Операции» карточки заказа. Сортируем по `sortOrder`.
        logisticsLines: { orderBy: { sortOrder: 'asc' } },
        client: true,
        // Soft-pattern MVP (этап 2 «Лекала»): полная карточка лекала
        // нужна детали для виджета `PatternPreviewCard` в UI карточки
        // заказа. Snapshot-поля лежат на `Order` напрямую.
        // Этап «Конструкторское бюро»: подгружаем связанную задачу с
        // именами создателя/назначенного — UI карточки заказа рендерит
        // полную карточку «Конструкторское бюро» с действиями приёмки.
        patternItem: {
          include: {
            constructorTask: {
              include: {
                createdBy: { select: { fullName: true } },
                assignedTo: { select: { fullName: true } },
                _count: { select: { files: true, sizeRows: true } },
              },
            },
          },
        },
        // Этап «Нанесение на заказе покупателя»: подгружаем
        // заказные нанесения, чтобы UI карточки (`/admin/orders/[id]`)
        // мог отрендерить блок «Нанесение» без отдельного запроса.
        // Сортировка по `createdAt` — стабильная для UI порядок строк.
        applications: {
          orderBy: { createdAt: 'asc' },
          // Адресация по размерам (этап «Нанесение по размерам»).
          include: {
            sizes: {
              include: { size: true },
              orderBy: { size: { sortOrder: 'asc' } },
            },
          },
        },
        // PHASE 1: краткие реквизиты карточки подразделения для
        // `OrderDetailDto.companyDivision`. См. `toDetailDto`.
        companyDivision: true,
        // Этап «Склад выпуска готовой продукции»: краткие реквизиты
        // выбранного склада-получателя для `OrderDetailDto`.
        finishedGoodsWarehouse: true,
      },
    });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    const firstItem = order.items[0];
    const product = firstItem?.product
      ? {
          id: firstItem.product.id,
          name: firstItem.product.name,
          color: firstItem.product.color,
        }
      : null;
    return this.toDetailDto(order, product, order.color ?? product?.color ?? null);
  }

  /**
   * Ручное переопределение адаптивного режима сплит-распошива заказа
   * (см. `apps/api/src/modules/passports/route-mode.ts`).
   *
   * AUTO — режим SPLIT/COLLAPSED вычисляется на лету по активным сменам;
   * FORCE_SPLIT / FORCE_COLLAPSED — мастер фиксирует режим вручную (страховка
   * от залипших смен и дребезга). В отличие от план-полей, меняется и в
   * IN_PRODUCTION — это рантайм-настройка, а не состав заказа. Снапшот
   * маршрута (`OrderRouteStep`) НЕ трогаем: режим влияет только на трактовку
   * распошива и монитор цеха. На завершённом/отменённом заказе бессмысленно.
   */
  async setRouteModeOverride(
    id: string,
    override: RouteModeOverride,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, status: true, routeModeOverride: true },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (
      order.status === OrderStatus.DONE ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: 'ORDER_INVALID_STATUS_TRANSITION',
        message: 'Режим распошива нельзя менять у завершённого или отменённого заказа',
      });
    }
    if (order.routeModeOverride !== override) {
      await this.prisma.order.update({
        where: { id },
        data: { routeModeOverride: override },
      });
      await this.audit.log({
        event: 'ORDER_ROUTE_MODE_OVERRIDE_SET',
        entityType: 'ORDER',
        entityId: id,
        employeeId: actorEmployeeId ?? null,
        payload: { before: order.routeModeOverride, after: override },
      });
    }
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // ROUTE STEPS SNAPSHOT — sync with current Order.routeTemplateId
  // -------------------------------------------------------------------------

  /**
   * Этап «План операций до запуска» (см. ТЗ «Подтягивать операции при
   * выборе маршрута, не ждать IN_PRODUCTION»).
   *
   * Синхронизирует snapshot `OrderRouteStep[]` с текущим
   * `Order.routeTemplateId`. До этой ручки snapshot маршрута жил только
   * после `OrdersService.start()`, и обе вкладки карточки заказа
   * (`OrderOperationsTab`, `OrderSummaryTab`) до запуска показывали
   * пустой список операций — даже если уже посчитанная backend-ом
   * стоимость операций (`Order.operationCostPlanRub`) была не-null.
   *
   * Контракт:
   *   - читает `Order.routeTemplateId` и текущий `OrderRouteStep[]`
   *     внутри переданной транзакции;
   *   - если шаблона нет → удаляет все snapshot-строки (заказ остался
   *     без маршрута, операций показывать не должны);
   *   - если шаблон есть → сравнивает с текущим snapshot-ом и, если
   *     либо состав, либо порядок отличаются, атомарно
   *     `deleteMany + createMany` — это единственный безопасный путь
   *     при `@@unique([orderId, index])`;
   *   - **silent no-op только на нехватке бизнес-данных**: «нет
   *     заказа / нет шаблона / шаблон есть, но шагов нет» —
   *     корректное штатное состояние, заказ остаётся валидным.
   *   - **технические ошибки пробрасываются как есть** (контракт
   *     edge-case-проверки этапа «План операций до запуска»):
   *       - `tx.order.findUnique` / `tx.orderRouteStep.findMany` —
   *         любая Prisma-ошибка БД пробрасывается;
   *       - `tx.orderRouteStep.deleteMany` / `createMany` —
   *         ошибки FK / unique / connection пробрасываются и
   *         откатывают всю обёртывающую транзакцию (`create` /
   *         `update` / `recalculateOperationPlan` /
   *         `startCalculation`);
   *       - `routes.getActiveStepsForSnapshot()` — бросает
   *         `RouteTemplateNotFoundException` (404), если
   *         `Order.routeTemplateId` указывает на несуществующий
   *         шаблон. Это не «нехватка данных», а инвариант
   *         нарушен (в норме FK + Restrict-onDelete не дают
   *         удалить шаблон с привязанными заказами); 404
   *         поднимется в action / контроллер.
   *     То есть try/catch на этом уровне НЕТ намеренно — ловить
   *     технические проблемы здесь нечем.
   *   - **идемпотентен**: повторный вызов без изменений шаблона
   *     ничего не пишет (`replaced=false`), журнал чист.
   *
   * Используется в `create` / `update` / `recalculateOperationPlan` /
   * `startCalculation`. После `start()` НЕ ВЫЗЫВАЕТСЯ —
   * upper-level `ORDER_LOCKED` guard в `update` и
   * `OrderOperationPlanRecalculateNotAllowedException` в
   * `recalculateOperationPlan` гарантируют immutability snapshot-а
   * после перевода заказа в производство (см. ADR-0006).
   *
   * Сам `start()` всё ещё содержит defensive `existing.count() === 0`
   * snapshot-вставку для legacy-заказов, которые были созданы до
   * этого изменения и приехали в production без OrderRouteStep[].
   */
  private async syncOrderRouteStepsSnapshot(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ steps: number; replaced: boolean }> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, routeTemplateId: true },
    });
    if (!order) {
      return { steps: 0, replaced: false };
    }

    const currentSteps = await tx.orderRouteStep.findMany({
      where: { orderId },
      orderBy: { index: 'asc' },
      select: {
        index: true,
        operationId: true,
        parallelGroup: true,
        rateOverride: true,
        timeNormSecOverride: true,
        pricingModeOverride: true,
        sizeOverrides: {
          select: { sizeId: true, rate: true, seconds: true },
        },
      },
    });

    if (!order.routeTemplateId) {
      if (currentSteps.length === 0) {
        return { steps: 0, replaced: false };
      }
      await tx.orderRouteStep.deleteMany({ where: { orderId } });
      return { steps: 0, replaced: true };
    }

    const desiredSteps = await this.routes.getActiveStepsForSnapshot(
      order.routeTemplateId,
    );

    // Сравниваем ТОЛЬКО структуру маршрута (набор операций, их порядок и
    // параллельные группы). Per-order оверрайды расценки/нормы
    // (`rateOverride` / `timeNormSecOverride` / `sizeOverrides`)
    // принадлежат заказу и НЕ зависят от расценок шаблона — поэтому
    // правка расценки в шаблоне маршрута не триггерит ре-синк и не
    // перетирает правки, сделанные внутри заказа («Редактировать
    // маршрут заказа»). См. ТЗ «суммы внутри заказа действуют только
    // внутри заказа».
    const structureEqual =
      desiredSteps.length === currentSteps.length &&
      desiredSteps.every((s, i) => {
        const cur = currentSteps[i];
        return (
          cur?.index === s.index &&
          cur?.operationId === s.operationId &&
          (cur?.parallelGroup ?? null) === (s.parallelGroup ?? null)
        );
      });

    if (structureEqual) {
      return { steps: desiredSteps.length, replaced: false };
    }

    // Структура изменилась — пересоздаём снимок, СОХРАНЯЯ per-order
    // оверрайды для операций, которые остаются в маршруте (ключ —
    // `operationId`, операция в маршруте не повторяется). Новые операции
    // получают сид расценки из шаблона (`RouteTemplateStep.rateOverride`);
    // норма времени и поразмерные оверрайды — только из правок заказа.
    const preserved = new Map(
      currentSteps.map((s) => [s.operationId, s] as const),
    );

    await tx.orderRouteStep.deleteMany({ where: { orderId } });
    for (const s of desiredSteps) {
      const carry = preserved.get(s.operationId);
      await tx.orderRouteStep.create({
        data: {
          orderId,
          index: s.index,
          operationId: s.operationId,
          parallelGroup: s.parallelGroup ?? null,
          rateOverride: carry ? carry.rateOverride : (s.rateOverride ?? null),
          timeNormSecOverride: carry?.timeNormSecOverride ?? null,
          pricingModeOverride: carry?.pricingModeOverride ?? null,
          sizeOverrides:
            carry && carry.sizeOverrides.length > 0
              ? {
                  create: carry.sizeOverrides.map((o) => ({
                    sizeId: o.sizeId,
                    rate: o.rate,
                    seconds: o.seconds,
                  })),
                }
              : undefined,
        },
      });
    }
    return { steps: desiredSteps.length, replaced: true };
  }

  // -------------------------------------------------------------------------
  // OPERATION PLAN — manual recalculate (Этап 2)
  // -------------------------------------------------------------------------

  /**
   * Этап 2 «План операций на заказе» — ручной пересчёт snapshot-полей
   * `Order.operationCostPlanRub` / `operationTimePlanSec` /
   * `operationPlanCalculatedAt` / `operationPlanWarnings`.
   *
   * Сценарий: после создания заказа менеджер изменил у операции
   * ставку / норму времени / поразмерные ставки / шаги маршрута, и
   * snapshot заказа стал «устаревшим» (см. `getFreshnessForOrder`).
   * Тут менеджер нажимает «Пересчитать план операций» и backend
   * перезаписывает snapshot из live-данных.
   *
   * Правила статусов (см. ТЗ §1):
   *   - `DRAFT` / `CALCULATION` — пересчёт разрешён; вызываем тот же
   *     `OrderOperationPlanService.recalculateAndWrite`, что использует
   *     `create` / `update` / `startCalculation`;
   *   - `CALCULATION_DONE` — запрещено: уже зафиксирован
   *     `OrderCostEstimate`. Просим вернуть заказ на пересчёт через
   *     `reopenCalculation` (отдельная кнопка в карточке);
   *   - `IN_PRODUCTION` / `DONE` / `CANCELLED` — запрещено: snapshot
   *     «как заказ ушёл в работу» намеренно зафиксирован (ADR-0006).
   *
   * Ошибка для всех запрещённых случаев:
   * `OrderOperationPlanRecalculateNotAllowedException` (409,
   * `ORDER_OPERATION_PLAN_RECALCULATE_NOT_ALLOWED`). UI рисует
   * адресные подсказки; для `CALCULATION_DONE` сообщение явно
   * предлагает «Чтобы пересчитать операции, верните заказ на просчёт».
   *
   * Аудит: пишем `ORDER_OPERATION_PLAN_RECALCULATED` с
   * previous/next-снимками — по журналу видно, было ли изменение и
   * кто его сделал.
   */
  async recalculateOperationPlan(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        operationCostPlanRub: true,
        operationTimePlanSec: true,
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }

    if (order.status === OrderStatus.CALCULATION_DONE) {
      throw new OrderOperationPlanRecalculateNotAllowedException(
        'Расчёт уже завершён. Чтобы пересчитать операции, верните заказ на просчёт.',
      );
    }
    if (
      order.status !== OrderStatus.DRAFT &&
      order.status !== OrderStatus.CALCULATION
    ) {
      throw new OrderOperationPlanRecalculateNotAllowedException(
        `Пересчёт плана операций разрешён только в статусах «Черновик» и «Расчёт» (текущий: ${order.status}).`,
      );
    }

    const previousCost = order.operationCostPlanRub
      ? order.operationCostPlanRub.toString()
      : null;
    const previousTimeSec = order.operationTimePlanSec ?? null;

    const result = await this.prisma.$transaction(async (tx) => {
      const r = await this.orderOperationPlan.recalculateAndWrite(id, tx);
      // Этап «План операций до запуска»: ручной пересчёт обязан
      // тащить за собой актуализацию snapshot-а шагов маршрута. Если
      // менеджер успел отредактировать шаги шаблона (admin /admin/routes),
      // вкладка «Операции» отрисует новый порядок без необходимости
      // дёргать update() заказа. Helper no-op, если ничего не изменилось.
      await this.syncOrderRouteStepsSnapshot(id, tx);
      await this.audit.log(
        {
          event: 'ORDER_OPERATION_PLAN_RECALCULATED',
          entityType: 'ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            previousCost,
            previousTimeSec,
            nextCost: r.totalCostRub ? r.totalCostRub.toString() : null,
            nextTimeSec: r.totalTimeSec ?? null,
            warningsCount: r.warnings.length,
          },
        },
        tx,
      );
      return r;
    });

    void result;
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // ROUTE OVERRIDES — per-order расценки/нормы (без правки справочника)
  // -------------------------------------------------------------------------

  /**
   * Правка расценок и норм времени операций **в рамках одного заказа**
   * (блок «Операции» → «Редактировать маршрут заказа» → «Сохранить
   * всё»). Источник истины — снимок `OrderRouteStep` заказа; справочник
   * операций (ставки и нормы, в т.ч. поразмерные) и шаблон маршрута НЕ
   * меняются — правки действуют только внутри заказа (см. ТЗ «суммы
   * внутри заказа не переписывают сумму внутри операции»).
   *
   * Семантика полей запроса:
   *   - `rateOverride` / `timeNormSecOverride` (FIXED-режимы): `undefined`
   *     — не трогать; `null` — снять переопределение (вернуться к дефолту
   *     операции); число — задать.
   *   - `sizeOverrides` (BY_SIZE-режимы): если массив передан, он —
   *     ПОЛНЫЙ набор поразмерных правок шага (replace-all): строки с
   *     `rate=null && seconds=null` удаляются, остальные — пересоздаются.
   *     `undefined` — поразмерные правки не трогаем.
   *
   * Разрешено во всех статусах, кроме `DONE` / `CANCELLED`. Плановый
   * snapshot (`Order.operationCostPlanRub` / `operationTimePlanSec`)
   * пересчитывается только в `DRAFT` / `CALCULATION` — после запуска он
   * заморожен по контракту (см. `OrderOperationPlanService`).
   */
  async updateRouteOverrides(
    id: string,
    dto: UpdateOrderRouteOverridesDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        items: { select: { sizeId: true } },
        routeSteps: {
          select: {
            id: true,
            operation: {
              select: { code: true, name: true, fixedRate: true },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (
      order.status === OrderStatus.DONE ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException({
        code: 'ORDER_ROUTE_OVERRIDES_NOT_ALLOWED',
        message:
          'Править расценки/нормы операций нельзя у завершённого или отменённого заказа.',
      });
    }

    const stepById = new Map(order.routeSteps.map((s) => [s.id, s] as const));
    const orderSizeIds = new Set(order.items.map((it) => it.sizeId));

    // Валидация до записи: каждый шаг принадлежит заказу, каждый размер —
    // из плана заказа (защита от чужих snapshot-ов и опечаток); при
    // переключении операции на сделку (`FIXED`) обязана быть расценка,
    // иначе payroll упадёт `OperationRateMissingException` на сканировании.
    for (const step of dto.steps) {
      const orderStep = stepById.get(step.stepId);
      if (!orderStep) {
        throw new BadRequestException({
          code: 'ORDER_ROUTE_STEP_NOT_FOUND',
          message: `Шаг маршрута ${step.stepId} не принадлежит заказу.`,
        });
      }
      for (const so of step.sizeOverrides ?? []) {
        if (!orderSizeIds.has(so.sizeId)) {
          throw new BadRequestException({
            code: 'ORDER_ROUTE_OVERRIDE_SIZE_INVALID',
            message: `Размер ${so.sizeId} не входит в план заказа.`,
          });
        }
      }
      if (step.pricingModeOverride === 'FIXED') {
        const hasRate =
          step.rateOverride != null || orderStep.operation.fixedRate != null;
        if (!hasRate) {
          const label =
            orderStep.operation.name || orderStep.operation.code;
          throw new BadRequestException({
            code: 'ORDER_ROUTE_OVERRIDE_RATE_REQUIRED',
            message: `Операция «${label}»: при переводе на сделку задайте расценку (₽/шт).`,
          });
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      for (const step of dto.steps) {
        const data: Prisma.OrderRouteStepUpdateInput = {};
        if (step.pricingModeOverride !== undefined) {
          data.pricingModeOverride = step.pricingModeOverride;
        }
        if (step.rateOverride !== undefined) {
          data.rateOverride = step.rateOverride;
        }
        if (step.timeNormSecOverride !== undefined) {
          data.timeNormSecOverride = step.timeNormSecOverride;
        }
        if (Object.keys(data).length > 0) {
          await tx.orderRouteStep.update({ where: { id: step.stepId }, data });
        }

        if (step.sizeOverrides !== undefined) {
          // Replace-all поразмерных правок шага: сносим прежние и
          // создаём только непустые (задан rate и/или seconds).
          await tx.orderRouteStepSizeOverride.deleteMany({
            where: { orderRouteStepId: step.stepId },
          });
          const rows = step.sizeOverrides.filter(
            (o) => o.rate != null || o.seconds != null,
          );
          if (rows.length > 0) {
            await tx.orderRouteStepSizeOverride.createMany({
              data: rows.map((o) => ({
                orderRouteStepId: step.stepId,
                sizeId: o.sizeId,
                rate: o.rate,
                seconds: o.seconds,
              })),
            });
          }
        }
      }

      // Плановый snapshot пересчитываем только пока заказ не запущен —
      // после старта план заморожен (см. `OrderOperationPlanService`).
      if (
        order.status === OrderStatus.DRAFT ||
        order.status === OrderStatus.CALCULATION
      ) {
        await this.orderOperationPlan.recalculateAndWrite(id, tx);
      }

      await this.audit.log(
        {
          event: 'ORDER_ROUTE_OVERRIDES_UPDATED',
          entityType: 'ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: { steps: dto.steps.length },
        },
        tx,
      );
    });

    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  /**
   * Редактирование заказа из admin-UI / API.
   *
   * Поля делятся на два класса (см. `UpdateOrderSchema`):
   *
   *   - «безопасные» (clientId, dueDate, orderDate, comment, customer,
   *     color, status) — допустимы на любом статусе. Их можно править,
   *     даже когда заказ уже в `IN_PRODUCTION` / `DONE` / `CANCELLED`,
   *     потому что они не затрагивают snapshot маршрута и состав
   *     `OrderItem[]`.
   *   - «потенциально опасные» (items, productId, routeTemplateId,
   *     techCardId, companyDivisionId) — допустимы только пока заказ
   *     в `DRAFT`. На не-DRAFT заказе их попытка изменить отдаёт 409
   *     `ORDER_LOCKED`. Это сохраняет инвариант ADR-0006 «после
   *     запуска план иммутабелен».
   *
   * Смена `status` обрабатывается отдельно после применения остальных
   * полей: это делегируется в существующие `start()/complete()/cancel()`,
   * чтобы не дублировать логику snapshot-ов и аудита запуска. Через
   * PATCH допустимы только безопасные переходы — остальные отдают
   * 409 `ORDER_INVALID_TRANSITION`.
   *
   * При фактическом изменении хотя бы одного поля (но НЕ только
   * статуса) пишется одна строка `ORDER_UPDATED` в `AuditLog` с
   * `before`/`after`/`changedFields` — это нужно, чтобы по журналу
   * можно было ответить на вопрос «кто и что поменял в заказе».
   * Аудит транзитивных переходов статуса не дублируется здесь — за
   * него отвечают `start/complete/cancel`.
   */
  async update(
    id: string,
    dto: UpdateOrderDto,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const current = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!current) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }

    // Какие поля «потенциально опасные» — их можно менять только
    // пока заказ DRAFT (см. JSDoc выше).
    const wantsItemsChange = dto.items !== undefined;
    const currentProductId = current.items[0]?.productId;
    const wantsProductChange =
      dto.productId !== undefined && dto.productId !== currentProductId;
    const wantsRouteChange = dto.routeTemplateId !== undefined;
    const wantsTechCardChange = dto.techCardId !== undefined;
    // Soft-pattern MVP (этап 2 «Лекала»): смена/сброс лекала тоже
    // считается «потенциально опасной» — после `start()` snapshot
    // полей лекала уже зафиксирован, и менять `patternItemId` нельзя
    // (см. ADR «soft snapshot pattern»). Считаем «хочет изменить»
    // только если значение действительно отличается от текущего —
    // повторная отправка того же id не должна срабатывать как
    // unsafe-change.
    const wantsPatternChange =
      dto.patternItemId !== undefined &&
      (dto.patternItemId ?? null) !== (current.patternItemId ?? null);
    // Смена FK подразделения через `companyDivisionId` —
    // «опасная» категория, поведение синхронизировано с прочими
    // план-полями. Считаем изменением только если значение
    // действительно отличается от текущего, чтобы повторная
    // отправка того же id не срабатывала как unsafe-change.
    const wantsCompanyDivisionChange =
      dto.companyDivisionId !== undefined &&
      (dto.companyDivisionId ?? null) !== (current.companyDivisionId ?? null);
    const wantsUnsafeChange =
      wantsItemsChange ||
      wantsProductChange ||
      wantsRouteChange ||
      wantsTechCardChange ||
      wantsPatternChange ||
      wantsCompanyDivisionChange;

    const isDraft = current.status === OrderStatus.DRAFT;

    if (wantsUnsafeChange && !isDraft) {
      // CALCULATION (этап «Расчёт»): план уже использован для
      // авторасчёта `WorkshopNeed`. Изменение состава / лекала /
      // техкарты сделало бы пересчитанные потребности
      // нерелевантными, поэтому блокируем теми же правилами, что для
      // IN_PRODUCTION. Менеджеру предлагается сначала вернуть заказ
      // в DRAFT (на MVP — через отмену расчёта вручную) либо
      // дополнительный action — выходит за рамки текущего этапа.
      throw new OrderLockedException(
        'Состав, изделие, маршрут, техкарту, лекало и подразделение можно менять только в статусе «Черновик».',
      );
    }

    // Валидация items (выполняется только когда поля действительно
    // меняются — т.е. заказ DRAFT). PRODUCT_REQUIRED-проверка
    // переехала ниже в транзакцию: после этапа «Номенклатура =
    // Лекала» источник productId может быть либо `dto.productId`,
    // либо derived legacy Product от смены `patternItemId`, либо
    // текущий `currentProductId`.

    if (dto.items) {
      const sizeIds = dto.items.map((i) => i.sizeId);
      if (new Set(sizeIds).size !== sizeIds.length) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'ORDER_DUPLICATE_SIZE',
          message: 'Размер не должен повторяться в одном заказе',
        });
      }
      const sizes = await this.prisma.size.findMany({ where: { id: { in: sizeIds } } });
      if (sizes.length !== new Set(sizeIds).size) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'SIZE_NOT_FOUND',
          message: 'Один из размеров не найден в справочнике',
        });
      }
    }

    if (dto.productId) {
      const p = await this.prisma.product.findUnique({ where: { id: dto.productId } });
      if (!p) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'PRODUCT_NOT_FOUND',
          message: 'Изделие не найдено',
        });
      }
    }

    // Soft-route MVP: смена/сброс шаблона маршрута допустимы только в
    // DRAFT (общий ORDER_LOCKED guard выше это гарантировал).
    //
    // Этап «План операций до запуска» (см. ТЗ): snapshot
    // `OrderRouteStep[]` теперь существует уже в DRAFT, поэтому
    // прежний `count > 0 → ORDER_ROUTE_ALREADY_STARTED` стал ложным
    // блокером — он бы запрещал смену маршрута сразу после первой
    // привязки. Защита от смены маршрута на запущенном заказе
    // полностью покрывается upper-level `ORDER_LOCKED` guard
    // (см. `wantsUnsafeChange && !isDraft`). Дополнительный
    // status-based safety net держим явно — на случай race с
    // параллельным `start()` (защищаемся `OrderStatus.DRAFT`-чекой
    // внутри той же tx ниже).
    if (dto.routeTemplateId !== undefined && dto.routeTemplateId !== null) {
      await this.assertRouteTemplateUsable(dto.routeTemplateId);
    }

    // Tech card MVP (ADR-0022): защита по уже зафиксированному
    // snapshot-у внешних подрядных требований. После этапа «Указать
    // в заказе» snapshot материалов (`OrderMaterialRequirement[]`)
    // создаётся уже в `create()` / `startCalculation()`, поэтому
    // его наличие — норма для DRAFT-заказа и тригером запрета НЕ
    // считается. Outsource-snapshot всё ещё фиксируется только в
    // `start()` (до этого его нет ни на DRAFT, ни на CALCULATION):
    // если он есть — заказ уже стартовал и `wantsUnsafeChange &&
    // !isDraft` выше отбил бы попытку изменить `techCardId` ещё до
    // нас. Доп. guard здесь — пояс поверх подтяжек.
    if (dto.techCardId !== undefined) {
      const outsCount = await this.prisma.orderOutsourceRequirement.count({
        where: { orderId: id },
      });
      if (outsCount > 0) {
        throw new OrderTechCardAlreadyStartedException();
      }
      if (dto.techCardId !== null) {
        await this.techCards.assertTechCardUsable(dto.techCardId);
      }
    }

    // Soft-pattern MVP (этап 2 «Лекала»): валидация выбранного лекала.
    // Защиту от смены после `start()` уже даёт общий ORDER_LOCKED guard
    // выше (и `wantsPatternChange`-проверка). Здесь только проверка
    // existence + status = ACTIVE для нового значения.
    if (dto.patternItemId !== undefined && dto.patternItemId !== null) {
      await this.assertPatternUsable(dto.patternItemId);
    }

    if (dto.clientId !== undefined && dto.clientId !== null) {
      await this.assertClientUsable(dto.clientId);
    }

    // Снимок «до» и список реально изменившихся полей — для аудита.
    // Считаем до открытия транзакции, чтобы не нагружать `tx`-callback
    // дополнительными запросами. Поля, которых в DTO нет, в diff не
    // попадают — иначе любой PATCH писал бы пустой ORDER_UPDATED.
    const changedFields: string[] = [];
    type AuditScalar = string | number | boolean | null;
    type AuditValue =
      | AuditScalar
      | { sizeId: string; qtyPlan: number }[];
    const beforeSnapshot: Record<string, AuditValue> = {};
    const afterSnapshot: Record<string, AuditValue> = {};

    function trackScalar<K extends string>(
      key: K,
      currentValue: AuditScalar | undefined,
      requestedValue: AuditScalar | undefined,
    ): void {
      if (requestedValue === undefined) return;
      if (currentValue === requestedValue) return;
      changedFields.push(key);
      beforeSnapshot[key] = currentValue ?? null;
      afterSnapshot[key] = requestedValue ?? null;
    }

    trackScalar('orderDate', current.orderDate.toISOString(), dto.orderDate);
    trackScalar(
      'dueDate',
      current.dueDate ? current.dueDate.toISOString() : null,
      dto.dueDate === undefined ? undefined : dto.dueDate ?? null,
    );
    trackScalar('clientId', current.clientId, dto.clientId);
    trackScalar('comment', current.comment, dto.comment);
    trackScalar('customer', current.customer, dto.customer);
    trackScalar('color', current.color, dto.color);
    trackScalar(
      'companyDivisionId',
      current.companyDivisionId,
      dto.companyDivisionId,
    );
    trackScalar(
      'finishedGoodsWarehouseId',
      current.finishedGoodsWarehouseId ?? null,
      dto.finishedGoodsWarehouseId === undefined
        ? undefined
        : dto.finishedGoodsWarehouseId ?? null,
    );
    // Упрощённый MVP давальческого сырья: трек-аудит политики учёта
    // материалов и фурнитуры. Резолвим в `update`-режиме —
    // `undefined`-passthrough означает «поле не пришло, не трогать».
    const policyForUpdate = resolveMaterialsAndHardwareCostPolicy(
      dto.materialsAndHardwareCostPolicy,
      'update',
    );
    trackScalar(
      'materialsAndHardwareCostPolicy',
      (current.materialsAndHardwareCostPolicy as string) ?? 'INCLUDE',
      policyForUpdate ?? undefined,
    );
    trackScalar('productId', currentProductId ?? null, dto.productId);
    trackScalar('routeTemplateId', current.routeTemplateId, dto.routeTemplateId);
    trackScalar('techCardId', current.techCardId, dto.techCardId);
    trackScalar('patternItemId', current.patternItemId, dto.patternItemId);
    if (dto.items) {
      const beforeItems = current.items
        .map((i) => ({ sizeId: i.sizeId, qtyPlan: i.qtyPlan }))
        .sort((a, b) => a.sizeId.localeCompare(b.sizeId));
      const afterItems = dto.items
        .map((i) => ({ sizeId: i.sizeId, qtyPlan: i.qtyPlan }))
        .sort((a, b) => a.sizeId.localeCompare(b.sizeId));
      if (JSON.stringify(beforeItems) !== JSON.stringify(afterItems)) {
        changedFields.push('items');
        beforeSnapshot.items = beforeItems;
        afterSnapshot.items = afterItems;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Этап «Цена продажи за единицу»: значение и валюта
      // нормализуются в общий helper (тот же, что в `create`).
      // `undefined` означает «поле не пришло» — Prisma не трогает
      // колонку. `null` — стирание.
      const customerPriceForPrisma:
        | Prisma.Decimal
        | null
        | undefined =
        dto.customerUnitPrice === undefined
          ? undefined
          : dto.customerUnitPrice === null
            ? null
            : new Prisma.Decimal(dto.customerUnitPrice);
      // Если PATCH передал цену > 0, но не передал валюту — на
      // уровне UI default RUB (тот же contract, что в `create`).
      // Это даёт UI «послать только цену» и получить дефолт.
      let customerCurrencyForPrisma: string | null | undefined =
        dto.customerCurrency === undefined
          ? undefined
          : dto.customerCurrency;
      if (
        dto.customerUnitPrice !== undefined &&
        dto.customerUnitPrice !== null &&
        Number(dto.customerUnitPrice) > 0 &&
        customerCurrencyForPrisma === undefined
      ) {
        customerCurrencyForPrisma = 'RUB';
      }

      const hasOrderUpdates =
        dto.customer !== undefined ||
        dto.orderDate !== undefined ||
        dto.dueDate !== undefined ||
        dto.color !== undefined ||
        dto.comment !== undefined ||
        dto.routeTemplateId !== undefined ||
        dto.techCardId !== undefined ||
        dto.patternItemId !== undefined ||
        dto.clientId !== undefined ||
        dto.companyDivisionId !== undefined ||
        dto.customerUnitPrice !== undefined ||
        dto.customerCurrency !== undefined ||
        dto.finishedGoodsWarehouseId !== undefined ||
        dto.materialsAndHardwareCostPolicy !== undefined;

      // Резолвим `companyDivisionId` только если он реально пришёл в
      // PATCH. `undefined` — Prisma колонку не трогает; явный `null`
      // обнуляет привязку; непустая строка валидируется helper-ом
      // (404-style 400 `COMPANY_DIVISION_NOT_FOUND` вместо FK-сбоя).
      const companyDivisionIdForPrisma: string | null | undefined =
        dto.companyDivisionId === undefined
          ? undefined
          : await this.resolveCompanyDivisionIdForOrder(
              tx,
              dto.companyDivisionId,
            );

      // Этап «Склад выпуска готовой продукции»: семантика та же —
      // `undefined` не трогает колонку, `null` сбрасывает,
      // непустая строка валидируется через resolver. Это
      // **управленческое** поле — меняется на любом статусе заказа,
      // никаких ORDER_LOCKED-ограничений.
      const finishedGoodsWarehouseIdForPrisma =
        await this.resolveFinishedGoodsWarehouseIdForOrder(
          tx,
          dto.finishedGoodsWarehouseId,
        );

      if (hasOrderUpdates) {
        await tx.order.update({
          where: { id },
          data: {
            customer:
              dto.customer === undefined ? undefined : dto.customer ?? null,
            orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
            dueDate:
              dto.dueDate === undefined
                ? undefined
                : dto.dueDate
                ? new Date(dto.dueDate)
                : null,
            color:
              dto.color === undefined
                ? undefined
                : normalizeColorOrNull(dto.color),
            comment:
              dto.comment === undefined ? undefined : dto.comment ?? null,
            routeTemplateId:
              dto.routeTemplateId === undefined
                ? undefined
                : dto.routeTemplateId,
            techCardId:
              dto.techCardId === undefined ? undefined : dto.techCardId,
            // Soft-pattern MVP (этап 2 «Лекала»): передаём undefined
            // если поля нет в DTO (Prisma не трогает колонку), либо
            // явное значение/null. Snapshot-поля при PATCH НЕ
            // сбрасываются — они остаются от прошлого `start()` и
            // могут показать «чем заказ ушёл в работу» даже если
            // сейчас live-привязка очищена.
            patternItemId:
              dto.patternItemId === undefined ? undefined : dto.patternItemId,
            clientId:
              dto.clientId === undefined ? undefined : dto.clientId,
            companyDivisionId: companyDivisionIdForPrisma,
            customerUnitPrice: customerPriceForPrisma,
            customerCurrency: customerCurrencyForPrisma,
            finishedGoodsWarehouseId: finishedGoodsWarehouseIdForPrisma,
            // Упрощённый MVP давальческого сырья: `undefined` — поле
            // не пришло, Prisma колонку не трогает; иначе пишем
            // нормализованное `INCLUDE` / `EXCLUDE`. Это
            // управленческая политика — меняется на любом статусе
            // заказа, никаких ORDER_LOCKED-ограничений.
            materialsAndHardwareCostPolicy: policyForUpdate,
          },
        });
      }

      // Этап «Номенклатура = Лекала»: если в DRAFT-заказе менеджер
      // меняет лекало на новое (не на null), пересчитываем legacy
      // `OrderItem.productId` по новому лекалу — иначе паспорта /
      // старый учёт продолжали бы ссылаться на старый
      // Product, не связанный с актуальным лекалом. Если меняется
      // на null (сброс лекала) — `OrderItem.productId` не трогаем,
      // оставляем последнюю legacy-привязку. Если параллельно
      // пришёл явный `dto.productId` — он не нужен, lекало главнее.
      let patternLegacyProductId: string | null = null;
      if (
        wantsPatternChange &&
        dto.patternItemId !== undefined &&
        dto.patternItemId !== null
      ) {
        patternLegacyProductId = await this.ensureLegacyProductForPattern(
          dto.patternItemId,
          tx,
        );
      }

      if (dto.items) {
        // Источник productId для новых строк: lекало главнее legacy
        // productId; если оба пришли — используем pattern-derived.
        const itemsProductId =
          patternLegacyProductId ??
          (dto.productId ?? currentProductId ?? undefined);
        if (!itemsProductId) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'PRODUCT_REQUIRED',
            message: 'Для заказа со строками обязателен productId',
          });
        }
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.createMany({
          data: dto.items.map((i) => ({
            orderId: id,
            productId: itemsProductId,
            sizeId: i.sizeId,
            qtyPlan: i.qtyPlan,
          })),
        });
      } else if (patternLegacyProductId) {
        // Состав не меняется, но pattern сменился — синхронизируем
        // `OrderItem.productId` на legacy Product выбранного лекала.
        await tx.orderItem.updateMany({
          where: { orderId: id },
          data: { productId: patternLegacyProductId },
        });
      } else if (
        dto.productId &&
        dto.productId !== currentProductId
      ) {
        await tx.orderItem.updateMany({
          where: { orderId: id },
          data: { productId: dto.productId },
        });
      }

      if (changedFields.length > 0) {
        // Аудит ORDER_UPDATED. Пишем ровно одну строку на PATCH с
        // полями, которые реально изменились. Статус-переходы сюда
        // НЕ попадают — за них отвечает start/complete/cancel ниже,
        // у каждого свой event (`ORDER_STARTED` и т.п.).
        // payload приводим через JSON-roundtrip к чистому
        // `Prisma.InputJsonValue`: наш `AuditValue` допускает `null`
        // (что валидно для JsonObject в БД), но строгий
        // `Prisma.InputJsonValue` `null` не пропускает. Side-effect-ов
        // нет — payload не содержит Date/cycles.
        await this.audit.log(
          {
            event: 'ORDER_UPDATED',
            entityType: 'ORDER',
            entityId: id,
            employeeId: actorEmployeeId ?? null,
            payload: JSON.parse(
              JSON.stringify({
                changedFields,
                before: beforeSnapshot,
                after: afterSnapshot,
              }),
            ) as Prisma.InputJsonValue,
          },
          tx,
        );
      }

      // Soft-pattern MVP (этап 2 «Лекала»): отдельная строка аудита
      // `ORDER_PATTERN_CHANGED` пишется, если менеджер реально сменил
      // или сбросил выбранное лекало. Дублирует общий ORDER_UPDATED
      // payload в точечном срезе «было лекало X → стало лекало Y» —
      // это упрощает выборку «история лекал по заказу» из журнала
      // без парсинга changedFields. Статус транзакции тот же
      // (либо обе строки записаны, либо ни одной).
      if (wantsPatternChange) {
        await this.audit.log(
          {
            event: 'ORDER_PATTERN_CHANGED',
            entityType: 'ORDER',
            entityId: id,
            employeeId: actorEmployeeId ?? null,
            payload: {
              previousPatternItemId: current.patternItemId,
              nextPatternItemId: dto.patternItemId ?? null,
            },
          },
          tx,
        );
      }

      // Этап 2 «План операций»: пересчитываем snapshot, если в DRAFT
      // изменились факторы, влияющие на план — состав (`items`),
      // маршрут (`routeTemplateId`) или лекало (`patternItemId` —
      // меняет legacy productId, формально на план не влияет, но
      // удобнее держать snapshot свежим вместе с ним; деньги/время
      // считаются по `Operation × size`, а не по продукту).
      //
      // Для не-DRAFT заказов план НЕ пересчитываем — общий
      // `ORDER_LOCKED` guard выше уже отбил «опасные» поля, а
      // безопасные (`color`, `comment`, `dueDate`, `customer`,
      // `customerUnitPrice`, …) на план не влияют. Это сохраняет
      // инвариант «после `start()` план зафиксирован».
      //
      // Этап «План операций до запуска»: тем же триггером
      // синхронизируем snapshot `OrderRouteStep[]` — менеджер должен
      // увидеть актуальный список операций сразу, а не после
      // запуска производства. Helper идемпотентен: если шаблон не
      // менялся (правка только items/pattern) — реального write нет.
      // Если шаблон сброшен на null — snapshot вычищается.
      if (
        isDraft &&
        (wantsItemsChange || wantsRouteChange || wantsPatternChange)
      ) {
        await this.orderOperationPlan.recalculateAndWrite(id, tx);
        await this.syncOrderRouteStepsSnapshot(id, tx);
      }

      // Этап «Указать в заказе» (см. ТЗ §2): пересборка snapshot
      // материалов заказа при правке тех-карты / состава / цвета
      // заказа.
      //
      // Триггеры (только пока snapshot ещё не «заморожен» — т.е. до
      // запуска производства):
      //   - DRAFT + смена `techCardId`/`items` — состав строк
      //     обновляется, totalQty пересчитывается;
      //   - DRAFT|CALCULATION + смена `color` (`Order.color`) —
      //     resolvedColorText по `colorRule = ORDER_COLOR` следует
      //     за новым цветом заказа; для `ORDER_SELECTED_COLOR`
      //     введённый менеджером `selectedColorText` сохраняется.
      //
      // На IN_PRODUCTION/DONE/CANCELLED snapshot НЕ пересобираем
      // (см. ADR-0006 «после запуска план иммутабелен»). Если
      // ничего не поменялось — пропускаем (нет смысла бить БД
      // delete+create).
      const wantsColorChange =
        dto.color !== undefined && (dto.color ?? null) !== (current.color ?? null);
      const shouldRebuildMaterials =
        (isDraft && (wantsItemsChange || wantsTechCardChange)) ||
        ((isDraft ||
          current.status === OrderStatus.CALCULATION ||
          current.status === OrderStatus.CALCULATION_DONE) &&
          wantsColorChange);
      if (shouldRebuildMaterials) {
        await this.rebuildMaterialRequirementsSnapshot(id, tx);
      }
    });

    // Безопасный переход статуса. Делегируем в существующие методы
    // (`start/complete/cancel/startCalculation`), чтобы не дублировать
    // логику snapshot-ов / автогенерации потребностей и аудита.
    // Любой переход, который существующие методы не поддерживают,
    // отбиваем единым ORDER_INVALID_TRANSITION.
    if (dto.status !== undefined && dto.status !== current.status) {
      const next = dto.status;
      if (
        current.status === OrderStatus.DRAFT &&
        next === OrderStatus.CALCULATION
      ) {
        await this.startCalculation(id, actorEmployeeId);
      } else if (
        (current.status === OrderStatus.DRAFT ||
          current.status === OrderStatus.CALCULATION ||
          current.status === OrderStatus.CALCULATION_DONE) &&
        next === OrderStatus.IN_PRODUCTION
      ) {
        await this.start(id, actorEmployeeId);
      } else if (
        current.status === OrderStatus.IN_PRODUCTION &&
        next === OrderStatus.DONE
      ) {
        await this.complete(id);
      } else if (
        (current.status === OrderStatus.DRAFT ||
          current.status === OrderStatus.CALCULATION ||
          current.status === OrderStatus.CALCULATION_DONE ||
          current.status === OrderStatus.IN_PRODUCTION) &&
        next === OrderStatus.CANCELLED
      ) {
        await this.cancel(id);
      } else {
        throw new OrderInvalidTransitionException(
          `Переход ${current.status} → ${next} не поддерживается через PATCH /orders/:id`,
        );
      }
    }

    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // TRANSITIONS
  // -------------------------------------------------------------------------

  async start(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    // Этап «Расчёт» / «Себестоимость заказа» — мягкий gate-keeper:
    // разрешаем стартовать из `DRAFT` (старый flow), `CALCULATION`
    // (расчёт начат, но себестоимость ещё не зафиксирована — мягкое
    // legacy-разрешение), `CALCULATION_DONE` (рекомендуемый new flow:
    // запускаем заказ только после явного «Завершить расчёт») и
    // `SAMPLE_PRODUCTION` (по заказу запущен сигнальный образец, теперь
    // запускаем весь тираж — см. `OrderSamplesService.start`).
    if (
      order.status !== OrderStatus.DRAFT &&
      order.status !== OrderStatus.CALCULATION &&
      order.status !== OrderStatus.CALCULATION_DONE &&
      order.status !== OrderStatus.SAMPLE_PRODUCTION
    ) {
      throw new OrderInvalidTransitionException(
        'В производство можно запустить только заказ в статусе DRAFT, «Расчёт», «Расчёт завершён» или «Производство сигнального образца»',
      );
    }
    if (order.items.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ORDER_HAS_NO_ITEMS',
        message: 'Нельзя запустить пустой заказ',
      });
    }

    // Этап «Конструкторское бюро»: запуск в производство требует
    // именно `ACTIVE`-pattern. `assertPatternUsable` сейчас разрешает
    // DRAFT при наличии активной `ConstructorTask` — это нужно для
    // того, чтобы менеджер мог собирать заказ-черновик вокруг
    // незавершённой задачи. Но `start()` — гейт качества: лекало
    // должно быть принято менеджером (через `acceptConstructorTaskAction`),
    // что переводит pattern в ACTIVE. Если pattern всё ещё DRAFT —
    // запуск запрещён.
    if (order.patternItemId) {
      const p = await this.prisma.patternItem.findUnique({
        where: { id: order.patternItemId },
        select: { status: true },
      });
      if (p && p.status !== 'ACTIVE') {
        throw new PatternInactiveException();
      }
    }

    // Soft-route MVP: snapshot маршрута фиксируется в момент запуска
    // заказа. Если шаблон не выбран — ничего не делаем (полная backward
    // compatibility со старым flow). Если выбран — копируем шаги в
    // `OrderRouteStep[]` с теми же `index`-ами, чтобы поздняя правка
    // шаблона не меняла уже запущенные заказы.
    //
    // Snapshot и смена статуса — в одной транзакции: либо заказ
    // запустился с маршрутом, либо без всего (целостность важнее
    // удобства). Шаблон без шагов — допустим: snapshot не пишется,
    // флаг `routeTemplateId` остаётся, никаких ошибок.
    //
    // Этап «План операций до запуска»: основной snapshot теперь
    // создаётся в `create` / `update` / `recalculateOperationPlan` /
    // `startCalculation` (см. `syncOrderRouteStepsSnapshot`). Этот
    // блок остаётся как **defensive fallback** для legacy-заказов,
    // которые были созданы до этого изменения и приехали в `start()`
    // без `OrderRouteStep[]`. Idempotent guard `existing === 0`
    // гарантирует, что мы не перепишем уже зафиксированный snapshot
    // (важно: на этой точке план считается immutable, ADR-0006).
    let snapshotSteps: {
      index: number;
      operationId: string;
      parallelGroup: number | null;
      rateOverride: Prisma.Decimal | null;
    }[] = [];
    if (order.routeTemplateId) {
      snapshotSteps = await this.routes.getActiveStepsForSnapshot(
        order.routeTemplateId,
      );
    }

    // Tech card MVP (ADR-0022): фиксируем snapshot строк техкарты в
    // той же транзакции, что смена статуса. baseQty = Σ qtyPlan по
    // OrderItem. Никаких формул/коэффициентов: totalQty = qtyPerUnit *
    // baseQty (см. `docs/domain.md §«Техкарты»`).
    const baseQty = order.items.reduce((s, it) => s + it.qtyPlan, 0);
    let techCardLines: Awaited<
      ReturnType<TechCardsService['getLinesForSnapshot']>
    > | null = null;
    if (order.techCardId) {
      techCardLines = await this.techCards.getLinesForSnapshot(
        order.techCardId,
      );
    }

    // Soft-pattern MVP (этап 2 «Лекала»): загружаем карточку лекала
    // заранее (за пределами транзакции), чтобы не делать сетевой
    // запрос внутри tx. Если у заказа лекало не выбрано — НЕ
    // блокируем запуск, snapshot-поля остаются null. Если карточка
    // лекала между selectStart() и start() была удалена/обнулена —
    // тоже не блокируем, просто snapshot = null (поведение «лекала
    // не зафиксировали»).
    const patternForSnapshot = order.patternItemId
      ? await this.prisma.patternItem.findUnique({
          where: { id: order.patternItemId },
          select: { id: true, name: true, article: true, previewImageUrl: true },
        })
      : null;

    // Snapshot пишем ТОЛЬКО если у заказа его ещё нет (см.
    // `docs/recon-soft-integration.md §«Snapshot at calculation»`).
    // Раньше `start()` всегда перезаписывал snapshot текущим именем
    // карточки лекала, и заказ, у которого snapshot был зафиксирован
    // на этапе расчёта, после запуска в производство получал новое
    // имя — это противоречит идее «лекало по которому заказ ушёл в
    // работу». Сравниваем по `patternNameSnapshot` (все три поля
    // пишутся вместе либо не пишутся вовсе) и оставляем undefined,
    // если уже зафиксирован, — Prisma не трогает колонку.
    const captureSnapshot =
      patternForSnapshot !== null && !order.patternNameSnapshot;

    // Кабинет раскройщика (роль CUTTER, см. `model CuttingTask`): запуск
    // заказа в производство создаёт задачу на раскрой. Таблица-задание
    // строится по размерам, поэтому агрегируем план по размеру
    // (Σ `OrderItem.qtyPlan` по всем продуктам заказа) и подтягиваем
    // коды/порядок размеров вне транзакции. Саму задачу создаём внутри
    // tx (idempotent-guard по `orderId`).
    const cuttingQtyBySizeId = new Map<string, number>();
    for (const it of order.items) {
      cuttingQtyBySizeId.set(
        it.sizeId,
        (cuttingQtyBySizeId.get(it.sizeId) ?? 0) + it.qtyPlan,
      );
    }
    const cuttingSizes = await this.prisma.size.findMany({
      where: { id: { in: [...cuttingQtyBySizeId.keys()] } },
      select: { id: true, code: true, sortOrder: true },
    });
    cuttingSizes.sort((a, b) => a.sortOrder - b.sortOrder);

    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.IN_PRODUCTION,
          // Этап «Ввод в производство»: фиксируем момент запуска один
          // раз, в той же транзакции, что и смена статуса. Колонка
          // nullable и до этого момента всегда null, так что перезаписи
          // не происходит.
          inProductionAt: new Date(),
          // Soft-pattern MVP (этап 2 «Лекала»): фиксируем snapshot в
          // той же транзакции, что смена статуса, если ещё не
          // зафиксирован. `undefined` в Prisma update не трогает
          // колонку — это корректный no-op.
          patternNameSnapshot: captureSnapshot
            ? patternForSnapshot!.name
            : undefined,
          patternArticleSnapshot: captureSnapshot
            ? patternForSnapshot!.article
            : undefined,
          patternPreviewSnapshotUrl: captureSnapshot
            ? patternForSnapshot!.previewImageUrl ?? null
            : undefined,
        },
      });

      // Задача на раскрой (кабинет раскройщика). Idempotent-guard: если
      // по какой-то причине задача уже есть (ручной transition / повтор),
      // не дублируем. `perLayerQty` остаётся 0 — его заполнит раскройщик.
      const existingCutting = await tx.cuttingTask.count({
        where: { orderId: id },
      });
      if (existingCutting === 0 && cuttingSizes.length > 0) {
        await tx.cuttingTask.create({
          data: {
            orderId: id,
            status: 'NEW',
            sizeRows: {
              createMany: {
                data: cuttingSizes.map((s, idx) => ({
                  sortOrder: (idx + 1) * 10,
                  sizeId: s.id,
                  sizeCodeSnapshot: s.code,
                  qtyPlan: cuttingQtyBySizeId.get(s.id) ?? 0,
                })),
              },
            },
          },
        });
      }

      if (snapshotSteps.length > 0) {
        // Защита от двойного snapshot-а: если по какой-то причине
        // OrderRouteStep уже есть (ручной transition / админ-патч в
        // будущем), не дублируем.
        const existing = await tx.orderRouteStep.count({
          where: { orderId: id },
        });
        if (existing === 0) {
          await tx.orderRouteStep.createMany({
            data: snapshotSteps.map((s) => ({
              orderId: id,
              index: s.index,
              operationId: s.operationId,
              parallelGroup: s.parallelGroup ?? null,
              rateOverride: s.rateOverride ?? null,
            })),
          });
        }
      }

      if (techCardLines) {
        const baseDecimal = new Prisma.Decimal(baseQty);
        // Аналогичный idempotent-guard, как у route snapshot.
        const existingMat = await tx.orderMaterialRequirement.count({
          where: { orderId: id },
        });
        if (existingMat === 0 && techCardLines.materialLines.length > 0) {
          await tx.orderMaterialRequirement.createMany({
            data: techCardLines.materialLines.map((l) => ({
              orderId: id,
              sourceTechCardLineId: l.id,
              sortOrder: l.sortOrder,
              name: l.name,
              unit: l.unit,
              qtyPerUnit: l.qtyPerUnit,
              totalQty: l.qtyPerUnit.mul(baseDecimal),
              note: l.note,
              // Этап 3 «Потребности цеха» (см.
              // `docs/recon-soft-integration.md §«Этап 3»`):
              // snapshot новых полей строки техкарты + derived
              // `resolvedColorText` по `colorRule`. Если поля не
              // заполнены в техкарте — в snapshot ляжет `null`,
              // старт заказа НЕ блокируем (этап 3, backward-compat).
              materialRole: l.materialRole,
              fabricType: l.fabricType,
              densityGsm: l.densityGsm,
              plannedWidthCm: l.plannedWidthCm,
              colorRule: l.colorRule,
              fixedColorText: l.fixedColorText,
              resolvedColorText: resolveColorText(
                l.colorRule,
                l.fixedColorText,
                order.color,
              ),
              // Этап «Указать в заказе» (см. ТЗ §4): если правило
              // `ORDER_SELECTED_COLOR`, фиксируем флаг в snapshot.
              // Цвет по позиции менеджер позже введёт через action,
              // и `resolvedColorText` синхронизируется с
              // `selectedColorText` (см.
              // `OrdersService.updateMaterialRequirementColor`).
              requiresColorSelection: l.colorRule === 'ORDER_SELECTED_COLOR',
              selectedColorText: null,
              // Этап «Фурнитура / изображение материала»: snapshot-
              // копии. Для роли != PACKAGING сервис техкарты уже
              // зачистил hardware* в null, здесь просто переносим.
              hardwareSizeText: l.hardwareSizeText,
              hardwareMaterialText: l.hardwareMaterialText,
              materialImageUrl: l.materialImageUrl,
              materialImageOriginalFileName: l.materialImageOriginalFileName,
              // Фаза 2 «Характеристики номенклатуры»: snapshot подтипа
              // и значений характеристик.
              subtypeKey: l.subtypeKey,
              characteristics: l.characteristics ?? Prisma.DbNull,
            })),
          });
        }
        const existingOuts = await tx.orderOutsourceRequirement.count({
          where: { orderId: id },
        });
        if (existingOuts === 0 && techCardLines.outsourceLines.length > 0) {
          await tx.orderOutsourceRequirement.createMany({
            data: techCardLines.outsourceLines.map((l) => ({
              orderId: id,
              sourceTechCardLineId: l.id,
              sortOrder: l.sortOrder,
              name: l.name,
              unit: l.unit,
              qtyPerUnit: l.qtyPerUnit,
              totalQty:
                l.qtyPerUnit == null ? null : l.qtyPerUnit.mul(baseDecimal),
              vendorName: l.vendorName,
              note: l.note,
              // MVP-2 (ADR-0022 §«Cut-ready readiness»): копируем
              // триггер активации в snapshot. Дальше read-only derive
              // в `getOne()` по `Passport.currentCellId`.
              triggerType: l.triggerType,
              // MVP-3 (ADR-0022 §«Manual execution status»): дефолтный
              // ручной статус — `PLANNED`. Колонка имеет default в
              // схеме; передаём явно, чтобы snapshot был самодостаточен
              // и не зависел от server-side default-логики.
              executionStatus: OrderOutsourceExecutionStatus.PLANNED,
              orderedAt: null,
              receivedAt: null,
            })),
          });
        }
      }
      // Audit (см. `docs/domain.md §«Audit log»`): запуск заказа в
      // производство — момент фиксации snapshot-ов маршрута и
      // техкарты. payload фиксирует и факт перехода DRAFT → IN_PRODUCTION,
      // и счётчики snapshot-ов, чтобы по журналу можно было ответить
      // на вопрос «почему у запущенного заказа нет техкартовых
      // строк» без сравнения двух баз.
      await this.audit.log(
        {
          event: 'ORDER_STARTED',
          entityType: 'ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            // Этап «Расчёт»: source-статус теперь либо DRAFT
            // (старый flow), либо CALCULATION (новый flow). Пишем
            // фактический исходный статус, чтобы по журналу было
            // видно, прошёл ли заказ авторасчёт перед запуском.
            fromStatus: order.status,
            toStatus: OrderStatus.IN_PRODUCTION,
            routeTemplateId: order.routeTemplateId,
            routeStepCount: snapshotSteps.length,
            techCardId: order.techCardId,
            techCardMaterialLineCount:
              techCardLines?.materialLines.length ?? 0,
            techCardOutsourceLineCount:
              techCardLines?.outsourceLines.length ?? 0,
            baseQty,
            // Soft-pattern MVP (этап 2 «Лекала»): фиксируем factual
            // привязку к лекалу + флаг snapshot-фиксации, чтобы по
            // журналу было ясно, был ли pattern на момент запуска и
            // зафиксирован ли его snapshot. Отдельное событие
            // ORDER_PATTERN_SNAPSHOT_CREATED ниже даёт точечный срез
            // именно по содержимому snapshot-а.
            patternItemId: order.patternItemId,
            // На этапе «Расчёт» добавили snapshot-on-calculation, и
            // теперь у заказа в `start()` snapshot мог уже быть.
            // `patternSnapshotCaptured = true` пишем ТОЛЬКО если
            // snapshot зафиксирован именно в этой `start()`-транзакции
            // (`captureSnapshot`). Иначе по журналу было бы непонятно,
            // на каком переходе snapshot реально лёг.
            patternSnapshotCaptured: captureSnapshot,
            // Дополнительный флаг «снимок уже был» помогает по
            // журналу отделить два сценария: «start с пустым
            // snapshot’ом → залит сейчас» и «start от заказа с
            // ранее зафиксированным snapshot’ом → ничего не
            // перезаписывали».
            patternSnapshotPreserved:
              !captureSnapshot && Boolean(order.patternNameSnapshot),
          },
        },
        tx,
      );

      // Soft-pattern MVP (этап 2 «Лекала»): отдельная строка аудита
      // с самим snapshot-ом полей лекала. Пишется только если
      // snapshot реально зафиксирован В ЭТОЙ транзакции (у заказа
      // не было snapshot’а до сих пор). Если snapshot пришёл с
      // этапа `startCalculation` — мы его не перезаписали и аудит
      // не дублируем (соответствующая запись уже есть со стороны
      // `startCalculation`). По стилю — аналог `ORDER_PATTERN_CHANGED`
      // (см. `update`-ветку).
      if (captureSnapshot) {
        await this.audit.log(
          {
            event: 'ORDER_PATTERN_SNAPSHOT_CREATED',
            entityType: 'ORDER',
            entityId: id,
            employeeId: actorEmployeeId ?? null,
            payload: {
              patternItemId: patternForSnapshot!.id,
              patternNameSnapshot: patternForSnapshot!.name,
              patternArticleSnapshot: patternForSnapshot!.article,
              patternPreviewSnapshotUrl:
                patternForSnapshot!.previewImageUrl ?? null,
              capturedAt: 'IN_PRODUCTION',
            },
          },
          tx,
        );
      }
    });

    return this.getOne(id);
  }

  /**
   * Этап «Расчёт» — перевод заказа из `DRAFT` в `CALCULATION`.
   *
   * Что происходит:
   *   1. Загружаем заказ + проверяем все требования к расчёту:
   *      - status = `DRAFT` (иначе `ORDER_INVALID_STATUS_TRANSITION`);
   *      - есть `patternItemId` (иначе `ORDER_PATTERN_REQUIRED`);
   *      - есть `techCardId`   (иначе `ORDER_TECH_CARD_REQUIRED`);
   *      - есть хотя бы один `OrderItem` с `qtyPlan > 0`
   *        (иначе `ORDER_ITEMS_REQUIRED`).
   *      Маршрут (routeTemplateId) сознательно НЕ требуется — он не
   *      влияет на расчёт `WorkshopNeed`.
   *   2. Вызываем `WorkshopNeedsService.calculateForOrder(orderId,
   *      { force: false })`. Если у заказа уже есть REVIEWED /
   *      PURCHASE_PLANNED строки (например, от ручного calculate в
   *      DRAFT), сервис сам отдаст `WORKSHOP_NEEDS_ALREADY_REVIEWED`
   *      — мы это пробрасываем без mute, чтобы UI попросил очистить
   *      их вручную либо force-пересчёт.
   *   3. Обновляем `Order.status = CALCULATION` + пишем
   *      `ORDER_CALCULATION_STARTED` в одной транзакции аудита.
   *
   * Порядок «сначала calculate, потом status update» выбран
   * сознательно: если step 2 упал — заказ остаётся `DRAFT`, нет
   * полупустого «расчётного» состояния. Если step 3 упал — потребности
   * уже созданы, повторный вызов спокойно их пересчитает (force=false
   * сносит только CALCULATED-строки).
   *
   * Этот метод вызывается:
   *   - напрямую `OrdersController.startCalculation`
   *     (`POST /api/orders/:id/start-calculation`);
   *   - из `OrdersService.update`, если менеджер передал
   *     `status = CALCULATION` через PATCH /api/orders/:id (тот же
   *     паттерн делегирования, что у `start/complete/cancel`).
   */
  async startCalculation(
    id: string,
    actorEmployeeId?: string | null,
  ): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.DRAFT) {
      throw new OrderInvalidStatusTransitionException(
        `Перевести в расчёт можно только заказ в статусе «Черновик» (текущий: ${order.status}).`,
      );
    }
    if (!order.patternItemId) {
      throw new OrderPatternRequiredException();
    }
    // Сознательно НЕ блокируем переход в расчёт на DRAFT-pattern с
    // активной ConstructorTask: расчёт — управленческий этап
    // («посчитать потребности, прикинуть себестоимость»), он не
    // требует, чтобы лекало было «принято». Гейт качества стоит
    // позже — в `start()` (запуск в производство), где pattern
    // ОБЯЗАН быть ACTIVE. Если лекало изменится после accept от
    // конструктора, менеджер пересчитает расчёт через `recalculate-plan`.
    if (!order.techCardId) {
      throw new OrderTechCardRequiredException();
    }
    const totalQty = order.items.reduce((s, it) => s + it.qtyPlan, 0);
    if (order.items.length === 0 || totalQty <= 0) {
      throw new OrderItemsRequiredException();
    }

    // Этап «Указать в заказе» (см. ТЗ §2): перед автоматическим
    // расчётом потребности гарантированно пересобираем snapshot
    // `OrderMaterialRequirement[]` из live-строк техкарты. Это
    // гарантия для существующих заказов без snapshot (созданных
    // до этой фичи), что после `start-calculation` UI карточки
    // увидит строки с `requiresColorSelection = true` и поле
    // «Цвет нужно указать в заказе». Уже введённый менеджером
    // `selectedColorText` сохраняется (см. preserve-логику в
    // `rebuildMaterialRequirementsSnapshot`).
    //
    // Рестроим snapshot ПЕРЕД `calculateForOrder`, чтобы расчёт
    // использовал актуальный snapshot (а не stale-row/`live`-техкарту).
    await this.prisma.$transaction(async (tx) => {
      await this.rebuildMaterialRequirementsSnapshot(id, tx);
    });

    // Сначала считаем потребности. force=false: если уже есть
    // REVIEWED/PURCHASE_PLANNED строки (что в DRAFT возможно только
    // через ручной calculate-эндпоинт), сервис сам отдаст
    // `WORKSHOP_NEEDS_ALREADY_REVIEWED`. Мы пробрасываем это, чтобы
    // менеджер не перетёр чужие правки.
    const calc = await this.workshopNeeds.calculateForOrder(
      id,
      { force: false },
      actorEmployeeId ?? null,
    );

    // Soft-pattern «снимок номенклатуры на расчёте» (см.
    // `docs/recon-soft-integration.md §«Snapshot at calculation»`):
    // на этапе перевода DRAFT → CALCULATION мы фиксируем имя/артикул/
    // превью лекала прямо на заказе, чтобы UI карточки заказа
    // показывал то, по чему заказ ушёл в расчёт, а не live-имя
    // карточки лекала. До этого изменения snapshot создавался только
    // в `start()` (запуск в производство), и заказ в CALCULATION,
    // у которого после старта расчёта переименовали PatternItem,
    // показывал в превью одно имя, а в блоке «Изделие» — старое
    // legacy `productName`.
    //
    // Загружаем PatternItem ДО открытия транзакции — request-а
    // внутри tx не нужно, snapshot выше — точечный COPY-IN. На
    // момент `startCalculation` `patternItemId` обязан быть (иначе
    // мы бы упали раньше на ORDER_PATTERN_REQUIRED), но
    // дополнительно защищаемся `null`-проверкой: race с удалением
    // карточки лекала между двумя read-ами не блокирует расчёт —
    // snapshot просто не пишется.
    const patternForSnapshot = order.patternItemId
      ? await this.prisma.patternItem.findUnique({
          where: { id: order.patternItemId },
          select: { id: true, name: true, article: true, previewImageUrl: true },
        })
      : null;

    // Затем меняем статус + (опц.) snapshot + аудит, в одной транзакции.
    await this.prisma.$transaction(async (tx) => {
      // Этап 2 «План операций на заказе»: финальный snapshot перед
      // переводом в CALCULATION. После этого момента состав / маршрут
      // через PATCH меняться уже не могут (общий ORDER_LOCKED guard
      // в `update`), а наш snapshot становится «как заказ ушёл в
      // расчёт». Делаем ДО смены статуса, чтобы CALCULATION-заказ
      // никогда не оказался без snapshot-а в той же tx (целостность).
      await this.orderOperationPlan.recalculateAndWrite(id, tx);
      // Этап «План операций до запуска»: финальная sync snapshot-а
      // шагов маршрута. До этого изменения список операций
      // материализовался только в `start()`, поэтому в CALCULATION
      // вкладка «Операции» оставалась пустой. Helper идемпотентен:
      // если snapshot уже был зафиксирован в DRAFT и шаблон не менялся
      // — реального write нет.
      await this.syncOrderRouteStepsSnapshot(id, tx);

      await tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.CALCULATION,
          // Snapshot пишем ТОЛЬКО если ещё пуст. Это и
          // идемпотентность для `startCalculation`, и защита от
          // потенциальных пере-вызовов в будущем (`force-recalculate`
          // и т.п.). Сравнение по `name` достаточно — все три
          // snapshot-поля заполняются вместе, либо не заполняются
          // вовсе (см. `start()`).
          patternNameSnapshot:
            patternForSnapshot && !order.patternNameSnapshot
              ? patternForSnapshot.name
              : undefined,
          patternArticleSnapshot:
            patternForSnapshot && !order.patternNameSnapshot
              ? patternForSnapshot.article
              : undefined,
          patternPreviewSnapshotUrl:
            patternForSnapshot && !order.patternNameSnapshot
              ? patternForSnapshot.previewImageUrl ?? null
              : undefined,
        },
      });
      await this.audit.log(
        {
          event: 'ORDER_CALCULATION_STARTED',
          entityType: 'ORDER',
          entityId: id,
          employeeId: actorEmployeeId ?? null,
          payload: {
            orderId: id,
            previousStatus: OrderStatus.DRAFT,
            nextStatus: OrderStatus.CALCULATION,
            workshopNeedsCount: calc.count,
            methods: calc.methods,
            warningsCount: calc.warnings.length,
            patternItemId: order.patternItemId,
            patternSnapshotCaptured:
              patternForSnapshot !== null && !order.patternNameSnapshot,
          },
        },
        tx,
      );

      // Отдельная строка `ORDER_PATTERN_SNAPSHOT_CREATED` пишется,
      // только если snapshot реально зафиксирован сейчас (заказ
      // дошёл до расчёта без существующего snapshot-а и карточка
      // лекала ещё существовала). По стилю — как в `start()`,
      // чтобы аудит был единообразный.
      if (patternForSnapshot && !order.patternNameSnapshot) {
        await this.audit.log(
          {
            event: 'ORDER_PATTERN_SNAPSHOT_CREATED',
            entityType: 'ORDER',
            entityId: id,
            employeeId: actorEmployeeId ?? null,
            payload: {
              patternItemId: patternForSnapshot.id,
              patternNameSnapshot: patternForSnapshot.name,
              patternArticleSnapshot: patternForSnapshot.article,
              patternPreviewSnapshotUrl:
                patternForSnapshot.previewImageUrl ?? null,
              capturedAt: 'CALCULATION',
            },
          },
          tx,
        );
      }
    });

    return this.getOne(id);
  }

  async complete(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (order.status !== OrderStatus.IN_PRODUCTION) {
      throw new OrderInvalidTransitionException(
        'Завершить можно только заказ в статусе IN_PRODUCTION',
      );
    }
    await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.DONE },
    });
    return this.getOne(id);
  }

  async cancel(id: string): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Заказ не найден' });
    }
    if (order.status === OrderStatus.DONE || order.status === OrderStatus.CANCELLED) {
      throw new OrderInvalidTransitionException(
        'Заказ уже завершён или отменён',
      );
    }
    // Этап «Себестоимость заказа»: cancel разрешён из любого
    // активного статуса (DRAFT/CALCULATION/CALCULATION_DONE/IN_PRODUCTION).
    // Snapshot-поля себестоимости НЕ очищаем — `OrderCostEstimate` и
    // его snapshot остаются как историческое состояние «как заказ
    // был отменён». Это согласуется с правилом «не теряем историю».
    await this.prisma.order.update({
      where: { id },
      data: { status: OrderStatus.CANCELLED },
    });
    return this.getOne(id);
  }

  /**
   * Hard-delete заказа (этап «Удалить архивную запись навсегда»).
   *
   * Политика «блокировать, если используется» (см.
   * `OrderDeleteForbiddenException`):
   *   1) удалять можно ТОЛЬКО отменённый заказ (`status = CANCELLED`) —
   *      отмена и есть soft-архив заказа;
   *   2) блокируем, если по заказу уже есть производственные артефакты,
   *      которые мы НЕ хотим терять: паспорта (`Passport`) или запросы
   *      закрытия кроя (`CuttingClosureRequest`). Оба FK — `RESTRICT`,
   *      т.е. БД и так не дала бы удалить, но мы отбиваем заранее с
   *      понятным текстом и количеством.
   *
   * Если проверки пройдены — заказ «пустой» (план без производства).
   * `OrderItem` — тоже `RESTRICT`-связь, но это структурная часть
   * заказа (не история), поэтому сносим её явно в транзакции, а затем
   * `order.delete()` каскадом убирает CASCADE-детей (route steps,
   * requirements, cut-rules, logistics, cost estimate, sample) и
   * `SET NULL`-ит ссылки `PurchaseOrder/PurchaseReceipt.customerOrderId`.
   */
  async remove(id: string, actorEmployeeId?: string | null): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id },
      select: { id: true, number: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Заказ не найден',
      });
    }
    if (order.status !== OrderStatus.CANCELLED) {
      throw new OrderDeleteForbiddenException(
        'Удалить навсегда можно только отменённый заказ. Как удалить: сначала нажмите «Отменить» вверху карточки заказа, затем кнопку «Удалить навсегда».',
      );
    }

    const [passportCount, cutClosureCount] = await Promise.all([
      this.prisma.passport.count({ where: { orderId: id } }),
      this.prisma.cuttingClosureRequest.count({ where: { orderId: id } }),
    ]);
    if (passportCount > 0 || cutClosureCount > 0) {
      const parts: string[] = [];
      if (passportCount > 0) parts.push(`выпущено паспортов: ${passportCount}`);
      if (cutClosureCount > 0)
        parts.push(`запросов закрытия кроя: ${cutClosureCount}`);
      throw new OrderDeleteForbiddenException(
        `Этот заказ удалить навсегда нельзя: по нему уже шло производство (${parts.join(
          ', ',
        )}). Производственную историю стирать нельзя — отменённый заказ остаётся в архиве как запись о том, что было. Навсегда удаляются только отменённые заказы, по которым не выпустили ни одного паспорта.`,
      );
    }

    try {
      await this.prisma.$transaction([
        this.prisma.orderItem.deleteMany({ where: { orderId: id } }),
        this.prisma.order.delete({ where: { id } }),
      ]);
    } catch (e) {
      // P2003 — FK-ограничение (RESTRICT) на каком-то ещё не учтённом
      // потомке. Транзакция атомарна (ничего не удалилось), отдаём
      // понятную 409 вместо 500.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2003'
      ) {
        throw new OrderDeleteForbiddenException(
          'Этот заказ удалить навсегда нельзя: на него ещё ссылаются связанные производственные записи. Их стирать нельзя — заказ остаётся в архиве как история.',
        );
      }
      throw e;
    }

    await this.audit.log({
      event: 'ORDER_DELETED',
      entityType: 'ORDER',
      entityId: id,
      payload: { number: order.number, previousStatus: order.status },
      employeeId: actorEmployeeId ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // MAPPERS
  // -------------------------------------------------------------------------

  private async toDetailDto(
    order: OrderWithItems,
    product: ProductLite | null,
    color: string | null,
  ): Promise<OrderDetailDto> {
    // Догружаем справочник размеров для breakdown.
    // Читаем все размеры заказа одним запросом.
    const sizeIds = order.items.map((i) => i.sizeId);
    const sizes = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
    });

    // Этап «Себестоимость заказа»: подгружаем активный
    // `OrderCostEstimate` (status = COMPLETED). Для DRAFT/CALCULATION
    // и для заказов после reopen вернётся `null` — UI рисует «нет
    // зафиксированной себестоимости».
    const currentCostEstimate =
      await this.costEstimates.getActiveEstimateForOrder(order.id);

    // Этап 2 «План операций на заказе» — stale-detection (см.
    // `OrderOperationPlanService.getFreshnessForOrder`). Это
    // **computed** срез: ничего не пишем в БД, только сравниваем
    // updatedAt-источников плана со snapshot-датой заказа. На детали
    // заказа считаем всегда; в `toListItemDto` сознательно НЕ
    // запрашиваем (тяжёлые aggregate-ы для каждого ряда списка
    // заказов).
    const freshness = await this.orderOperationPlan.getFreshnessForOrder(
      order.id,
    );

    const { summary, sizeBreakdown } = aggregateOrder({
      items: order.items,
      sizes,
      passports: order.passports,
    });

    const qtyPlanTotal = summary.qtyPlanTotal;

    // MVP-2 (ADR-0022 §«Cut-ready readiness»): главный сигнал «крой
    // готов» — у заказа есть паспорта, и у каждого паспорта проставлено
    // `currentCellId`. Никаких событийных проекций (`CELL_PLACED`),
    // никаких новых статусов в БД: `Passport.currentCellId` уже и так
    // источник истины для размещения (см. ADR-0010, `docs/domain.md
    // §«Размещение паспорта»`).
    const isCutReadyForOrder =
      order.passports.length > 0 &&
      order.passports.every((p) => p.currentCellId !== null);

    // «Контроль срока» на детали считается из той же формулы, что и на
    // списке (`toListItemDto`): один общий helper `evaluateDeadlineForDto`,
    // одни и те же входные данные (`status` + `dueDate` + `qtyPlanTotal`
    // + `qtyFinishedTotal` из `aggregateOrder`). Это гарантирует, что
    // бейдж/процент в списке и в карточке заказа НЕ разъедутся.
    const qtyFinishedTotal = summary.qtyFinishedTotal;
    const deadline = evaluateDeadlineForDto({
      status: order.status,
      dueDate: order.dueDate,
      qtyPlan: qtyPlanTotal,
      qtyFinished: qtyFinishedTotal,
    });

    return {
      id: order.id,
      number: order.number,
      orderDate: order.orderDate.toISOString(),
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      inProductionAt: order.inProductionAt
        ? order.inProductionAt.toISOString()
        : null,
      status: order.status,
      productId: product?.id ?? null,
      productName: product?.name ?? null,
      color: color ?? product?.color ?? null,
      comment: order.comment,
      customer: order.customer,
      clientId: order.clientId,
      client: order.client
        ? { id: order.client.id, name: order.client.name }
        : null,
      dueDate: order.dueDate ? order.dueDate.toISOString() : null,
      qtyPlanTotal,
      qtyFinishedTotal,
      deadline,
      companyDivisionId: order.companyDivisionId,
      companyDivision: order.companyDivision
        ? {
            id: order.companyDivision.id,
            code: order.companyDivision.code,
            name: order.companyDivision.name,
          }
        : null,
      routeTemplateId: order.routeTemplateId,
      routeTemplateCode: order.routeTemplate?.code ?? null,
      routeTemplateName: order.routeTemplate?.name ?? null,
      routeModeOverride: order.routeModeOverride,
      techCardId: order.techCardId,
      techCardCode: order.techCard?.code ?? null,
      techCardName: order.techCard?.name ?? null,
      // Soft-pattern MVP (этап 2 «Лекала»): live-поля карточки
      // лекала + snapshot-поля заказа. UI выбирает, что показать
      // (см. `OrderListItemDto.patternItemId`-комментарий).
      patternItemId: order.patternItemId,
      patternName: order.patternItem?.name ?? null,
      patternArticle: order.patternItem?.article ?? null,
      patternPreviewImageUrl: order.patternItem?.previewImageUrl ?? null,
      patternNameSnapshot: order.patternNameSnapshot,
      patternArticleSnapshot: order.patternArticleSnapshot,
      patternPreviewSnapshotUrl: order.patternPreviewSnapshotUrl,
      // Этап «Цена продажи за единицу»: snapshot полей в карточке
      // и в списке используют один источник — `Order.customerUnitPrice`
      // / `Order.customerCurrency`. Decimal сериализуется строкой,
      // валюта — `RUB`/`USD`/`null`.
      customerUnitPrice: order.customerUnitPrice
        ? order.customerUnitPrice.toString()
        : null,
      customerCurrency:
        (order.customerCurrency as 'RUB' | 'USD' | null) ?? null,
      // Этап «Склад выпуска готовой продукции»: краткие реквизиты
      // выбранного склада-получателя. Поля управленческие — их
      // присутствие в DTO **не** означает наличие движений готовой
      // продукции в `StockMovement`.
      finishedGoodsWarehouseId: order.finishedGoodsWarehouseId,
      finishedGoodsWarehouse: order.finishedGoodsWarehouse
        ? {
            id: order.finishedGoodsWarehouse.id,
            name: order.finishedGoodsWarehouse.name,
            code: order.finishedGoodsWarehouse.code,
          }
        : null,
      // Упрощённый MVP давальческого сырья / фурнитуры клиента:
      // та же нормализация политики, что в `toListItemDto`. UI
      // карточки заказа (`/admin/orders/[id]`) показывает бейдж
      // «Не учитываются», когда `EXCLUDE`; backend по этой же
      // политике решает, включать ли MATERIAL/HARDWARE в
      // себестоимость.
      materialsAndHardwareCostPolicy:
        normalizeMaterialsAndHardwareCostPolicy(
          order.materialsAndHardwareCostPolicy,
        ),
      // Этап 2 «План операций на заказе»: те же snapshot-поля, что
      // в `toListItemDto`. Здесь они нужны, чтобы карточка заказа
      // (`/admin/orders/[id]`) отрисовала блок «План операций» —
      // стоимость, время, дата фиксации, warnings.
      operationCostPlanRub: order.operationCostPlanRub
        ? order.operationCostPlanRub.toString()
        : null,
      operationTimePlanSec: order.operationTimePlanSec ?? null,
      operationPlanCalculatedAt: order.operationPlanCalculatedAt
        ? order.operationPlanCalculatedAt.toISOString()
        : null,
      operationPlanWarnings: normalizeOperationPlanWarnings(
        order.operationPlanWarnings,
      ),
      // Этап 2 «План операций на заказе» — stale-detection (см.
      // `OrderOperationPlanService.getFreshnessForOrder`). Поля
      // computed-only, в БД не хранятся.
      operationPlanIsStale: freshness.isStale,
      operationPlanStaleReason: freshness.reason,
      operationPlanSourceUpdatedAt: freshness.sourceUpdatedAt
        ? freshness.sourceUpdatedAt.toISOString()
        : null,
      // Inline-создание изделия из формы заказа: режим + стоимость
      // разработки лекала. Default `EXISTING_PATTERN` + null для
      // исторических заказов.
      productCreationMode: normalizeProductCreationMode(
        order.productCreationMode,
      ),
      patternDevelopmentCostRub: order.patternDevelopmentCostRub
        ? order.patternDevelopmentCostRub.toString()
        : null,
      patternDevelopmentCostInCostPrice:
        order.patternDevelopmentCostInCostPrice ?? true,
      items: order.items.map((it) => {
        const s = sizes.find((x) => x.id === it.sizeId);
        return {
          id: it.id,
          sizeId: it.sizeId,
          sizeCode: s?.code ?? '—',
          sizeSortOrder: s?.sortOrder ?? Number.MAX_SAFE_INTEGER,
          qtyPlan: it.qtyPlan,
        };
      }).sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
      summary,
      sizeBreakdown,
      routeSteps: order.routeSteps
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((s) => ({
          id: s.id,
          index: s.index,
          operationId: s.operationId,
          operationCode: s.operation.code,
          operationName: s.operation.name,
          parallelGroup: s.parallelGroup,
          rateOverride:
            s.rateOverride != null ? s.rateOverride.toNumber() : null,
          timeNormSecOverride: s.timeNormSecOverride ?? null,
          pricingModeOverride: s.pricingModeOverride ?? null,
          sizeOverrides: s.sizeOverrides.map((o) => ({
            sizeId: o.sizeId,
            rate: o.rate != null ? o.rate.toNumber() : null,
            seconds: o.seconds ?? null,
          })),
        })),
      materialRequirements: order.materialRequirements
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => ({
          id: r.id,
          sortOrder: r.sortOrder,
          name: r.name,
          unit: r.unit,
          qtyPerUnit: r.qtyPerUnit.toString(),
          totalQty: r.totalQty.toString(),
          note: r.note,
          // Этап 3 «Потребности цеха»: snapshot-поля из БД. Старые
          // snapshot-строки получают `null` по каждому полю — UI
          // карточки заказа на это рассчитан. `materialRole` — свободная
          // строка (БД хранит как String?), UI маппит через
          // `getTechCardMaterialRoleLabel`.
          materialRole: r.materialRole,
          fabricType: r.fabricType,
          densityGsm: r.densityGsm,
          plannedWidthCm: r.plannedWidthCm,
          colorRule:
            (r.colorRule as TechCardMaterialColorRule | null) ?? null,
          fixedColorText: r.fixedColorText,
          resolvedColorText: r.resolvedColorText,
          // Этап «Указать в заказе» (см. ТЗ §4): snapshot-флаг и
          // введённое менеджером значение по строке.
          requiresColorSelection: r.requiresColorSelection,
          selectedColorText: r.selectedColorText,
          // Этап «Фурнитура / изображение материала»: snapshot-копии
          // для UI карточки заказа.
          hardwareSizeText: r.hardwareSizeText,
          hardwareMaterialText: r.hardwareMaterialText,
          materialImageUrl: r.materialImageUrl,
          materialImageOriginalFileName: r.materialImageOriginalFileName,
        })),
      // Этап «Нанесение на заказе покупателя»: маппим OrderApplication
      // в OrderApplicationDto. Лейблы добавляем сразу (UI не дублирует
      // словари), Decimal сериализуется строкой — те же правила, что
      // у `WorkshopNeedDto.calculatedQty` / `OrderMaterialRequirementDto`.
      applications: (order.applications ?? []).map((a) =>
        applicationRowToDto(a),
      ),
      // Этап «Себестоимость заказа»: snapshot-поля заказа +
      // полный документ активного расчёта. Для DRAFT/CALCULATION
      // или заказов после reopen — все три поля null/undefined.
      costEstimateTotalRub: order.costEstimateTotalRub
        ? order.costEstimateTotalRub.toString()
        : null,
      costEstimateCompletedAt: order.costEstimateCompletedAt
        ? order.costEstimateCompletedAt.toISOString()
        : null,
      costEstimateVersion: order.costEstimateVersion ?? null,
      currentCostEstimate,
      // Этап «Конструкторское бюро»: связанная задача `ConstructorTask`,
      // если pattern был создан через flow «Отправить конструктору».
      // UI карточки заказа рендерит блок «Конструкторское бюро» с
      // действиями приёмки/возврата на доработку. `null` — у лекала
      // нет связанной задачи (стандартный flow создания).
      constructorTask: order.patternItem?.constructorTask
        ? mapConstructorTaskSummary(order.patternItem.constructorTask)
        : null,
      outsourceRequirements: order.outsourceRequirements
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => {
          const triggerType = r.triggerType as OutsourceTriggerType;
          // MVP-2 (ADR-0022 §«Cut-ready readiness»): readiness считается
          // ТОЛЬКО на чтении, ничего не пишем в БД. Для CUT_READY:
          // готово ⇔ у заказа есть паспорта и у каждого
          // `currentCellId != null` (правило ALL_PASSPORTS, см. ADR-0022).
          // Для MANUAL — индикатор не показываем (label = null).
          const isReadyToOrder =
            triggerType === 'CUT_READY' ? isCutReadyForOrder : false;
          const readinessLabel: string | null =
            triggerType === 'CUT_READY'
              ? isReadyToOrder
                ? 'Готово к заказу'
                : 'Ожидает размещения кроя'
              : null;
          // MVP-3 (ADR-0022 §«Manual execution status»): композиция
          // ручного статуса (`executionStatus` — source of truth) и
          // derived `READY_TO_ORDER`. Один источник для UI карточки
          // заказа; в БД `READY_TO_ORDER` НЕ материализуем.
          const executionStatus = r.executionStatus;
          const { displayStatus, displayStatusLabel } = composeDisplayStatus(
            executionStatus,
            triggerType,
            isReadyToOrder,
          );
          return {
            id: r.id,
            sortOrder: r.sortOrder,
            name: r.name,
            unit: r.unit,
            qtyPerUnit: r.qtyPerUnit ? r.qtyPerUnit.toString() : null,
            totalQty: r.totalQty ? r.totalQty.toString() : null,
            vendorName: r.vendorName,
            note: r.note,
            triggerType,
            isReadyToOrder,
            readinessLabel,
            executionStatus,
            orderedAt: r.orderedAt ? r.orderedAt.toISOString() : null,
            receivedAt: r.receivedAt ? r.receivedAt.toISOString() : null,
            displayStatus,
            displayStatusLabel,
          };
        }),
      // Ручные строки логистики заказа (см. `model OrderLogisticsLine`).
      // Decimal сериализуется строкой (как у material-requirements),
      // даты — ISO-string; `statusLabel` derive из общего словаря, UI
      // его не дублирует.
      logisticsLines: (order.logisticsLines ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => mapLogisticsLineToDto(l)),
    };
  }

  // -------------------------------------------------------------------------
  // OUTSOURCE EXECUTION STATUS (MVP-3 техкарт, ADR-0022)
  // -------------------------------------------------------------------------

  /**
   * Ручной перевод операционного статуса внешней потребности заказа.
   *
   * Линейные переходы: `PLANNED → ORDERED → RECEIVED`. Откатов через
   * action нет (см. ADR-0022 §«Manual execution status»). Для
   * `triggerType = CUT_READY` дополнительно проверяется derived
   * `isReadyToOrder` — нельзя отметить как заказанное, пока крой
   * не размещён в ячейки.
   *
   * Идемпотентность: повторный перевод в тот же статус не считается
   * ошибкой и не двигает `orderedAt` / `receivedAt` повторно — просто
   * возвращаем текущее состояние заказа. Это удобно для двойного
   * клика менеджера / ретрая клиента.
   */
  async updateOutsourceRequirementStatus(
    orderId: string,
    requirementId: string,
    nextStatus: 'ORDERED' | 'RECEIVED',
  ): Promise<OrderDetailDto> {
    const requirement = await this.prisma.orderOutsourceRequirement.findFirst({
      where: { id: requirementId, orderId },
    });
    if (!requirement) {
      throw new OrderOutsourceRequirementNotFoundException();
    }

    const current = requirement.executionStatus;

    // Идемпотентность: уже в нужном статусе → no-op (без перезаписи
    // timestamp-ов и без 409). См. ADR-0022 §«Manual execution status».
    if (current === nextStatus) {
      return this.getOne(orderId);
    }

    if (nextStatus === 'ORDERED') {
      if (current !== OrderOutsourceExecutionStatus.PLANNED) {
        throw new OrderOutsourceRequirementInvalidTransitionException(
          'Перевести во «Заказано» можно только из «Запланировано».',
        );
      }
      // CUT_READY guard: нельзя отдать подряд, пока крой не готов.
      // Считаем derived так же, как в `getOne()`: грузим только id и
      // currentCellId паспортов — это дешевле, чем тащить full include.
      if (requirement.triggerType === 'CUT_READY') {
        const passports = await this.prisma.passport.findMany({
          where: { orderId },
          select: { id: true, currentCellId: true },
        });
        const isReadyToOrder =
          passports.length > 0 &&
          passports.every((p) => p.currentCellId !== null);
        if (!isReadyToOrder) {
          throw new OrderOutsourceRequirementNotReadyException();
        }
      }
      await this.prisma.orderOutsourceRequirement.update({
        where: { id: requirementId },
        data: {
          executionStatus: OrderOutsourceExecutionStatus.ORDERED,
          // Аудит-метка: фиксируем только если поле ещё пустое
          // (на случай будущих переоткрытий — на MVP их нет, но
          // правило безопасное).
          orderedAt: requirement.orderedAt ?? new Date(),
        },
      });
    } else {
      // RECEIVED
      if (current !== OrderOutsourceExecutionStatus.ORDERED) {
        throw new OrderOutsourceRequirementInvalidTransitionException(
          'Перевести в «Получено» можно только из «Заказано».',
        );
      }
      await this.prisma.orderOutsourceRequirement.update({
        where: { id: requirementId },
        data: {
          executionStatus: OrderOutsourceExecutionStatus.RECEIVED,
          receivedAt: new Date(),
          // orderedAt НЕ заполняем «задним числом» — если по какой-то
          // причине был null, остаётся null (см. ADR-0022).
        },
      });
    }

    return this.getOne(orderId);
  }

  // -------------------------------------------------------------------------
  // MATERIAL REQUIREMENT COLOR (этап «Указать в заказе», ТЗ §4)
  // -------------------------------------------------------------------------

  /**
   * Сохранить цвет, выбранный менеджером для конкретной строки
   * материала заказа (`OrderMaterialRequirement`). Доступно только
   * для строк, у которых `requiresColorSelection = true` — это
   * строки, у которых в техкарте `colorRule = ORDER_SELECTED_COLOR`.
   *
   * Семантика:
   *   - `value === null` — стереть цвет; `resolvedColorText` обнуляется;
   *   - непустая строка — сохранить и продублировать в
   *     `resolvedColorText` (snapshot-итог цвета строки заказа).
   *
   * Метаданные snapshot-а (`materialRole` / `fabricType` / общая
   * потребность) остаются независимыми от шаблона, как и до этой
   * фичи. Никаких side-effect на WorkshopNeed / PurchaseOrder /
   * payroll нет (см. ТЗ §«Что НЕ трогать»).
   */
  async updateMaterialRequirementColor(
    orderId: string,
    requirementId: string,
    value: string | null,
  ): Promise<OrderDetailDto> {
    const requirement = await this.prisma.orderMaterialRequirement.findFirst({
      where: { id: requirementId, orderId },
      select: {
        id: true,
        requiresColorSelection: true,
        selectedColorText: true,
      },
    });
    if (!requirement) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'ORDER_MATERIAL_REQUIREMENT_NOT_FOUND',
        message: 'Строка материалов заказа не найдена',
      });
    }
    if (!requirement.requiresColorSelection) {
      // 409: snapshot говорит «цвет не нужен» (см.
      // `OrderMaterialRequirementColorNotRequiredException`).
      throw new OrderMaterialRequirementColorNotRequiredException();
    }
    // Идемпотентность: повторное сохранение того же значения — no-op.
    if (
      (requirement.selectedColorText ?? null) === (value ?? null)
    ) {
      return this.getOne(orderId);
    }
    await this.prisma.orderMaterialRequirement.update({
      where: { id: requirementId },
      data: {
        selectedColorText: value,
        // resolvedColorText синхронизируется с selectedColorText —
        // это «итоговый» цвет строки, который видит UI карточки заказа,
        // и который потом будет использоваться для отчётов / закупки.
        resolvedColorText: value,
      },
    });
    return this.getOne(orderId);
  }

  // -------------------------------------------------------------------------
  // ORDER LOGISTICS LINES (ручные строки логистики в таблице «Операции»)
  // -------------------------------------------------------------------------

  /**
   * Создать ручную строку логистики заказа (кнопка «Добавить поле» в
   * конце таблицы «Операции» карточки заказа).
   *
   * `name` и `costRub` обязательны (поля нельзя удалить в окне);
   * `status` и `deliveryDeadline` — опциональны (их поля можно убрать).
   * Новая строка добавляется в конец: `sortOrder = max + 1`.
   *
   * Доступно в любом статусе заказа — это не snapshot маршрута/техкарты,
   * а собственные редактируемые данные заказа, поэтому ORDER_LOCKED
   * guard здесь не применяется (см. JSDoc `model OrderLogisticsLine`).
   */
  async addLogisticsLine(
    orderId: string,
    dto: CreateOrderLogisticsLineDto,
  ): Promise<OrderDetailDto> {
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

    const last = await this.prisma.orderLogisticsLine.findFirst({
      where: { orderId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    const nextSortOrder = (last?.sortOrder ?? -1) + 1;

    await this.prisma.orderLogisticsLine.create({
      data: {
        orderId,
        sortOrder: nextSortOrder,
        ...buildLogisticsLineData(dto),
      },
    });
    return this.getOne(orderId);
  }

  /**
   * Изменить существующую строку логистики. UI пере-собирает форму
   * целиком, поэтому принимаем тот же контракт, что и create.
   */
  async updateLogisticsLine(
    orderId: string,
    lineId: string,
    dto: UpdateOrderLogisticsLineDto,
  ): Promise<OrderDetailDto> {
    const line = await this.prisma.orderLogisticsLine.findFirst({
      where: { id: lineId, orderId },
      select: { id: true },
    });
    if (!line) {
      throw new OrderLogisticsLineNotFoundException();
    }
    await this.prisma.orderLogisticsLine.update({
      where: { id: lineId },
      data: buildLogisticsLineData(dto),
    });
    return this.getOne(orderId);
  }

  /**
   * Удалить строку логистики заказа.
   */
  async deleteLogisticsLine(
    orderId: string,
    lineId: string,
  ): Promise<OrderDetailDto> {
    const line = await this.prisma.orderLogisticsLine.findFirst({
      where: { id: lineId, orderId },
      select: { id: true },
    });
    if (!line) {
      throw new OrderLogisticsLineNotFoundException();
    }
    await this.prisma.orderLogisticsLine.delete({ where: { id: lineId } });
    return this.getOne(orderId);
  }

  /**
   * Резолвит `companyDivisionId` для записи в `Order.companyDivisionId`
   * (см. `prisma/schema.prisma::Order.companyDivisionId`,
   * `docs/domain.md §«Подразделения заказа»`).
   *
   * Контракт:
   *   - `undefined` → `null` (заказ создан/обновлён без привязки);
   *   - `null` → `null` (явно снять привязку);
   *   - непустая строка → проверяем существование карточки
   *     `CompanyDivision`. Если нет — 400 `COMPANY_DIVISION_NOT_FOUND`,
   *     чтобы UI получил адресную ошибку вместо сырого FK-сбоя.
   *
   * Активность карточки (`isActive`) сознательно не проверяем:
   * менеджер может временно отключить подразделение, но заказы,
   * уже на него ссылающиеся, продолжают существовать. UI в селектах
   * по умолчанию показывает только активные.
   */
  private async resolveCompanyDivisionIdForOrder(
    tx: Prisma.TransactionClient,
    companyDivisionId: string | null | undefined,
  ): Promise<string | null> {
    if (companyDivisionId === undefined || companyDivisionId === null) {
      return null;
    }
    const card = await tx.companyDivision.findUnique({
      where: { id: companyDivisionId },
      select: { id: true },
    });
    if (!card) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'COMPANY_DIVISION_NOT_FOUND',
        message: 'Подразделение не найдено',
      });
    }
    return card.id;
  }

  /**
   * Резолвит `finishedGoodsWarehouseId` для записи в
   * `Order.finishedGoodsWarehouseId` (см.
   * `prisma/schema.prisma::Order.finishedGoodsWarehouseId`,
   * `docs/current-state.md §«Склад выпуска готовой продукции»`).
   *
   * Контракт:
   *   - `undefined` → не трогаем колонку (актуально для PATCH без
   *     поля). На create — заказ создаётся без выбранного склада;
   *   - `null` → явно снимаем привязку (`Order.finishedGoodsWarehouseId
   *     = null`);
   *   - непустая строка → проверяем existence + `isActive = true`.
   *     На несуществующий — 400 `WAREHOUSE_NOT_FOUND`. На неактивный —
   *     409 `WAREHOUSE_INACTIVE`. UI покажет адресную ошибку и не даст
   *     сохранить заказ с «зомби»-складом.
   *
   * Это **не** склад материалов: `StockBalance` / `StockMovement`
   * никак не затрагиваются. Поле живёт ровно на уровне `Order`.
   */
  private async resolveFinishedGoodsWarehouseIdForOrder(
    tx: Prisma.TransactionClient,
    warehouseId: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (warehouseId === undefined) return undefined;
    if (warehouseId === null) return null;
    const wh = await tx.warehouse.findUnique({
      where: { id: warehouseId },
      select: { id: true, isActive: true },
    });
    if (!wh) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'WAREHOUSE_NOT_FOUND',
        message: 'Склад выпуска готовой продукции не найден',
      });
    }
    if (!wh.isActive) {
      throw new BadRequestException({
        statusCode: 409,
        code: 'WAREHOUSE_INACTIVE',
        message: 'Склад выпуска готовой продукции неактивен',
      });
    }
    return wh.id;
  }

  /**
   * Soft-route MVP: проверяет, что выбранный шаблон существует и
   * активен. Используется и в `create`, и в `update`. На неактивный
   * шаблон отдаём 409 (ROUTE_TEMPLATE_INACTIVE) — это soft-protection
   * против UI, который раздаёт не-активные значения.
   */
  private async assertRouteTemplateUsable(
    routeTemplateId: string,
  ): Promise<void> {
    const tpl = await this.prisma.routeTemplate.findUnique({
      where: { id: routeTemplateId },
      select: { id: true, isActive: true },
    });
    if (!tpl) throw new RouteTemplateNotFoundException();
    if (!tpl.isActive) throw new RouteTemplateInactiveException();
  }

  /**
   * Client ref MVP: проверяет, что выбранная карточка клиента
   * существует и активна. Используется и в `create`, и в `update`.
   * На неактивный/несуществующий клиент отдаём 400, чтобы UI мог
   * подсветить именно поле «Клиент» (см. `apps/api/src/common/errors.ts`,
   * коды `CLIENT_NOT_FOUND` / `CLIENT_INACTIVE`).
   */
  private async assertClientUsable(clientId: string): Promise<void> {
    const c = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, isActive: true },
    });
    if (!c) throw new ClientNotFoundException();
    if (!c.isActive) throw new ClientInactiveException();
  }

  /**
   * Soft-pattern MVP (этап 2 «Лекала»): проверяет, что выбранная
   * карточка лекала существует и `status = ACTIVE`. Используется и
   * в `create`, и в `update` — по той же схеме, что
   * `assertRouteTemplateUsable` / `TechCardsService.assertTechCardUsable`.
   *
   * `PatternItem.status` — свободная строка с дефолтом `ACTIVE` (см.
   * `prisma/schema.prisma`). UI по умолчанию показывает только
   * `ACTIVE`-лекала; backend дополнительно блокирует прямой POST/PATCH
   * с не-`ACTIVE` лекалом отдельной 409 PATTERN_INACTIVE.
   *
   * Исключение — DRAFT-pattern, у которого есть привязанная активная
   * `ConstructorTask` (`NEW` / `IN_PROGRESS` / `PENDING_ACCEPT` /
   * `REWORK`): такой pattern существует ровно потому, что менеджер
   * отправил его конструктору и ждёт готового лекала. Заказ в DRAFT
   * вокруг него — нормальный сценарий, его нужно разрешить менеджеру
   * сохранять/редактировать. `assertOrderStartable` (в `start()`)
   * по-прежнему блокирует запуск в производство — там pattern ОБЯЗАН
   * быть ACTIVE, и accept-flow менеджера это гарантирует.
   */
  private async assertPatternUsable(patternItemId: string): Promise<void> {
    const p = await this.prisma.patternItem.findUnique({
      where: { id: patternItemId },
      select: {
        id: true,
        status: true,
        constructorTask: { select: { status: true } },
      },
    });
    if (!p) throw new PatternNotFoundException();
    if (p.status === 'ACTIVE') return;
    // DRAFT-pattern допускается, если есть незавершённая ConstructorTask.
    const taskStatus = p.constructorTask?.status;
    const taskIsActive =
      taskStatus === 'NEW' ||
      taskStatus === 'IN_PROGRESS' ||
      taskStatus === 'PENDING_ACCEPT' ||
      taskStatus === 'REWORK';
    if (p.status === 'DRAFT' && taskIsActive) return;
    throw new PatternInactiveException();
  }

  /**
   * Этап «Указать в заказе» (см. ТЗ §2): пересобрать snapshot
   * `OrderMaterialRequirement[]` по live-строкам техкарты заказа.
   *
   * Семантика:
   *   - Загружаем текущие OrderMaterialRequirement (чтобы сохранить
   *     введённый менеджером `selectedColorText` для строк с
   *     `colorRule = ORDER_SELECTED_COLOR`).
   *   - Если у заказа нет `techCardId` — стираем snapshot полностью
   *     (snapshot всегда консистентен с текущей привязкой).
   *   - Иначе грузим строки шаблона через `getLinesForSnapshot()`,
   *     считаем `totalQty = qtyPerUnit * Σ OrderItem.qtyPlan`,
   *     резолвим цвет по `colorRule`:
   *       - `ORDER_COLOR`          → `Order.color`;
   *       - `FIXED_COLOR`          → `fixedColorText`;
   *       - `NO_COLOR` / null      → null;
   *       - `ORDER_SELECTED_COLOR` → previousSelectedColorText
   *         (preserve), `requiresColorSelection = true`.
   *   - Match для preserve `selectedColorText`:
   *       1) по `sourceTechCardLineId` (если строка шаблона жива);
   *       2) fallback по `materialRole + fabricType + hardwareSizeText
   *          + hardwareMaterialText` (если строка шаблона удалена и
   *          создана заново с теми же атрибутами).
   *   - Сначала `deleteMany`, затем `createMany` — атомарно внутри tx.
   *
   * Эта функция НЕ вызывает workshop-needs / payroll / Passport;
   * snapshot — изолированный артефакт строки заказа. `start()`
   * использует уже существующий snapshot и НЕ перезаписывает его
   * (см. `existingMat === 0` guard), чтобы введённый менеджером
   * цвет не терялся.
   */
  private async rebuildMaterialRequirementsSnapshot(
    orderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        color: true,
        techCardId: true,
        items: { select: { qtyPlan: true } },
      },
    });
    if (!order) return;

    const existing = await tx.orderMaterialRequirement.findMany({
      where: { orderId },
      select: {
        id: true,
        sourceTechCardLineId: true,
        materialRole: true,
        fabricType: true,
        hardwareSizeText: true,
        hardwareMaterialText: true,
        selectedColorText: true,
      },
    });

    if (!order.techCardId) {
      if (existing.length > 0) {
        await tx.orderMaterialRequirement.deleteMany({
          where: { orderId },
        });
      }
      return;
    }

    const lines = await this.techCards.getLinesForSnapshot(order.techCardId);
    const baseQty = order.items.reduce((s, it) => s + it.qtyPlan, 0);
    const baseDecimal = new Prisma.Decimal(baseQty);

    // Map для preserve-а selectedColorText. Ключ выбирается по
    // sourceTechCardLineId, fallback — по композитному ключу
    // role|fabricType|hardwareSize|hardwareMaterial. Композитный ключ
    // спасает кейс «строка шаблона удалена и создана заново с теми
    // же атрибутами», когда sourceTechCardLineId уже не совпадёт.
    const prevBySourceId = new Map<string, string>();
    const prevByCompositeKey = new Map<string, string>();
    for (const r of existing) {
      if (!r.selectedColorText) continue;
      if (r.sourceTechCardLineId) {
        prevBySourceId.set(r.sourceTechCardLineId, r.selectedColorText);
      }
      const compositeKey = composeMaterialMatchKey(
        r.materialRole,
        r.fabricType,
        r.hardwareSizeText,
        r.hardwareMaterialText,
      );
      if (compositeKey) {
        prevByCompositeKey.set(compositeKey, r.selectedColorText);
      }
    }

    const data = lines.materialLines.map((l) => {
      const prevSelected =
        prevBySourceId.get(l.id) ??
        prevByCompositeKey.get(
          composeMaterialMatchKey(
            l.materialRole,
            l.fabricType,
            l.hardwareSizeText,
            l.hardwareMaterialText,
          ) ?? '',
        ) ??
        null;
      const isOrderSelected = l.colorRule === 'ORDER_SELECTED_COLOR';
      const resolvedColorText = isOrderSelected
        ? prevSelected
        : resolveColorText(l.colorRule, l.fixedColorText, order.color);
      return {
        orderId,
        sourceTechCardLineId: l.id,
        sortOrder: l.sortOrder,
        name: l.name,
        unit: l.unit,
        qtyPerUnit: l.qtyPerUnit,
        totalQty: l.qtyPerUnit.mul(baseDecimal),
        note: l.note,
        materialRole: l.materialRole,
        fabricType: l.fabricType,
        densityGsm: l.densityGsm,
        plannedWidthCm: l.plannedWidthCm,
        colorRule: l.colorRule,
        fixedColorText: l.fixedColorText,
        resolvedColorText,
        requiresColorSelection: isOrderSelected,
        selectedColorText: isOrderSelected ? prevSelected : null,
        hardwareSizeText: l.hardwareSizeText,
        hardwareMaterialText: l.hardwareMaterialText,
        materialImageUrl: l.materialImageUrl,
        materialImageOriginalFileName: l.materialImageOriginalFileName,
        // Фаза 2 «Характеристики номенклатуры»: перенос в пересобранный
        // snapshot.
        subtypeKey: l.subtypeKey,
        characteristics: l.characteristics ?? Prisma.DbNull,
      };
    });

    // deleteMany + createMany ради простоты: WorkshopNeed.sourceId не
    // имеет FK на OrderMaterialRequirement (см. schema.prisma и
    // ADR-0022 §«snapshot independence»), поэтому пересборка snapshot-а
    // не валит ранее посчитанные потребности.
    if (existing.length > 0) {
      await tx.orderMaterialRequirement.deleteMany({
        where: { orderId },
      });
    }
    if (data.length > 0) {
      await tx.orderMaterialRequirement.createMany({ data });
    }
  }
}

/**
 * Тонкая обёртка над shared-helper-ом `evaluateOrderDeadline`,
 * приводящая результат к `OrderDeadlineDto` (точечно: `tone`
 * сужен до `string`, чтобы DTO мог сериализоваться без зависимости
 * от shared-enum). Используется и `toListItemDto`, и `toDetailDto`,
 * чтобы цвет/лейбл/процент строго совпадали в списке и карточке.
 *
 * Pure: ничего не читает из БД, не зависит от часового пояса хоста
 * (см. UTC-нормализацию в `evaluateOrderDeadline`). Тестируется
 * unit-ом `tests/unit/order-deadlines.test.ts` и интеграционно
 * `tests/integration/orders-deadlines.test.ts`.
 */
function evaluateDeadlineForDto(
  input: EvaluateOrderDeadlineInput,
): OrderDeadlineDto {
  const e = evaluateOrderDeadline(input);
  return {
    status: e.status,
    label: e.label,
    tone: e.tone,
    daysLeft: e.daysLeft,
    progressPercent: e.progressPercent,
    reason: e.reason,
  };
}

/**
 * Этап «Цена продажи за единицу»: общее правило подстановки
 * валюты для `customerUnitPrice` / `customerCurrency`.
 *
 * Правила:
 *   - если цена не задана (`undefined` / `null` / пустая) — обе колонки
 *     остаются `null`/`undefined` без default-ов;
 *   - если цена есть и валюта явно задана — берём её как есть;
 *   - если цена > 0 без валюты — default `RUB` (см. ТЗ §C5
 *     «default RUB только при price > 0»).
 *
 * Возвращает `customerUnitPrice` как `string | null | undefined`
 * (Decimal-совместимая строка; `null` = стереть; `undefined` =
 * не трогать колонку), и `customerCurrency` аналогично.
 */
function resolveCustomerPriceAndCurrency(
  rawPrice: string | null | undefined,
  rawCurrency: 'RUB' | 'USD' | null | undefined,
): {
  customerUnitPrice: string | null | undefined;
  customerCurrency: 'RUB' | 'USD' | null | undefined;
} {
  if (rawPrice === undefined && rawCurrency === undefined) {
    return {
      customerUnitPrice: undefined,
      customerCurrency: undefined,
    };
  }
  if (rawPrice === null || rawPrice === undefined) {
    // Цена пустая: валюту тоже стираем — без цены валюта смысла
    // не имеет (UI показывает «цена продажи не указана»).
    return {
      customerUnitPrice: rawPrice ?? null,
      customerCurrency: rawCurrency ?? null,
    };
  }
  let currency: 'RUB' | 'USD' | null | undefined = rawCurrency;
  if (
    (currency === undefined || currency === null) &&
    Number(rawPrice) > 0
  ) {
    currency = 'RUB';
  }
  return {
    customerUnitPrice: rawPrice,
    customerCurrency: currency ?? null,
  };
}

/**
 * Упрощённый MVP давальческого сырья / фурнитуры клиента: маппер
 * raw-значения колонки в нормализованную shared-политику.
 *
 * В БД (`Order.materialsAndHardwareCostPolicy`) хранится строкой,
 * default = `INCLUDE` (см. миграцию). Любое неожиданное значение
 * (исторические данные / ручная правка) трактуем как `INCLUDE` —
 * это безопасный default «материалы и фурнитура учитываются как
 * раньше».
 */
function normalizeMaterialsAndHardwareCostPolicy(
  raw: string | null | undefined,
): OrderMaterialsAndHardwareCostPolicy {
  if (typeof raw !== 'string') return 'INCLUDE';
  const normalized = raw.trim().toUpperCase();
  return ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES.includes(
    normalized as OrderMaterialsAndHardwareCostPolicy,
  )
    ? (normalized as OrderMaterialsAndHardwareCostPolicy)
    : 'INCLUDE';
}

/**
 * Inline-создание изделия из формы заказа (см.
 * `prisma/schema.prisma::Order.productCreationMode`). Нормализует
 * значение из БД (хранится свободной строкой) к whitelist-у; иначе
 * fallback на `EXISTING_PATTERN` (исторические заказы).
 */
const ORDER_PRODUCT_CREATION_MODE_VALUES = [
  'EXISTING_PATTERN',
  'CREATE_FOR_CALCULATION',
  'SEND_TO_CONSTRUCTOR',
] as const;
type OrderProductCreationModeValue =
  (typeof ORDER_PRODUCT_CREATION_MODE_VALUES)[number];

function normalizeProductCreationMode(
  raw: string | null | undefined,
): OrderProductCreationModeValue {
  if (typeof raw !== 'string') return 'EXISTING_PATTERN';
  const v = raw.trim().toUpperCase() as OrderProductCreationModeValue;
  return ORDER_PRODUCT_CREATION_MODE_VALUES.includes(v)
    ? v
    : 'EXISTING_PATTERN';
}

/**
 * Упрощённый MVP давальческого сырья / фурнитуры клиента (см.
 * `prisma/schema.prisma::Order.materialsAndHardwareCostPolicy`,
 * `packages/shared/src/orders.ts::OrderMaterialsAndHardwareCostPolicy`).
 *
 * Нормализует вход из DTO (Zod-схема уже привела к `INCLUDE` /
 * `EXCLUDE` / `undefined`):
 *   - `undefined` на create → `INCLUDE` (default);
 *   - `undefined` на update → `undefined` (Prisma не трогает колонку);
 *   - валидное значение → как есть;
 *   - всё остальное → reject через 400 (защитный fallback —
 *     Zod-схема такого не пропустит).
 *
 * Функция используется и в `create` (`mode: 'create'` → null-safe
 * default), и в `update` (`mode: 'update'` → undefined-passthrough).
 */
function resolveMaterialsAndHardwareCostPolicy(
  raw: OrderMaterialsAndHardwareCostPolicy | string | null | undefined,
  mode: 'create' | 'update',
): OrderMaterialsAndHardwareCostPolicy | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return mode === 'create' ? 'INCLUDE' : undefined;
  }
  const normalized =
    typeof raw === 'string' ? raw.trim().toUpperCase() : raw;
  if (
    !ORDER_MATERIALS_AND_HARDWARE_COST_POLICIES.includes(
      normalized as OrderMaterialsAndHardwareCostPolicy,
    )
  ) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'ORDER_MATERIALS_AND_HARDWARE_COST_POLICY_INVALID',
      message:
        'Недопустимое значение «учёт материалов и фурнитуры в себестоимости»',
    });
  }
  return normalized as OrderMaterialsAndHardwareCostPolicy;
}

/**
 * Этап 3 «Потребности цеха» (см. `docs/recon-soft-integration.md
 * §«Этап 3»`): derived snapshot-цвет строки материала по правилу
 * `colorRule`. Pure-функция, без БД и побочных эффектов; вычисляется
 * один раз в `OrdersService.start()` и фиксируется в
 * `OrderMaterialRequirement.resolvedColorText`.
 *
 * Правила:
 *   - `ORDER_COLOR` → `order.color` (`null`, если у заказа цвет не задан);
 *   - `FIXED_COLOR` → `fixedColorText` (`null`, если он пуст);
 *   - `NO_COLOR`    → `null`;
 *   - `null`/неизвестное → `null` (backward-compat для старых техкарт).
 *
 * Никаких исключений: неполные данные → null, snapshot всё равно
 * фиксируется. Это сознательно «терпимый» helper — UI/будущий расчёт
 * сам решит, что делать с null.
 */
function resolveColorText(
  colorRule: TechCardMaterialColorRule | null,
  fixedColorText: string | null,
  orderColor: string | null,
): string | null {
  if (colorRule === 'ORDER_COLOR') {
    return orderColor ?? null;
  }
  if (colorRule === 'FIXED_COLOR') {
    const t = (fixedColorText ?? '').trim();
    return t === '' ? null : t;
  }
  // NO_COLOR / null / unknown / ORDER_SELECTED_COLOR без выбранного
  // цвета — единое поведение «нет цвета».
  return null;
}

/**
 * Этап «Указать в заказе»: композитный fallback-ключ для match-а
 * `selectedColorText` между старым и новым snapshot-ом строки
 * материала заказа. Используется в `rebuildMaterialRequirementsSnapshot`,
 * когда сравнения по `sourceTechCardLineId` недостаточно (например,
 * админ удалил строку шаблона и завёл её заново — id у неё уже
 * другой, но семантически это та же позиция).
 *
 * Возвращает `null`, если все составляющие пусты — для таких строк
 * fallback бессмыслен и preservation срабатывает только по
 * sourceTechCardLineId.
 */
function composeMaterialMatchKey(
  materialRole: string | null,
  fabricType: string | null,
  hardwareSizeText: string | null,
  hardwareMaterialText: string | null,
): string | null {
  const role = (materialRole ?? '').trim();
  const fabric = (fabricType ?? '').trim();
  const size = (hardwareSizeText ?? '').trim();
  const mat = (hardwareMaterialText ?? '').trim();
  if (role === '' && fabric === '' && size === '' && mat === '') {
    return null;
  }
  return `${role}|${fabric}|${size}|${mat}`;
}

/**
 * Композиция UI-статуса внешней потребности из БД-уровневого ручного
 * `executionStatus`, snapshot-а `triggerType` и derived
 * `isReadyToOrder` (см. ADR-0022 §«Manual execution status»).
 *
 * Порядок ветвей важен: ручной статус сильнее, чем derived
 * `READY_TO_ORDER`. Менеджер мог отметить «заказано» руками для
 * MANUAL-строки или для CUT_READY-строки до полного размещения кроя
 * (когда `isReadyToOrder = false`); экранировать от такого UX
 * мы не должны — это всё ещё валидное состояние «заказ был
 * физически отдан подрядчику».
 */
/**
 * Маппер БД-строки `OrderApplication` в DTO для карточки заказа.
 * Pure-функция: не читает БД и не зависит от состояния сервиса —
 * аналогичный стиль, как у `evaluateDeadlineForDto` / `resolveColorText`
 * в этом же файле, чтобы `toDetailDto` оставался компактным.
 */
function applicationRowToDto(row: {
  id: string;
  orderId: string;
  type: string;
  stage: string;
  placement: string | null;
  widthMm: number | null;
  heightMm: number | null;
  colorsCount: number | null;
  quantity: Prisma.Decimal | null;
  unit: string;
  colorText: string | null;
  description: string | null;
  comment: string | null;
  fileUrl: string | null;
  status: string;
  groupKey: string | null;
  groupLabel: string | null;
  sizes: {
    sizeId: string;
    quantity: Prisma.Decimal | null;
    size: { code: string };
  }[];
  createdAt: Date;
  updatedAt: Date;
}): OrderApplicationDto {
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

/**
 * Этап 2 «План операций на заказе» (см.
 * `docs/operation-time-norms-recon.md §10/§11`,
 * `apps/api/src/modules/orders/order-operation-plan.service.ts`).
 *
 * Нормализует `Order.operationPlanWarnings` (JSONB) → `string[] | null`
 * для DTO. Контракт мягкий: если в БД лежит `null` или не-массив
 * (например, результат ручной правки или формат другого этапа),
 * отдаём `null` без падения. Ненулевые элементы массива приводим к
 * строке через `String(...)` — это сохраняет smoke-инвариант
 * «warnings всегда читаются UI как `string[] | null`».
 */
function normalizeOperationPlanWarnings(
  raw: unknown,
): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  const result: string[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    result.push(typeof item === 'string' ? item : String(item));
  }
  return result.length > 0 ? result : null;
}

function composeDisplayStatus(
  executionStatus: OrderOutsourceExecutionStatus,
  triggerType: OutsourceTriggerType,
  isReadyToOrder: boolean,
): { displayStatus: OrderOutsourceDisplayStatus; displayStatusLabel: string | null } {
  if (executionStatus === OrderOutsourceExecutionStatus.RECEIVED) {
    return { displayStatus: 'RECEIVED', displayStatusLabel: 'Получено' };
  }
  if (executionStatus === OrderOutsourceExecutionStatus.ORDERED) {
    return { displayStatus: 'ORDERED', displayStatusLabel: 'Заказано' };
  }
  // executionStatus === PLANNED
  if (triggerType === 'CUT_READY' && isReadyToOrder) {
    return {
      displayStatus: 'READY_TO_ORDER',
      displayStatusLabel: 'Готово к заказу',
    };
  }
  if (triggerType === 'CUT_READY') {
    return {
      displayStatus: 'PLANNED',
      displayStatusLabel: 'Ожидает размещения кроя',
    };
  }
  // MANUAL + PLANNED — нейтральное состояние, UI ничего не дорисовывает.
  return { displayStatus: 'PLANNED', displayStatusLabel: null };
}

/**
 * Нормализует тело create/update строки логистики в Prisma-данные:
 * `deliveryDeadline` (ISO-string) → `Date | null`, `status` → enum или
 * `null` (поле убрано), `costRub` → число (Prisma сам приведёт к
 * Decimal). Одна точка правды для add/update, чтобы оба пути писали
 * одинаково.
 */
function buildLogisticsLineData(
  dto: CreateOrderLogisticsLineDto | UpdateOrderLogisticsLineDto,
): {
  name: string;
  costRub: number;
  status: OrderLogisticsStatus | null;
  deliveryDeadline: Date | null;
} {
  return {
    name: dto.name,
    costRub: dto.costRub,
    status: (dto.status ?? null) as OrderLogisticsStatus | null,
    deliveryDeadline:
      dto.deliveryDeadline != null && dto.deliveryDeadline !== ''
        ? new Date(dto.deliveryDeadline)
        : null,
  };
}

/**
 * Мапит строку `OrderLogisticsLine` в `OrderLogisticsLineDto`.
 * Decimal → строка, даты → ISO-string, `statusLabel` derive из общего
 * словаря `ORDER_LOGISTICS_STATUS_LABELS`.
 */
function mapLogisticsLineToDto(l: {
  id: string;
  sortOrder: number;
  name: string;
  status: OrderLogisticsStatus | null;
  deliveryDeadline: Date | null;
  costRub: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
}): OrderLogisticsLineDto {
  return {
    id: l.id,
    sortOrder: l.sortOrder,
    name: l.name,
    status: l.status,
    statusLabel: l.status ? ORDER_LOGISTICS_STATUS_LABELS[l.status] : null,
    deliveryDeadline: l.deliveryDeadline
      ? l.deliveryDeadline.toISOString()
      : null,
    costRub: l.costRub.toString(),
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}
