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
} from '@sewing/shared/packing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BoxCapacityExceededException,
  BoxClosedException,
  BoxEmptyCloseException,
  BoxHomogeneityViolatedException,
  BoxNotFoundException,
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

type BoxRow = Prisma.BoxGetPayload<{
  include: {
    createdBy: { select: { id: true; fullName: true } };
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

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.box.count({ where }),
      this.prisma.box.findMany({
        where,
        include: {
          createdBy: { select: { id: true, fullName: true } },
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
    });

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
