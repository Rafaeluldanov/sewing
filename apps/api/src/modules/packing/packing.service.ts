import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  OperationCategory,
  PassportEventType,
  PassportStatus,
} from '@prisma/client';
import type {
  AddPassportToBoxDto,
  BoxDetailDto,
  BoxItemDto,
  BoxListItemDto,
  BoxStatus,
  BoxesPage,
  CreateBoxDto,
  ListBoxesQuery,
  PlaceBoxDto,
} from '@sewing/shared/packing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BoxAlreadyPlacedException,
  BoxCapacityExceededException,
  BoxClosedException,
  BoxEmptyCloseException,
  BoxHomogeneityViolatedException,
  BoxNotClosedForPlacementException,
  BoxNotFoundException,
  CellInactiveException,
  CellNotFoundException,
  EmployeeInactiveException,
  EmployeeNotFoundException,
  PackingShiftRequiredException,
  PassportAlreadyPackedException,
  PassportCancelledException,
  PassportNotPackableException,
} from '../../common/errors.js';
import { BoxNumberService } from './box-number.service.js';
import { getApiUrl } from '../passports/qr.js';
import { EarningsService } from '../earnings/earnings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { FinishedGoodsService } from '../finished-goods/finished-goods.service.js';

type BoxRow = Prisma.BoxGetPayload<{
  include: {
    createdBy: { select: { id: true; fullName: true } };
    placedInCell: { select: { id: true; code: true } };
    items: {
      include: {
        passport: {
          include: {
            order: { select: { id: true; number: true } };
            product: { select: { name: true } };
            size: true;
          };
        };
      };
    };
  };
}>;

/**
 * Сервис упаковки и выпуска изделия (Шаг 8 MVP).
 *
 * Контракт `docs/api.md §9`. Бизнес-правила — `docs/flows.md §F7`,
 * события — `docs/events.md §PACKED`. Архитектура — ADR-0011.
 *
 * Ключевые инварианты:
 *   - в коробке могут лежать только паспорта одного изделия/цвета/размера
 *     (см. ADR-0011);
 *   - один паспорт может попасть только в одну коробку (UNIQUE
 *     `BoxItem(boxId, passportId)` + проверка на статус `PACKED`);
 *   - добавление паспорта = выпуск изделия: `Passport.status` становится
 *     `PACKED`, фиксируется `PassportEvent(PACKED)`,
 *     `Box.totalQty += passport.qtyGood`;
 *   - закрытие коробки запрещает любые добавления, но статус паспорта
 *     при добавлении уже терминальный — повторно «выпускать» изделие
 *     при закрытии не нужно (см. ADR-0011 §5);
 *   - **закрытие коробки = финальный completion event цепочки**: ровно
 *     в этот момент `EarningsService.approvePendingForPassport` финализирует
 *     все pending-начисления по каждому упакованному паспорту в этой
 *     коробке (см. ADR-0005 §«Подтверждение», `docs/flows.md §F7`).
 *     Идемпотентно: повторный close уже не доходит до апрува —
 *     `BoxClosedException` отрабатывает раньше, а сама `updateMany`
 *     фильтрует только `PENDING_RELEASE`/legacy `PENDING`.
 */
