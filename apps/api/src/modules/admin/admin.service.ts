import { Injectable } from '@nestjs/common';
import { PassportStatus } from '@prisma/client';
import type {
  AdminOverviewBoxDto,
  AdminOverviewDto,
  AdminOverviewPassportInWorkDto,
  AdminOverviewShiftDto,
} from '@sewing/shared/admin';
import { PrismaService } from '../../prisma/prisma.service.js';

const SHIFTS_LIMIT = 50;
const BOXES_LIMIT = 50;
const PASSPORTS_LIMIT = 100;
const EVENTS_WINDOW_HOURS = 24;

/**
 * Сервис «лёгкого» операционного обзора (Шаг 12 / Pilot Rollout).
 *
 * Идея — без аналитики и трендов отвечать начальнику цеха на пять
 * вопросов:
 *   - кто сейчас работает (активные смены)?
 *   - какие коробки открыты и насколько заполнены?
 *   - какие паспорта прямо сейчас в работе или лежат в ячейках?
 *   - сколько паспортов выпущено сегодня?
 *   - вообще движется ли система (события за последние 24 часа)?
 *
 * Никакой материализованной витрины — обычные `findMany`/`count` с
 * жёсткими LIMIT-ами (на пилоте больше попросту не будет). Ничего не
 * пишем в БД, поэтому метод безопасен для произвольного дёргания
 * с UI-кнопки Refresh.
 *
 * Контракт — `docs/api.md §11a`, UI — `apps/web/app/admin/overview`.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(): Promise<AdminOverviewDto> {
    const now = new Date();
    const since24h = new Date(now.getTime() - EVENTS_WINDOW_HOURS * 60 * 60 * 1000);
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0,
    );

    const [
      activeShifts,
      openBoxesCount,
      passportsInProgress,
      passportsInCells,
      passportsCreatedToday,
      eventsLast24h,
      shiftRows,
      boxRows,
      passportRows,
    ] = await this.prisma.$transaction([
      this.prisma.shiftSession.count({ where: { endedAt: null } }),
      this.prisma.box.count({ where: { closedAt: null } }),
      this.prisma.passport.count({
        where: { status: PassportStatus.IN_PROGRESS },
      }),
      this.prisma.passport.count({
        where: {
          status: PassportStatus.CREATED,
          currentCellId: { not: null },
        },
      }),
      this.prisma.passport.count({
        where: { createdAt: { gte: startOfToday } },
      }),
      this.prisma.passportEvent.count({
        where: { createdAt: { gte: since24h } },
      }),
      this.prisma.shiftSession.findMany({
        where: { endedAt: null },
        include: {
          employee: { select: { id: true, fullName: true, role: true } },
          equipment: { select: { code: true, name: true } },
          operation: { select: { code: true, name: true } },
        },
        orderBy: { startedAt: 'asc' },
        take: SHIFTS_LIMIT,
      }),
      this.prisma.box.findMany({
        where: { closedAt: null },
        include: {
          items: {
            include: {
              passport: {
                include: {
                  product: { select: { name: true } },
                  size: { select: { code: true } },
                },
              },
            },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          _count: { select: { items: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: BOXES_LIMIT,
      }),
      this.prisma.passport.findMany({
        where: {
          OR: [
            { status: PassportStatus.IN_PROGRESS },
            {
              status: PassportStatus.CREATED,
              currentCellId: { not: null },
            },
          ],
        },
        include: {
          product: { select: { name: true } },
          size: { select: { code: true } },
          currentEmployee: { select: { fullName: true } },
          currentCell: { select: { code: true } },
          currentOperation: { select: { code: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: PASSPORTS_LIMIT,
      }),
    ]);

    const shifts: AdminOverviewShiftDto[] = shiftRows.map((s) => ({
      shiftId: s.id,
      startedAt: s.startedAt.toISOString(),
      employeeId: s.employee.id,
      employeeName: s.employee.fullName,
      employeeRole: s.employee.role,
      operationCode: s.operation.code,
      operationName: s.operation.name,
      equipmentCode: s.equipment.code,
      equipmentName: s.equipment.name,
    }));

    const openBoxes: AdminOverviewBoxDto[] = boxRows.map((b) => {
      const head = b.items[0]?.passport;
      return {
        boxId: b.id,
        number: b.number,
        totalQty: b.totalQty,
        maxQty: b.maxQty,
        itemsCount: b._count.items,
        productName: head?.product.name ?? null,
        color: head?.color ?? null,
        sizeCode: head?.size.code ?? null,
        createdAt: b.createdAt.toISOString(),
      };
    });

    const passports: AdminOverviewPassportInWorkDto[] = passportRows.map((p) => {
      const location: AdminOverviewPassportInWorkDto['location'] =
        p.currentEmployeeId
          ? 'EMPLOYEE'
          : p.currentCellId
            ? 'CELL'
            : 'UNASSIGNED';
      return {
        passportId: p.id,
        number: p.number,
        status: p.status as 'IN_PROGRESS' | 'CREATED',
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        productName: p.product.name,
        color: p.color,
        sizeCode: p.size.code,
        location,
        currentEmployeeName: p.currentEmployee?.fullName ?? null,
        currentCellCode: p.currentCell?.code ?? null,
        currentOperationCode: p.currentOperation?.code ?? null,
        currentOperationName: p.currentOperation?.name ?? null,
        updatedAt: p.updatedAt.toISOString(),
      };
    });

    return {
      updatedAt: now.toISOString(),
      counters: {
        activeShifts,
        openBoxes: openBoxesCount,
        passportsInProgress,
        passportsInCells,
        passportsCreatedToday,
        eventsLast24h,
      },
      shifts,
      openBoxes,
      passports,
    };
  }
}
