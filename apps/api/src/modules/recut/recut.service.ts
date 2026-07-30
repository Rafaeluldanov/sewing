import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
} from '@sewing/shared/orders';
import type {
  RecutOrderSearchItemDto,
  RecutSessionDto,
  RecutSessionStatus,
} from '@sewing/shared/recut';

import { PrismaService } from '../../prisma/prisma.service.js';
import {
  RecutAlreadyActiveException,
  RecutNoActiveShiftException,
  RecutNotActiveException,
  RecutNotFoundException,
  RecutOrderNotFoundException,
} from '../../common/errors.js';
import { SalaryService } from '../salary/salary.service.js';
import { resolveEffectiveHourlyRate } from '../salary/salary-rate.js';

const recutSessionInclude = {
  order: { select: { number: true } },
  employee: { select: { fullName: true } },
} satisfies Prisma.RecutSessionInclude;

type RecutSessionRow = Prisma.RecutSessionGetPayload<{
  include: typeof recutSessionInclude;
}>;

/**
 * Сервис фичи «Подкрой» (`RecutSession`, роль `CUTTER`).
 *
 * Подкрой — отдельная хронометрируемая активность раскройщика по заказу
 * (докрой недостающих/бракованных деталей), возможная даже по
 * завершённому заказу (`Order.status = DONE`). Не выпускает паспортов,
 * не трогает статус/план заказа и не связан с `CuttingTask` — просто
 * таймер `start → stop`.
 *
 * Правила:
 *   - запускается только при открытой смене раскройщика (`ShiftSession`
 *     с `endedAt = null`); контекст (`equipmentId`/`shiftSessionId`)
 *     снимается с активной смены;
 *   - одновременно у сотрудника активен один подкрой (partial-unique
 *     индекс + явная проверка);
 *   - оплата — почасовая ДОПЛАТА сверх смены: при завершении считаем
 *     длительность и `amount`, дневной агрегат ложится строкой
 *     `SalaryEntry(source = RECUT)` через `SalaryService.syncDailyRecut`.
 */
@Injectable()
export class RecutService {
  private readonly logger = new Logger(RecutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salary: SalaryService,
  ) {}

  // ---------------------------------------------------------------------------
  // READ
  // ---------------------------------------------------------------------------

  /**
   * Активный подкрой сотрудника (для живого таймера на доске). `null`,
   * если сейчас ничего не идёт. Backend сам режет по `employeeId` из
   * сессии — клиент не может запросить чужой (ADR-0014).
   */
  async getActiveForEmployee(employeeId: string): Promise<RecutSessionDto | null> {
    const row = await this.prisma.recutSession.findFirst({
      where: { employeeId, status: 'ACTIVE' },
      orderBy: { startedAt: 'desc' },
      include: recutSessionInclude,
    });
    return row ? this.toDto(row) : null;
  }