@Injectable()
export class PackingService {
  private readonly logger = new Logger(PackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbers: BoxNumberService,
    private readonly earnings: EarningsService,
    private readonly audit: AuditService,
    private readonly finishedGoods: FinishedGoodsService,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  async create(
    dto: CreateBoxDto,
    actorEmployeeId: string,
  ): Promise<BoxDetailDto> {
    await this.assertPackingActor(actorEmployeeId);

    const id = await this.prisma.$transaction(async (tx) => {
      const number = await this.numbers.nextNumber(tx);
      const created = await tx.box.create({
        data: {
          number,
          // qrCode UNIQUE — финальный `box:{id}` проставим вторым шагом.
          qrCode: `box-pending:${number}`,
          totalQty: 0,
          maxQty: dto.maxQty ?? 100,
          createdById: actorEmployeeId,
        },
      });
      await tx.box.update({
        where: { id: created.id },
        data: { qrCode: `box:${created.id}` },
      });
      return created.id;
    });
    return this.getOne(id);
  }

  // -------------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------------

  async list(query: ListBoxesQuery): Promise<BoxesPage> {
    const where: Prisma.BoxWhereInput = {};
    if (query.status === 'OPEN') where.closedAt = null;
    if (query.status === 'CLOSED') where.closedAt = { not: null };
    // Фильтр размещения: упаковочный терминал на Stage 1 показывает
    // closed-but-not-placed коробки через `?status=CLOSED&placed=false`.
    if (query.placed === true) where.placedAt = { not: null };
    if (query.placed === false) where.placedAt = null;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.box.count({ where }),
      this.prisma.box.findMany({
        where,
        include: {
          createdBy: { select: { id: true, fullName: true } },
          placedInCell: { select: { id: true, code: true } },
          items: {
            include: {
              passport: {
                include: {
                  order: { select: { id: true, number: true } },
                  product: { select: { name: true } },
                  size: true,
                },
              },
            },
          },
        },
        orderBy: [{ closedAt: 'asc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items: rows.map((r) => this.toListItem(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // -------------------------------------------------------------------------
  // GET ONE
  // -------------------------------------------------------------------------

  async getOne(id: string): Promise<BoxDetailDto> {
    const row = await this.loadBox(id);
    return this.toDetail(row);
  }

  // -------------------------------------------------------------------------
  // LOOKUP по коду коробки (свободный ввод/QR `box:{id}` + номер)
  // -------------------------------------------------------------------------

  async findByCode(code: string): Promise<BoxDetailDto> {
    const trimmed = code.trim();
    const idFromQr = trimmed.startsWith('box:')
      ? trimmed.slice('box:'.length)
      : trimmed;

    const row = await this.prisma.box.findFirst({
      where: {
        OR: [
          { id: idFromQr },
          { qrCode: trimmed },
          { number: trimmed },
        ],
      },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'BOX_NOT_FOUND',
        message: `Коробка не найдена по коду «${trimmed}»`,
      });
    }
    return this.getOne(row.id);
  }

  // -------------------------------------------------------------------------
  // ADD PASSPORT
  // -------------------------------------------------------------------------

  async addPassport(
    boxId: string,
    dto: AddPassportToBoxDto,
    actorEmployeeId: string,
  ): Promise<BoxDetailDto> {
    await this.assertPackingActor(actorEmployeeId);

    const passport = await this.resolvePassport(dto);

    // Терминальные статусы паспорта.
    if (passport.status === PassportStatus.PACKED) {
      throw new PassportAlreadyPackedException();
    }
    if (passport.status === PassportStatus.CANCELLED) {
      throw new PassportCancelledException();
    }
    // Доступность: только живые паспорта с положительным остатком годных.
    if (
      passport.status !== PassportStatus.IN_PROGRESS ||
      passport.qtyGood <= 0
    ) {
      throw new PassportNotPackableException();
    }

    await this.prisma.$transaction(async (tx) => {
      // Перечитываем коробку и паспорт под локом транзакции.
      const box = await tx.box.findUnique({
        where: { id: boxId },
        include: {
          items: {
            include: {
              passport: {
                select: {
                  productId: true,
                  sizeId: true,
                  color: true,
                },
              },
            },
          },
        },
      });
      if (!box) throw new BoxNotFoundException();
      if (box.closedAt) throw new BoxClosedException();

      const fresh = await tx.passport.findUnique({
        where: { id: passport.id },
        select: {
          id: true,
          status: true,
          qtyGood: true,
          productId: true,
          sizeId: true,
          color: true,
        },
      });
      if (!fresh) throw new PassportNotPackableException();
      if (fresh.status === PassportStatus.PACKED) {
        throw new PassportAlreadyPackedException();
      }
      if (fresh.status === PassportStatus.CANCELLED) {
        throw new PassportCancelledException();
      }
      if (
        fresh.status !== PassportStatus.IN_PROGRESS ||
        fresh.qtyGood <= 0
      ) {
        throw new PassportNotPackableException();
      }

      // Однородность коробки (см. ADR-0011 §3).
      if (box.items.length > 0) {
        const ref = box.items[0].passport;
        if (
          ref.productId !== fresh.productId ||
          ref.sizeId !== fresh.sizeId ||
          ref.color !== fresh.color
        ) {
          throw new BoxHomogeneityViolatedException();
        }
      }

      // Capacity.
      const remaining = box.maxQty - box.totalQty;
      if (fresh.qtyGood > remaining) {
        throw new BoxCapacityExceededException(Math.max(remaining, 0));
      }

      await tx.boxItem.create({
        data: {
          boxId: box.id,
          passportId: fresh.id,
          qty: fresh.qtyGood,
        },
      });
      await tx.box.update({
        where: { id: box.id },
        data: { totalQty: { increment: fresh.qtyGood } },
      });
      await tx.passport.update({
        where: { id: fresh.id },
        data: {
          status: PassportStatus.PACKED,
          // Освобождаем «активные» ссылки: упакованный паспорт ни у кого
          // на руках, ни в ячейке. `currentOperationId` оставляем — это
          // удобный «последний след» для отчётности.
          currentEmployeeId: null,
          currentCellId: null,
        },
      });
      await tx.passportEvent.create({
        data: {
          passportId: fresh.id,
          type: PassportEventType.PACKED,
          boxId: box.id,
          employeeId: actorEmployeeId,
          qty: fresh.qtyGood,
        },
      });
      // Audit (см. `docs/domain.md §«Audit log»`): фиксируем
      // упаковку — это терминальный шаг для паспорта и точка, после
      // которой меняются денормализованные `Order.qtyFinishedTotal` и
      // pending-начисления (после close()). entityType=PACKING, чтобы
      // лента «история коробки» собиралась по `entityId = boxId`.
      await this.audit.log(
        {
          event: 'PASSPORT_PACKED',
          entityType: 'PACKING',
          entityId: box.id,
          employeeId: actorEmployeeId,
          payload: {
            boxId: box.id,
            passportId: fresh.id,
            sizeId: fresh.sizeId,
            qty: fresh.qtyGood,
          },
        },
        tx,
      );
      // Foundation готовой продукции (см.
      // `apps/api/src/modules/finished-goods/finished-goods.service.ts`,
      // `prisma/schema.prisma::FinishedGoodsBalance` /
      // `FinishedGoodsMovement`,
      // `docs/current-state.md §«Готовая продукция»`).
      //
      // В этой же транзакции, что и `Passport.status → PACKED`,
      // фиксируем выпуск готовой продукции (`PRODUCTION_RECEIPT IN`,
      // qty = passport.qtyGood, склад = Order.finishedGoodsWarehouseId
      // или null). Идемпотентно по
      // `sourceKey = PACKED_PASSPORT:<passportId>` — повторная
      // обработка PACKED не задвоит движение и не удвоит баланс.
      // Это **отдельный контур** от материалов: ни StockBalance, ни
      // StockMovement, ни MaterialIssue не затрагиваются.
      await this.finishedGoods.recordPackedPassportInTx(
        tx,
        fresh.id,
        actorEmployeeId,
        box.id,
      );
      // Финальный апрув начислений всем участникам цепочки по этому
      // паспорту перенесён на закрытие коробки (см. `close()` ниже и
      // ADR-0005 §«Подтверждение», обновлённое в рамках scan-driven
      // packing terminal). Здесь начисления остаются `PENDING_RELEASE`
      // — упаковщик закроет коробку и зафиксирует выплату всем сразу.
      // Дополнительные начисления для упаковщика не создаём — упаковка
      // на MVP оплачивается окладом.
    });

    // Шаг 12 / Pilot Rollout — структурированный лог упаковки.
    this.logger.log(
      `event=packing.add boxId=${boxId} passportId=${passport.id} qty=${passport.qtyGood} actorId=${actorEmployeeId}`,
    );
    return this.getOne(boxId);
  }

  // -------------------------------------------------------------------------
  // CLOSE
  // -------------------------------------------------------------------------

  async close(
    boxId: string,
    actorEmployeeId: string,
  ): Promise<BoxDetailDto> {
    await this.assertPackingActor(actorEmployeeId);

    await this.prisma.$transaction(async (tx) => {
      const box = await tx.box.findUnique({
        where: { id: boxId },
        select: { id: true, closedAt: true, totalQty: true },
      });
      if (!box) throw new BoxNotFoundException();
      if (box.closedAt) throw new BoxClosedException();
      if (box.totalQty <= 0) throw new BoxEmptyCloseException();
      await tx.box.update({
        where: { id: box.id },
        data: { closedAt: new Date() },
      });
      // Финальный шаг цепочки (см. ADR-0005, ADR-0011 §5,
      // `docs/flows.md §F7`): по факту закрытия коробки апрувим
      // pending-начисления всем участникам по каждому упакованному
      // паспорту. Делается ровно здесь, чтобы scan-driven
      // packing-терминал имел единый «final completion event».
      // Идемпотентно: `BoxClosedException` выше не даст вызвать апрув
      // повторно, а сама `approvePendingForPassport` фильтрует только
      // PENDING_RELEASE/legacy PENDING.
      const items = await tx.boxItem.findMany({
        where: { boxId: box.id },
        select: { passportId: true },
      });
      for (const item of items) {
        await this.earnings.approvePendingForPassport(tx, item.passportId);
      }
      // Audit (см. `docs/domain.md §«Audit log»`): закрытие коробки —
      // финальный completion event цепочки; именно в этот момент
      // pending-начисления становятся APPROVED и коробка считается
      // выпущенной. payload содержит totalQty и список упакованных
      // паспортов — этого достаточно для разбора инцидента «кому
      // зачислили деньги после такого-то close-а».
      await this.audit.log(
        {
          event: 'BOX_CLOSED',
          entityType: 'PACKING',
          entityId: box.id,
          employeeId: actorEmployeeId,
          payload: {
            boxId: box.id,
            totalQty: box.totalQty,
            passportIds: items.map((i) => i.passportId),
          },
        },
        tx,
      );
    });

    return this.getOne(boxId);
  }

  // -------------------------------------------------------------------------
  // PLACE (размещение коробки в ячейку)
  // -------------------------------------------------------------------------

  /**
   * Размещение закрытой коробки в ячейку склада. После этой операции
   * коробка пропадает из списка «ждут размещения» в терминале
   * упаковщика (`?placed=false&status=CLOSED`).
   *
   * Бизнес-инварианты:
   *   - размещать можно только закрытые коробки (есть `closedAt`),
   *     иначе `BoxNotClosedForPlacementException`;
   *   - повторное размещение запрещено — `BoxAlreadyPlacedException`;
   *   - ячейка должна существовать и быть активной (`CellNotFound` /
   *     `CellInactive`).
   *
   * `dto.code` принимает QR-payload `cell:<id>`, `Cell.code` или
   * `Cell.qrCode` — flow совпадает с `findCellByCode`.
   *
   * Аудит/события: на MVP отдельного `PassportEvent` не пишем —
   * перемещение «коробка → ячейка» — это управленческая фиксация,
   * а не движение паспорта (паспорта уже PACKED). Если позже
   * понадобится — добавим `BOX_PLACED` event без миграции схемы.
   */
  async place(
    boxId: string,
    dto: PlaceBoxDto,
    actorEmployeeId: string,
  ): Promise<BoxDetailDto> {
    // Резолвим сотрудника отдельно от транзакции — единственная
    // цель валидации тут «не дать заблокированному пользователю
    // размещать коробки» (мы доверяем session-cookie, но проверяем
    // active=true).
    const actor = await this.prisma.employee.findUnique({
      where: { id: actorEmployeeId },
      select: { id: true, active: true },
    });
    if (!actor) throw new EmployeeNotFoundException();
    if (!actor.active) throw new EmployeeInactiveException();

    // Резолвим ячейку. Поддерживаем все три формы — `cellId`,
    // QR-payload `cell:<id>` или код ячейки.
    let cellId: string | null = null;
    if (dto.cellId) cellId = dto.cellId;
    else if (dto.code) {
      const trimmed = dto.code.trim();
      const fromQr = trimmed.startsWith('cell:')
        ? trimmed.slice('cell:'.length)
        : trimmed;
      const cell = await this.prisma.cell.findFirst({
        where: {
          OR: [{ id: fromQr }, { qrCode: trimmed }, { code: trimmed }],
        },
        select: { id: true, active: true },
      });
      if (!cell) throw new CellNotFoundException();
      if (!cell.active) throw new CellInactiveException();
      cellId = cell.id;
    }
    if (!cellId) throw new CellNotFoundException();

    // Проверяем активность ячейки даже если cellId передан явно —
    // защита от устаревших ссылок.
    const cell = await this.prisma.cell.findUnique({
      where: { id: cellId },
      select: { id: true, active: true },
    });
    if (!cell) throw new CellNotFoundException();
    if (!cell.active) throw new CellInactiveException();

    await this.prisma.$transaction(async (tx) => {
      const box = await tx.box.findUnique({
        where: { id: boxId },
        select: { id: true, closedAt: true, placedAt: true },
      });
      if (!box) throw new BoxNotFoundException();
      if (!box.closedAt) throw new BoxNotClosedForPlacementException();
      if (box.placedAt) throw new BoxAlreadyPlacedException();
      await tx.box.update({
        where: { id: box.id },
        data: { placedAt: new Date(), placedInCellId: cellId },
      });
    });

    this.logger.log(
      `event=packing.place boxId=${boxId} cellId=${cellId} actorId=${actorEmployeeId}`,
    );
    return this.getOne(boxId);
  }

  // -------------------------------------------------------------------------
  // INTERNAL
  // -------------------------------------------------------------------------

  private async loadBox(id: string): Promise<BoxRow> {
    const row = await this.prisma.box.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, fullName: true } },
        placedInCell: { select: { id: true, code: true } },
        items: {
          include: {
            passport: {
              include: {
                order: { select: { id: true, number: true } },
                product: { select: { name: true } },
                size: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) throw new BoxNotFoundException();
    return row;
  }

  private async resolvePassport(dto: AddPassportToBoxDto) {
    if (dto.passportId) {
      const p = await this.prisma.passport.findUnique({
        where: { id: dto.passportId },
        select: {
          id: true,
          status: true,
          qtyGood: true,
        },
      });
      if (!p) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'PASSPORT_NOT_FOUND',
          message: 'Паспорт не найден',
        });
      }
      return p;
    }
    const code = (dto.code ?? '').trim();
    const idFromQr = code.startsWith('passport:')
      ? code.slice('passport:'.length)
      : code;
    const p = await this.prisma.passport.findFirst({
      where: {
        OR: [{ id: idFromQr }, { qrCode: code }, { number: code }],
      },
      select: {
        id: true,
        status: true,
        qtyGood: true,
      },
    });
    if (!p) {
      throw new NotFoundException({
        statusCode: 404,
        code: 'PASSPORT_NOT_FOUND',
        message: `Паспорт не найден по коду «${code}»`,
      });
    }
    return p;
  }

  /**
   * Soft-проверка актёра (см. `PackingShiftRequiredException`):
   * пользователь должен существовать, быть активным и иметь активную
   * смену с операцией категории `PACKING`. Без полноценного auth это
   * единственный способ убедиться, что упаковкой занят упаковщик.
   */
  private async assertPackingActor(employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, active: true },
    });
    if (!employee) throw new EmployeeNotFoundException();
    if (!employee.active) throw new EmployeeInactiveException();

    const session = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      include: { operation: { select: { category: true } } },
    });
    if (!session || session.operation.category !== OperationCategory.PACKING) {
      throw new PackingShiftRequiredException();
    }
  }

  private toListItem(row: BoxRow): BoxListItemDto {
    const status: BoxStatus = row.closedAt ? 'CLOSED' : 'OPEN';
    return {
      id: row.id,
      number: row.number,
      qrCode: row.qrCode,
      status,
      totalQty: row.totalQty,
      maxQty: row.maxQty,
      itemsCount: row.items.length,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      createdById: row.createdBy.id,
      createdByName: row.createdBy.fullName,
      placedAt: row.placedAt ? row.placedAt.toISOString() : null,
      placedInCell: row.placedInCell
        ? { id: row.placedInCell.id, code: row.placedInCell.code }
        : null,
    };
  }

  private toDetail(row: BoxRow): BoxDetailDto {
    const base = this.toListItem(row);
    const items: BoxItemDto[] = row.items.map((it) => ({
      id: it.id,
      passportId: it.passportId,
      passportNumber: it.passport.number,
      productName: it.passport.product.name,
      color: it.passport.color,
      sizeId: it.passport.sizeId,
      sizeCode: it.passport.size.code,
      sizeSortOrder: it.passport.size.sortOrder,
      qty: it.qty,
      orderId: it.passport.order.id,
      orderNumber: it.passport.order.number,
      createdAt: it.createdAt.toISOString(),
    }));
    items.sort(
      (a, b) =>
        a.sizeSortOrder - b.sizeSortOrder ||
        a.createdAt.localeCompare(b.createdAt),
    );
    const summary =
      items.length > 0
        ? {
            productName: items[0].productName,
            color: items[0].color,
            sizeId: items[0].sizeId,
            sizeCode: items[0].sizeCode,
          }
        : null;
    const labelUrl = `${getApiUrl()}/packing/boxes/${row.id}/label`;
    return { ...base, items, summary, labelUrl };
  }
}
