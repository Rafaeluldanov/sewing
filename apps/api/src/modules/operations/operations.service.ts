import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type PricingMode } from '@prisma/client';
import type {
  CreateOperationDto,
  OperationBlockersResponse,
  OperationDeleteBlockerDto,
  OperationDetailDto,
  OperationSummaryDto,
  TimeNormMode,
  UpdateOperationDto,
} from '@sewing/shared/operations';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthPrincipal } from '../auth/auth.types.js';
import {
  EquipmentNotFoundException,
  OperationCodeTakenException,
  OperationInUseException,
  OperationNotFoundException,
  OperationRateDuplicateSizeException,
  OperationRateMissingException,
  OperationRateSizeNotFoundException,
} from '../../common/errors.js';

/**
 * Управляющий сервис для блока «Операции» (см. `docs/domain.md §16a`,
 * `docs/api.md §15a`, `docs/screens.md §10c`).
 *
 * Отвечает за:
 *   1. CRUD операций (`list`, `getOne`, `create`, `update`).
 *   2. Согласованную смену `pricingMode` с очисткой/перезаписью
 *      ставок в одной транзакции.
 *   3. Источник истины для сдельных начислений — `resolveRate(...)`,
 *      который использует `EarningsService` вместо устаревшего
 *      исторический `PieceRate.findFirst` (таблица удалена в PHASE 2 STEP 1; см. ADR-0005 и комментарий в
 *      `EarningsService`).
 *
 * Сознательные ограничения MVP:
 *   - один тариф на пару `(operationId, sizeId)`, без истории;
 *   - без привязки к продукту/сотруднику/складу/селлеру.
 *
 * Удаление операции — двухуровневое (см. `getBlockers` / `remove`):
 *   - мягкое (основной путь) — `update({ isActive: false })`: вся
 *     история и тарифы остаются, операция уходит из рабочих списков;
 *   - физическое (`remove`) — только для свежесозданных операций без
 *     единой ссылки (история / маршруты / substitute-правила),
 *     каскадно снимает только конфигурацию (тарифы, нормы, привязку
 *     к станкам). Доступно лишь `ADMIN`.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger(OperationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(): Promise<OperationSummaryDto[]> {
    const rows = await this.prisma.operation.findMany({
      orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }],
      include: {
        _count: {
          select: { ratesBySize: true, timeNormsBySize: true },
        },
      },
    });
    return rows.map((o) =>
      this.toSummary(o, o._count.ratesBySize, o._count.timeNormsBySize),
    );
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<OperationDetailDto> {
    const row = await this.prisma.operation.findUnique({
      where: { id },
      include: {
        ratesBySize: {
          include: { size: true },
          orderBy: { size: { sortOrder: 'asc' } },
        },
        timeNormsBySize: {
          include: { size: true },
          orderBy: { size: { sortOrder: 'asc' } },
        },
        equipmentOperations: {
          include: { equipment: true },
          orderBy: { equipment: { code: 'asc' } },
        },
      },
    });
    if (!row) throw new OperationNotFoundException();

    const sizes = await this.prisma.size.findMany({
      orderBy: { sortOrder: 'asc' },
    });
    return {
      ...this.toSummary(row, row.ratesBySize.length, row.timeNormsBySize.length),
      ratesBySize: row.ratesBySize.map((r) => ({
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        rate: Number(r.rate.toFixed(2)),
      })),
      timeNormsBySize: row.timeNormsBySize.map((r) => ({
        sizeId: r.sizeId,
        sizeCode: r.size.code,
        sizeSortOrder: r.size.sortOrder,
        seconds: r.seconds,
      })),
      sizes: sizes.map((s) => ({
        id: s.id,
        code: s.code,
        sortOrder: s.sortOrder,
      })),
      equipment: row.equipmentOperations.map((eo) => ({
        equipmentId: eo.equipment.id,
        code: eo.equipment.code,
        name: eo.equipment.name,
        displayNumber: eo.equipment.displayNumber,
        isActive: eo.isActive && eo.equipment.active,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // EQUIPMENT BINDING (operation-side pivot)
  // -------------------------------------------------------------------------

  /**
   * Привязка операции к набору оборудования со стороны операции
   * (`PATCH /api/operations/:id/equipment`). Зеркало
   * `EquipmentService.updateOperations`, но pivot — по операции:
   * переданные `equipmentIds` становятся единственными активными
   * привязками операции (replace-all), лишние — удаляются.
   *
   * Ключевое отличие от equipment-side: мы НЕ переназначаем `sortOrder`
   * остальных операций на станке. Equipment-side задаёт порядок всего
   * списка операций станка (`(i+1)*10`); здесь мы трогаем ровно одну
   * операцию, поэтому добавляемую привязку дописываем в хвост станка
   * (`max(sortOrder) + 10`), а существующие лишь реактивируем. Так
   * порядок операций в `/work` на каждом станке остаётся прежним.
   */
  async updateEquipment(
    operationId: string,
    equipmentIds: string[],
  ): Promise<OperationDetailDto> {
    const operation = await this.prisma.operation.findUnique({
      where: { id: operationId },
      select: { id: true },
    });
    if (!operation) throw new OperationNotFoundException();

    // Валидируем переданные equipmentId до старта транзакции — так
    // диагностируем «битый» id одной 404 вместо общей FK-ошибки.
    if (equipmentIds.length > 0) {
      const found = await this.prisma.equipment.findMany({
        where: { id: { in: equipmentIds } },
        select: { id: true },
      });
      if (found.length !== equipmentIds.length) {
        throw new EquipmentNotFoundException();
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.equipmentOperation.findMany({
        where: { operationId },
        select: { id: true, equipmentId: true },
      });
      const wantedSet = new Set(equipmentIds);
      const existingSet = new Set(existing.map((e) => e.equipmentId));

      const toDelete = existing
        .filter((e) => !wantedSet.has(e.equipmentId))
        .map((e) => e.id);
      if (toDelete.length > 0) {
        await tx.equipmentOperation.deleteMany({
          where: { id: { in: toDelete } },
        });
      }

      for (const equipmentId of equipmentIds) {
        if (existingSet.has(equipmentId)) {
          // Уже привязана — только гарантируем активность, порядок на
          // станке не трогаем.
          await tx.equipmentOperation.update({
            where: {
              EquipmentOperation_equipment_operation_uniq: {
                equipmentId,
                operationId,
              },
            },
            data: { isActive: true },
          });
          continue;
        }
        // Новая привязка — дописываем в хвост списка операций станка,
        // чтобы не перетасовать существующий порядок в `/work`.
        const last = await tx.equipmentOperation.findFirst({
          where: { equipmentId },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const sortOrder = (last?.sortOrder ?? 0) + 10;
        await tx.equipmentOperation.create({
          data: { equipmentId, operationId, sortOrder, isActive: true },
        });
      }
    });

    this.logger.log(
      `event=operation.update-equipment id=${operationId} equipment=${equipmentIds.length}`,
    );
    return this.getOne(operationId);
  }

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(dto: CreateOperationDto): Promise<OperationDetailDto> {
    this.assertRatesUnique(dto.ratesBySize);
    this.assertTimeNormsUnique(dto.timeNormsBySize);
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }
    if (dto.timeNormsBySize && dto.timeNormsBySize.length > 0) {
      await this.assertSizesExist(dto.timeNormsBySize.map((r) => r.sizeId));
    }
    const sortOrder =
      dto.sortOrder ?? (await this.nextSortOrder());

    const timeNormMode: TimeNormMode = dto.timeNormMode ?? 'FIXED';
    const timeNormSec =
      timeNormMode === 'FIXED' && dto.timeNormSec != null
        ? dto.timeNormSec
        : null;

    // Плановая окладная стоимость (см. ТЗ «Плановая стоимость
    // окладных операций»). Это **отдельная ось** от pricingMode/
    // timeNormMode и от фактического payroll. Если указана ставка,
    // но не указана длительность смены — подставляем default 28800
    // (8 часов), чтобы UI сразу мог показать «cost per second».
    const salaryPlanRubPerShift =
      dto.salaryPlanRubPerShift != null
        ? new Prisma.Decimal(dto.salaryPlanRubPerShift)
        : null;
    const salaryPlanShiftSeconds = resolveSalaryPlanShiftSeconds(
      dto.salaryPlanShiftSeconds,
      salaryPlanRubPerShift !== null,
    );

    let createdId: string;
    try {
      createdId = await this.prisma.$transaction(async (tx) => {
        const created = await tx.operation.create({
          data: {
            code: dto.code,
            name: dto.name,
            category: dto.category,
            sortOrder,
            active: dto.isActive ?? true,
            pricingMode: dto.pricingMode,
            fixedRate:
              dto.pricingMode === 'FIXED' && dto.fixedRate !== undefined
                ? new Prisma.Decimal(dto.fixedRate)
                : null,
            timeNormMode,
            timeNormSec,
            salaryPlanRubPerShift,
            salaryPlanShiftSeconds,
            producesFinishedGoods: dto.producesFinishedGoods ?? false,
          },
        });
        if (dto.pricingMode === 'BY_SIZE' && dto.ratesBySize?.length) {
          await tx.operationRateBySize.createMany({
            data: dto.ratesBySize.map((r) => ({
              operationId: created.id,
              sizeId: r.sizeId,
              rate: new Prisma.Decimal(r.rate),
            })),
          });
        }
        if (timeNormMode === 'BY_SIZE' && dto.timeNormsBySize?.length) {
          await tx.operationTimeNormBySize.createMany({
            data: dto.timeNormsBySize.map((r) => ({
              operationId: created.id,
              sizeId: r.sizeId,
              seconds: r.seconds,
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
      `event=operation.create id=${createdId} code=${dto.code} ` +
        `mode=${dto.pricingMode} timeMode=${timeNormMode}`,
    );
    return this.getOne(createdId);
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  async update(
    id: string,
    dto: UpdateOperationDto,
  ): Promise<OperationDetailDto> {
    const exists = await this.prisma.operation.findUnique({
      where: { id },
      select: {
        id: true,
        pricingMode: true,
        timeNormMode: true,
        salaryPlanShiftSeconds: true,
      },
    });
    if (!exists) throw new OperationNotFoundException();

    this.assertRatesUnique(dto.ratesBySize);
    this.assertTimeNormsUnique(dto.timeNormsBySize);
    if (dto.ratesBySize && dto.ratesBySize.length > 0) {
      await this.assertSizesExist(dto.ratesBySize.map((r) => r.sizeId));
    }
    if (dto.timeNormsBySize && dto.timeNormsBySize.length > 0) {
      await this.assertSizesExist(dto.timeNormsBySize.map((r) => r.sizeId));
    }

    // Финальный pricingMode: либо явно сменили, либо текущий.
    const nextMode: PricingMode = (dto.pricingMode ??
      exists.pricingMode) as PricingMode;
    // Финальный timeNormMode: либо явно сменили, либо текущий.
    // Это **отдельная ось** от pricingMode.
    const nextTimeMode: TimeNormMode = (dto.timeNormMode ??
      exists.timeNormMode) as TimeNormMode;

    // Доп. валидация переходов и согласованность ставок.
    // Делаем это здесь, а не в Zod, потому что это требует знания
    // текущего pricingMode из БД.
    if (nextMode === 'FIXED' && dto.ratesBySize && dto.ratesBySize.length > 0) {
      throw new OperationRateMissingException('FIXED', '*');
    }
    if (nextMode === 'SALARY_ONLY') {
      if (dto.fixedRate !== undefined && dto.fixedRate !== null) {
        // Защита от перепутанных полей: в SALARY_ONLY ставка не нужна.
        // Тихо обнуляем — UI всё равно её спрятал бы.
        dto.fixedRate = null;
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.OperationUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name;
        if (dto.category !== undefined) data.category = dto.category;
        if (dto.isActive !== undefined) data.active = dto.isActive;
        if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
        if (dto.pricingMode !== undefined) data.pricingMode = dto.pricingMode;
        if (dto.timeNormMode !== undefined) data.timeNormMode = dto.timeNormMode;

        // Согласованность fixedRate с pricingMode:
        //   FIXED       → если пришёл fixedRate, ставим его;
        //   BY_SIZE     → всегда обнуляем fixedRate;
        //   SALARY_ONLY → всегда обнуляем fixedRate.
        if (nextMode === 'FIXED') {
          if (dto.fixedRate !== undefined) {
            data.fixedRate =
              dto.fixedRate === null
                ? null
                : new Prisma.Decimal(dto.fixedRate);
          }
        } else {
          data.fixedRate = null;
        }

        // Согласованность timeNormSec с timeNormMode:
        //   FIXED   → если пришёл timeNormSec, ставим его (включая null);
        //   BY_SIZE → всегда обнуляем timeNormSec.
        if (nextTimeMode === 'FIXED') {
          if (dto.timeNormSec !== undefined) {
            data.timeNormSec = dto.timeNormSec === null ? null : dto.timeNormSec;
          }
        } else {
          data.timeNormSec = null;
        }

        // Плановая окладная ставка (см. ТЗ «Плановая стоимость
        // окладных операций»). Это **отдельная ось** от pricingMode/
        // timeNormMode — поле обновляется независимо. Контракт:
        //   - `salaryPlanRubPerShift = null` → обнулить;
        //   - `salaryPlanRubPerShift = number` → проставить;
        //   - не пришло — не трогать.
        // Длительность смены: если ставка задана, но shift seconds
        // в БД ещё `null`, бэкенд проставляет default 28800 в
        // дополнение, чтобы UI/расчёт плана не упирался в null/0.
        if (dto.salaryPlanRubPerShift !== undefined) {
          data.salaryPlanRubPerShift =
            dto.salaryPlanRubPerShift === null
              ? null
              : new Prisma.Decimal(dto.salaryPlanRubPerShift);
        }
        if (dto.salaryPlanShiftSeconds !== undefined) {
          data.salaryPlanShiftSeconds =
            dto.salaryPlanShiftSeconds === null
              ? 28800
              : dto.salaryPlanShiftSeconds;
        } else if (
          dto.salaryPlanRubPerShift != null &&
          (exists as { salaryPlanShiftSeconds: number | null })
            .salaryPlanShiftSeconds == null
        ) {
          // Ставку только что задали, а длительность смены так и не
          // была проставлена — подставляем default, чтобы расчёт
          // плана сразу заработал.
          data.salaryPlanShiftSeconds = 28800;
        }

        // Признак «операция выпускает готовую продукцию» (см.
        // `prisma/schema.prisma::Operation.producesFinishedGoods`,
        // `FinishedGoodsService.recordPassportOutputInTx`). Принимает
        // `true` / `false`; не пришло — поле не трогаем. Уже выпущенные
        // паспорты не пересоздаются: идемпотентность по
        // `sourceKey = PACKED_PASSPORT:<passportId>` гарантирует
        // ровно одно `FinishedGoodsMovement PRODUCTION_RECEIPT IN`
        // на паспорт.
        if (dto.producesFinishedGoods !== undefined) {
          data.producesFinishedGoods = dto.producesFinishedGoods;
        }

        await tx.operation.update({ where: { id }, data });

        // Согласованность OperationRateBySize:
        //   BY_SIZE с явно переданным ratesBySize → replace-all;
        //   BY_SIZE без ratesBySize, но смена режима с другого → ничего
        //     (менеджер заполнит на следующем шаге; UI это покажет);
        //   FIXED / SALARY_ONLY → стираем все ставки, чтобы инвариант
        //     «BY_SIZE => есть ставки, остальное => нет ставок» жил.
        if (nextMode === 'BY_SIZE') {
          if (dto.ratesBySize !== undefined) {
            await tx.operationRateBySize.deleteMany({
              where: { operationId: id },
            });
            if (dto.ratesBySize.length > 0) {
              await tx.operationRateBySize.createMany({
                data: dto.ratesBySize.map((r) => ({
                  operationId: id,
                  sizeId: r.sizeId,
                  rate: new Prisma.Decimal(r.rate),
                })),
              });
            }
          }
        } else {
          await tx.operationRateBySize.deleteMany({
            where: { operationId: id },
          });
        }

        // Согласованность OperationTimeNormBySize по тому же паттерну,
        // но на отдельной оси `timeNormMode`:
        //   BY_SIZE с явно переданным timeNormsBySize → replace-all;
        //   BY_SIZE без timeNormsBySize и смена режима — оставляем
        //     текущие строки (менеджер заполнит постепенно);
        //   FIXED — стираем все строки, чтобы инвариант
        //     «BY_SIZE => есть нормы, FIXED => нет норм» держался.
        if (nextTimeMode === 'BY_SIZE') {
          if (dto.timeNormsBySize !== undefined) {
            await tx.operationTimeNormBySize.deleteMany({
              where: { operationId: id },
            });
            if (dto.timeNormsBySize.length > 0) {
              await tx.operationTimeNormBySize.createMany({
                data: dto.timeNormsBySize.map((r) => ({
                  operationId: id,
                  sizeId: r.sizeId,
                  seconds: r.seconds,
                })),
              });
            }
          }
        } else {
          await tx.operationTimeNormBySize.deleteMany({
            where: { operationId: id },
          });
        }
      });
    } catch (e) {
      this.translateUniqueError(e);
      throw e;
    }

    this.logger.log(
      `event=operation.update id=${id} mode=${nextMode} timeMode=${nextTimeMode}` +
        (dto.ratesBySize !== undefined
          ? ` rates=${dto.ratesBySize.length}`
          : '') +
        (dto.timeNormsBySize !== undefined
          ? ` timeNorms=${dto.timeNormsBySize.length}`
          : ''),
    );
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // DELETE BLOCKERS (preflight «можно ли физически удалить»)
  // -------------------------------------------------------------------------

  /**
   * Считает все ссылки на операцию, которые делают физическое удаление
   * небезопасным. Пока есть хотя бы одна — `hardDeleteAllowed = false`,
   * и UI должен предлагать деактивацию (`isActive = false`) вместо
   * удаления.
   *
   * Считаем именно «использование», а не конфигурацию: тарифы
   * (`OperationRateBySize`), нормы (`OperationTimeNormBySize`) и
   * привязку к станкам (`EquipmentOperation`) НЕ считаем — у них в
   * схеме `onDelete: Cascade`, они уйдут вместе с операцией.
   * `OperationSubstitution` каскадная, но мы её считаем сознательно:
   * молча оборвать substitute-правило AND-гейта параллельной группы
   * (см. [[project_operation_substitution]]) опаснее, чем тариф.
   *
   * Backend пересчитывает то же самое внутри `remove()`, чтобы между
   * preflight'ом и `DELETE` не проехал race.
   */
  async getBlockers(id: string): Promise<OperationBlockersResponse> {
    const exists = await this.prisma.operation.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new OperationNotFoundException();

    const [
      operationEntries,
      eventsOnOperation,
      eventsFromOperation,
      orderRouteSteps,
      routeTemplateSteps,
      shiftSessions,
      currentPassports,
      masterCalls,
      substitutionsAsSatisfies,
      substitutionsAsSubstitute,
    ] = await Promise.all([
      this.prisma.operationEntry.count({ where: { operationId: id } }),
      this.prisma.passportEvent.count({ where: { operationId: id } }),
      this.prisma.passportEvent.count({ where: { fromOperationId: id } }),
      this.prisma.orderRouteStep.count({ where: { operationId: id } }),
      this.prisma.routeTemplateStep.count({ where: { operationId: id } }),
      this.prisma.shiftSession.count({ where: { operationId: id } }),
      this.prisma.passport.count({ where: { currentOperationId: id } }),
      this.prisma.masterCall.count({ where: { operationId: id } }),
      this.prisma.operationSubstitution.count({
        where: { satisfiesOpId: id },
      }),
      this.prisma.operationSubstitution.count({
        where: { substituteOpId: id },
      }),
    ]);

    const blockers: OperationDeleteBlockerDto[] = [];
    if (operationEntries > 0)
      blockers.push({ kind: 'OperationEntry', count: operationEntries });
    // Оба направления события паспорта консолидируем в одну строку:
    // оператору важно «есть ли история событий», а не разбивка по
    // `operationId` / `fromOperationId`.
    const passportEvents = eventsOnOperation + eventsFromOperation;
    if (passportEvents > 0)
      blockers.push({ kind: 'PassportEvent', count: passportEvents });
    if (orderRouteSteps > 0)
      blockers.push({ kind: 'OrderRouteStep', count: orderRouteSteps });
    if (routeTemplateSteps > 0)
      blockers.push({ kind: 'RouteTemplateStep', count: routeTemplateSteps });
    if (shiftSessions > 0)
      blockers.push({ kind: 'ShiftSession', count: shiftSessions });
    if (currentPassports > 0)
      blockers.push({ kind: 'CurrentPassport', count: currentPassports });
    if (masterCalls > 0)
      blockers.push({ kind: 'MasterCall', count: masterCalls });
    const substitutions =
      substitutionsAsSatisfies + substitutionsAsSubstitute;
    if (substitutions > 0)
      blockers.push({ kind: 'OperationSubstitution', count: substitutions });

    return {
      hardDeleteAllowed: blockers.length === 0,
      blockers,
    };
  }

  // -------------------------------------------------------------------------
  // REMOVE (физическое удаление — только для пустых операций)
  // -------------------------------------------------------------------------

  /**
   * Физическое удаление операции. Разрешено только когда `getBlockers`
   * не нашёл ни одной ссылки (сценарий «создал по ошибке, нигде не
   * использовал»). Иначе — `OperationInUseException` (409), и менеджер
   * деактивирует операцию вместо удаления.
   *
   * Внутри транзакции каскад БД (`onDelete: Cascade`) сам снимает
   * конфигурацию — `OperationRateBySize`, `OperationTimeNormBySize`,
   * `EquipmentOperation` (и формально `OperationSubstitution`, но до
   * сюда мы доходим только если их 0). Снимок удалённой операции
   * остаётся в `AuditLog` (`OPERATION_DELETED`).
   *
   * RBAC (`ADMIN`-only) проверяется в контроллере; `viewer` нужен
   * только чтобы проставить `employeeId` в аудит.
   */
  async remove(id: string, viewer: AuthPrincipal): Promise<void> {
    const target = await this.prisma.operation.findUnique({
      where: { id },
      select: { id: true, code: true, name: true, category: true },
    });
    if (!target) throw new OperationNotFoundException();

    const { hardDeleteAllowed } = await this.getBlockers(id);
    if (!hardDeleteAllowed) {
      throw new OperationInUseException();
    }

    await this.prisma.$transaction(async (tx) => {
      // Аудит ДО delete — снимок ключевых полей, чтобы расследование
      // «куда делась операция X» имело за что зацепиться.
      await this.audit.log(
        {
          event: 'OPERATION_DELETED',
          entityType: 'OPERATION',
          entityId: id,
          payload: {
            targetSnapshot: {
              code: target.code,
              name: target.name,
              category: target.category,
            },
          },
          employeeId: viewer.employeeId,
        },
        tx,
      );
      await tx.operation.delete({ where: { id } });
    });

    this.logger.log(
      `event=operation.delete id=${id} code=${target.code} actor=${viewer.employeeId}`,
    );
  }

  // -------------------------------------------------------------------------
  // RESOLVE RATE (источник истины для сдельных начислений)
  // -------------------------------------------------------------------------

  /**
   * Возвращает ставку за единицу для операции в зависимости от её
   * `pricingMode`. Контракт:
   *
   *   - `FIXED` → `Operation.fixedRate` (если `null` — это
   *     невалидная конфигурация, бросаем `OperationRateMissingException`);
   *   - `BY_SIZE` → строка `OperationRateBySize` для (operationId, sizeId);
   *     если её нет — `OperationRateMissingException`;
   *   - `SALARY_ONLY` → `null` (вызывающий код должен пропустить
   *     создание piece-rate начисления).
   *
   * Принимает опциональный `tx`, чтобы вызываться из той же транзакции,
   * что и создание `OperationEntry`. В EarningsService это критично —
   * см. ADR-0012 и `EarningsService.createImmediateForCutter`.
   *
   * `orderId` (опционально): если передан, расценка сначала ищется в
   * per-order переопределениях snapshot-а маршрута заказа, и только
   * затем берётся дефолт операции:
   *   - `FIXED`   → `OrderRouteStep.rateOverride` (по паре
   *     orderId+operationId) вытесняет `Operation.fixedRate`;
   *   - `BY_SIZE` → `OrderRouteStepSizeOverride.rate` (по шагу заказа и
   *     размеру) вытесняет `OperationRateBySize`.
   * Это «цена операции внутри заказа»: одна операция «Оверлок» на всю
   * систему, но в конкретном тираже своя расценка — справочник операции
   * при этом НЕ меняется. Для `SALARY_ONLY` сделки нет (оклад).
   */
  async resolveRate(
    operationId: string,
    sizeId: string,
    tx?: Prisma.TransactionClient,
    orderId?: string | null,
  ): Promise<Prisma.Decimal | null> {
    const client: Prisma.TransactionClient | PrismaService = tx ?? this.prisma;
    const op = await client.operation.findUnique({
      where: { id: operationId },
      select: { id: true, code: true, pricingMode: true, fixedRate: true },
    });
    if (!op) throw new OperationNotFoundException();

    // Снимок маршрута заказа может переопределять для этой операции и
    // СПОСОБ ОПЛАТЫ (оклад ⇄ сделка, `pricingModeOverride`), и расценку
    // (`rateOverride` / поразмерный `OrderRouteStepSizeOverride.rate`).
    // Действует только внутри заказа — справочник операции не трогается.
    // `findFirst`, а не `findUnique`: на `OrderRouteStep` нет уникального
    // индекса (orderId, operationId), но операция в маршруте встречается
    // не более одного раза. Поразмерный оверрайд берём сразу по `sizeId`.
    const override = orderId
      ? await client.orderRouteStep.findFirst({
          where: { orderId, operationId },
          select: {
            pricingModeOverride: true,
            rateOverride: true,
            sizeOverrides: { where: { sizeId }, select: { rate: true } },
          },
        })
      : null;

    // Эффективный режим расчёта денег: оверрайд заказа вытесняет дефолт
    // операции.
    const mode = override?.pricingModeOverride ?? op.pricingMode;

    if (mode === 'SALARY_ONLY') return null;

    if (mode === 'FIXED') {
      const rate = override?.rateOverride ?? op.fixedRate;
      if (!rate) {
        const sz = await client.size.findUnique({
          where: { id: sizeId },
          select: { code: true },
        });
        throw new OperationRateMissingException(op.code, sz?.code ?? sizeId);
      }
      return rate;
    }

    // BY_SIZE: сначала поразмерное переопределение заказа
    // (`OrderRouteStepSizeOverride.rate`), далее дефолт операции
    // (`OperationRateBySize`).
    const sizeOverrideRate = override?.sizeOverrides?.[0]?.rate ?? null;
    if (sizeOverrideRate != null) return sizeOverrideRate;

    const row = await client.operationRateBySize.findUnique({
      where: {
        OperationRateBySize_operation_size_uniq: {
          operationId,
          sizeId,
        },
      },
      select: { rate: true },
    });
    if (!row) {
      const sz = await client.size.findUnique({
        where: { id: sizeId },
        select: { code: true },
      });
      throw new OperationRateMissingException(op.code, sz?.code ?? sizeId);
    }
    return row.rate;
  }

  // -------------------------------------------------------------------------
  // RESOLVE SALARY PLAN COST PER SECOND (плановая себестоимость
  // окладных операций; см. ТЗ «Плановая стоимость окладных операций»)
  // -------------------------------------------------------------------------

  /**
   * Возвращает плановую стоимость 1 секунды операции для расчёта
   * **плановой** себестоимости окладных операций
   * (`pricingMode = SALARY_ONLY`). Это не фактическая зарплата —
   * payroll (`SalaryService`, `EarningsService`,
   * `Employee.salaryPerShift`) этой формулы не использует.
   *
   * Контракт:
   *   - `salaryPlanRubPerShift = null` → `null` (план для окладных
   *     операций пропускается; `OrderOperationPlanService` ставит
   *     `cost = 0` + warning);
   *   - `salaryPlanRubPerShift > 0` и `salaryPlanShiftSeconds > 0` →
   *     `Decimal(salaryPlanRubPerShift) / salaryPlanShiftSeconds`;
   *   - `salaryPlanRubPerShift > 0`, но `salaryPlanShiftSeconds`
   *     `null/0` → fallback на 28800 (default «8-часовая смена»),
   *     чтобы не блокировать план.
   *
   * Возвращает `Prisma.Decimal | null`, чтобы вызывающий код мог
   * умножить на (timeSec × qty) без потери точности.
   */
  resolveSalaryPlanCostPerSecond(operation: {
    salaryPlanRubPerShift: Prisma.Decimal | null;
    salaryPlanShiftSeconds: number | null;
  }): Prisma.Decimal | null {
    if (operation.salaryPlanRubPerShift == null) return null;
    const shiftSec =
      operation.salaryPlanShiftSeconds && operation.salaryPlanShiftSeconds > 0
        ? operation.salaryPlanShiftSeconds
        : 28800;
    return operation.salaryPlanRubPerShift.div(shiftSec);
  }

  // -------------------------------------------------------------------------
  // RESOLVE TIME NORM (источник истины для плана времени)
  // -------------------------------------------------------------------------

  /**
   * Возвращает плановую норму времени операции в зависимости от её
   * `timeNormMode`. Это **отдельная ось** от `resolveRate(...)` —
   * payroll этим методом не пользуется. Контракт сознательно мягче,
   * чем у `resolveRate`: вместо exception «нормы нет» — возвращаем
   * `null`. Заказ не должен блокироваться отсутствием плановой нормы
   * (см. `docs/operation-time-norms-recon.md §11`):
   *
   *   - `FIXED`   → `Operation.timeNormSec ?? null`;
   *   - `BY_SIZE` → `OperationTimeNormBySize.seconds` для пары или `null`.
   *
   * Если операции не существует — `OperationNotFoundException`
   * (по тому же стилю, что и `resolveRate`).
   *
   * Принимает опциональный `tx`, чтобы вызываться из той же транзакции,
   * что и расчёт плана заказа (см. recon §11).
   */
  async resolveTimeNormSec(
    operationId: string,
    sizeId: string,
    tx?: Prisma.TransactionClient,
    orderId?: string | null,
  ): Promise<number | null> {
    const client: Prisma.TransactionClient | PrismaService = tx ?? this.prisma;
    const op = await client.operation.findUnique({
      where: { id: operationId },
      select: { id: true, timeNormMode: true, timeNormSec: true },
    });
    if (!op) throw new OperationNotFoundException();

    if (op.timeNormMode === 'FIXED') {
      // Переопределение нормы времени внутри заказа (snapshot маршрута)
      // вытесняет дефолт операции; справочник операции не трогается.
      if (orderId) {
        const override = await client.orderRouteStep.findFirst({
          where: { orderId, operationId, timeNormSecOverride: { not: null } },
          select: { timeNormSecOverride: true },
        });
        if (override?.timeNormSecOverride != null) {
          return override.timeNormSecOverride;
        }
      }
      return op.timeNormSec ?? null;
    }

    // BY_SIZE: поразмерное переопределение заказа, затем дефолт операции.
    if (orderId) {
      const override = await client.orderRouteStepSizeOverride.findFirst({
        where: {
          sizeId,
          seconds: { not: null },
          routeStep: { orderId, operationId },
        },
        select: { seconds: true },
      });
      if (override?.seconds != null) return override.seconds;
    }

    const row = await client.operationTimeNormBySize.findUnique({
      where: {
        OperationTimeNormBySize_operation_size_uniq: {
          operationId,
          sizeId,
        },
      },
      select: { seconds: true },
    });
    return row?.seconds ?? null;
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private toSummary(
    row: {
      id: string;
      code: string;
      name: string;
      category: string;
      pricingMode: string;
      fixedRate: Prisma.Decimal | null;
      active: boolean;
      sortOrder: number;
      createdAt: Date;
      updatedAt: Date;
      timeNormMode: string;
      timeNormSec: number | null;
      salaryPlanRubPerShift: Prisma.Decimal | null;
      salaryPlanShiftSeconds: number | null;
      producesFinishedGoods: boolean;
    },
    ratesBySizeCount: number,
    timeNormsBySizeCount: number,
  ): OperationSummaryDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category as OperationSummaryDto['category'],
      pricingMode: row.pricingMode as OperationSummaryDto['pricingMode'],
      fixedRate: row.fixedRate ? Number(row.fixedRate.toFixed(2)) : null,
      ratesBySizeCount,
      isActive: row.active,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      timeNormMode: row.timeNormMode as OperationSummaryDto['timeNormMode'],
      timeNormSec: row.timeNormSec ?? null,
      timeNormsBySizeCount,
      salaryPlanRubPerShift: row.salaryPlanRubPerShift
        ? Number(row.salaryPlanRubPerShift.toFixed(2))
        : null,
      salaryPlanShiftSeconds: row.salaryPlanShiftSeconds ?? null,
      producesFinishedGoods: row.producesFinishedGoods,
    };
  }

  private async nextSortOrder(): Promise<number> {
    const max = await this.prisma.operation.aggregate({
      _max: { sortOrder: true },
    });
    return (max._max.sortOrder ?? 0) + 10;
  }

  private assertRatesUnique(
    rates: Array<{ sizeId: string }> | undefined,
  ): void {
    if (!rates) return;
    const seen = new Set<string>();
    for (const r of rates) {
      if (seen.has(r.sizeId)) {
        throw new OperationRateDuplicateSizeException(r.sizeId);
      }
      seen.add(r.sizeId);
    }
  }

  private assertTimeNormsUnique(
    norms: Array<{ sizeId: string }> | undefined,
  ): void {
    if (!norms) return;
    const seen = new Set<string>();
    for (const r of norms) {
      if (seen.has(r.sizeId)) {
        throw new OperationRateDuplicateSizeException(r.sizeId);
      }
      seen.add(r.sizeId);
    }
  }

  private async assertSizesExist(sizeIds: string[]): Promise<void> {
    const found = await this.prisma.size.findMany({
      where: { id: { in: sizeIds } },
      select: { id: true },
    });
    const foundSet = new Set(found.map((s) => s.id));
    for (const id of sizeIds) {
      if (!foundSet.has(id)) {
        throw new OperationRateSizeNotFoundException(id);
      }
    }
  }

  private translateUniqueError(e: unknown): void {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      const target = (e.meta?.target as string[] | string | undefined) ?? [];
      const fields = Array.isArray(target) ? target : [target];
      if (fields.some((f) => String(f).includes('code'))) {
        throw new OperationCodeTakenException();
      }
    }
  }
}

/**
 * Привести `salaryPlanShiftSeconds` из DTO к значению, которое уйдёт
 * в БД на `create()`. Контракт:
 *   - DTO явно прислал число > 0 → используем его;
 *   - DTO прислал `null` → `28800` (default; это безопасно даже без
 *     ставки, потому что shift seconds одиночно не имеет смысла);
 *   - DTO опустил поле → `28800` если ставка задана, иначе оставим
 *     `null` — DDL-default (`28800`) сработает в Postgres.
 *
 * Прямо в Prisma поле `default(28800)` стоит, но Prisma client при
 * `data.salaryPlanShiftSeconds = undefined` всё равно опускает
 * колонку — это тот случай, когда database default сработает
 * корректно. Возвращаем `null` (а не `undefined`), чтобы Prisma
 * проинтерпретировала это как «оставь как есть в БД» только когда
 * нам это нужно — в `create()` мы хотим явный default.
 */
function resolveSalaryPlanShiftSeconds(
  dtoValue: number | null | undefined,
  hasRate: boolean,
): number | null {
  if (dtoValue !== undefined && dtoValue !== null && dtoValue > 0) {
    return dtoValue;
  }
  if (dtoValue === null) return 28800;
  // dtoValue === undefined: оставляем default БД, но если ставка
  // указана — лучше явно проставить 28800, чтобы UI не путался.
  return hasRate ? 28800 : null;
}