  /**
   * Поиск заказа по номеру для запуска подкроя. Любой статус, ВКЛЮЧАЯ
   * завершённые (`DONE`) — в этом весь смысл фичи. Узкая проекция, лимит
   * 20. Пустой запрос → пустой список (не грузим всю базу).
   *
   * Собственный эндпоинт (а не `orders.list`), потому что тот закрыт под
   * `SHOP_MANAGER/CUTTER_ASSISTANT` — раскройщику (`CUTTER`) недоступен.
   */
  async searchOrders(q: string): Promise<RecutOrderSearchItemDto[]> {
    const term = q.trim();
    if (term.length === 0) return [];
    const rows = await this.prisma.order.findMany({
      where: { number: { contains: term, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        number: true,
        status: true,
        customer: true,
        client: { select: { name: true } },
        items: {
          take: 1,
          select: { product: { select: { name: true, color: true } } },
        },
      },
    });
    return rows.map((o) => {
      const product = o.items[0]?.product ?? null;
      const productSummary = product
        ? [product.name, product.color].filter(Boolean).join(' · ') || null
        : null;
      return {
        id: o.id,
        number: o.number,
        status: o.status,
        statusLabel:
          ORDER_STATUS_LABELS[o.status as OrderStatus] ?? o.status,
        clientName: o.client?.name ?? o.customer ?? null,
        productSummary,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // ACTIONS
  // ---------------------------------------------------------------------------

  /**
   * «Начать подкрой». Требует открытую смену; отсутствие другого
   * активного подкроя. Контекст (стол/смена) снимается с активной смены.
   */
  async start(params: {
    employeeId: string;
    orderId: string;
  }): Promise<RecutSessionDto> {
    const { employeeId, orderId } = params;

    // 1. Смена должна быть открыта (подкрой — активность в рамках смены).
    const shift = await this.prisma.shiftSession.findFirst({
      where: { employeeId, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, equipmentId: true },
    });
    if (!shift) throw new RecutNoActiveShiftException();

    // 2. Заказ существует (статус НЕ проверяем — подкрой возможен по DONE).
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new RecutOrderNotFoundException();

    // 3. Нет другого активного подкроя.
    const existing = await this.prisma.recutSession.findFirst({
      where: { employeeId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (existing) throw new RecutAlreadyActiveException();

    try {
      const created = await this.prisma.recutSession.create({
        data: {
          orderId,
          employeeId,
          equipmentId: shift.equipmentId,
          shiftSessionId: shift.id,
          status: 'ACTIVE',
        },
        include: recutSessionInclude,
      });
      return this.toDto(created);
    } catch (err) {
      // Гонка между проверкой (3) и вставкой: partial-unique индекс
      // `recut_session_active_employee_uniq` поймает дубль.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new RecutAlreadyActiveException();
      }
      throw err;
    }
  }

  /**
   * «Завершить подкрой» — `ACTIVE` → `DONE`. Фиксирует длительность,
   * снимок часовой ставки и рассчитанную доплату, затем пересчитывает
   * дневную строку `SalaryEntry(source = RECUT)`.
   */
  async complete(id: string, employeeId: string): Promise<RecutSessionDto> {
    const session = await this.loadOwnedActive(id, employeeId);

    const endedAt = new Date();
    const workedSeconds = Math.max(
      0,
      Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000),
    );

    // Снимок часовой ставки на момент завершения (для аудита/показа).
    // Платёжный источник истины — агрегат `syncDailyRecut`; здесь снимок
    // считаем ТОЙ ЖЕ ставкой, чтобы строка сессии и ведомость сходились —
    // включая месячного окладника, у которого `salaryPerHour` пуст, а
    // ₽/час производные от нормы часов месяца (см. `salary-rate.ts`).
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        salaryRateMode: true,
        salaryPerHour: true,
        salaryPerMonth: true,
      },
    });
    const ratePerHour = employee
      ? await resolveEffectiveHourlyRate(this.prisma, employee, endedAt)
      : null;
    const amount =
      ratePerHour !== null
        ? new Prisma.Decimal(ratePerHour)
            .mul(new Prisma.Decimal(workedSeconds).div(3600))
            .toDecimalPlaces(2)
        : null;

    const updated = await this.prisma.recutSession.update({
      where: { id },
      data: {
        status: 'DONE',
        endedAt,
        workedSeconds,
        ratePerHour,
        amount,
      },
      include: recutSessionInclude,
    });

    await this.safeSyncRecutSalary(employeeId, session.startedAt);
    return this.toDto(updated);
  }

  /**
   * «Отменить подкрой» — `ACTIVE` → `CANCELLED`, без оплаты. Пересчёт
   * ведомости на всякий случай (если в этот день были другие подкрои —
   * их сумма не меняется; отменённый в агрегат не попадает).
   */
  async cancel(id: string, employeeId: string): Promise<RecutSessionDto> {
    const session = await this.loadOwnedActive(id, employeeId);
    const updated = await this.prisma.recutSession.update({
      where: { id },
      data: { status: 'CANCELLED', endedAt: new Date() },
      include: recutSessionInclude,
    });
    await this.safeSyncRecutSalary(employeeId, session.startedAt);
    return this.toDto(updated);
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async loadOwnedActive(id: string, employeeId: string) {
    const session = await this.prisma.recutSession.findUnique({
      where: { id },
      select: { id: true, employeeId: true, status: true, startedAt: true },
    });
    if (!session || session.employeeId !== employeeId) {
      // Не раскрываем чужие подкрои — та же 404, что и «не найден».
      throw new RecutNotFoundException();
    }
    if (session.status !== 'ACTIVE') throw new RecutNotActiveException();
    return session;
  }

  /**
   * fail-soft пересчёт зарплаты: ошибка sync не должна валить
   * завершение/отмену подкроя (та же семантика, что и `safeSyncSalary`
   * на старте/стопе смены).
   */
  private async safeSyncRecutSalary(employeeId: string, day: Date) {
    try {
      await this.salary.syncDailyRecut(employeeId, day);
    } catch (err) {
      this.logger.warn(
        `syncDailyRecut failed (employeeId=${employeeId}, date=${day.toISOString()}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private toDto(row: RecutSessionRow): RecutSessionDto {
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber: row.order.number,
      employeeId: row.employeeId,
      employeeFullName: row.employee.fullName,
      status: row.status as RecutSessionStatus,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      workedSeconds: row.workedSeconds ?? null,
      ratePerHour: row.ratePerHour === null ? null : Number(row.ratePerHour),
      amount: row.amount === null ? null : Number(row.amount),
    };
  }
}
