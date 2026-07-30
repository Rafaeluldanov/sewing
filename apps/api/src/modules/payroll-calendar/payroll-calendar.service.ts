import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ListPayrollCalendarQuery,
  PayrollCalendarMonthDto,
  UpsertPayrollCalendarMonthDto,
} from '@sewing/shared/payroll-calendar';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PayrollCalendarMonthNotFoundException } from '../../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

/**
 * Сервис производственного календаря (`PayrollCalendarMonth`,
 * 29.07.2026) — норма рабочих дней и часов на месяц.
 *
 * Справочник обслуживает месячный оклад (`SalaryRateMode.MONTHLY`):
 * норма часов — знаменатель производной ставки ₽/час, по которой
 * месячнику считаются доплата за подкрой, ₽/минуту простоя в
 * дашборде и разнос оклада на себестоимость (см.
 * `apps/api/src/modules/salary/salary-rate.ts`). На сумму самого
 * оклада норма не влияет — он начисляется за месяц целиком.
 *
 * Ключ строки — естественная пара `(year, month)`, поэтому запись
 * делается одним идемпотентным `upsert`: «создать» и «поправить»
 * здесь одно и то же действие (менеджер заполняет клетку календаря),
 * и разделять их на POST/PATCH значило бы заставлять UI гадать,
 * существует ли уже строка.
 */
@Injectable()
export class PayrollCalendarService {
  private readonly logger = new Logger(PayrollCalendarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: ListPayrollCalendarQuery,
  ): Promise<PayrollCalendarMonthDto[]> {
    const where: Prisma.PayrollCalendarMonthWhereInput = {};
    if (query.year !== undefined) where.year = query.year;
    const rows = await this.prisma.payrollCalendarMonth.findMany({
      where,
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });
    return rows.map(toDto);
  }

  /**
   * Создать или обновить норму месяца. Пишет аудит-событие: норма —
   * денежно значимая величина (через неё считается доплата за
   * подкрой), и «кто и когда поменял 168 на 140» должно быть видно
   * так же, как ручная правка начисления.
   */
  async upsert(
    dto: UpsertPayrollCalendarMonthDto,
    actorEmployeeId?: string | null,
  ): Promise<PayrollCalendarMonthDto> {
    const before = await this.prisma.payrollCalendarMonth.findUnique({
      where: {
        PayrollCalendarMonth_year_month_uniq: {
          year: dto.year,
          month: dto.month,
        },
      },
    });

    const normHours = new Prisma.Decimal(dto.normHours.toFixed(2));
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.payrollCalendarMonth.upsert({
        where: {
          PayrollCalendarMonth_year_month_uniq: {
            year: dto.year,
            month: dto.month,
          },
        },
        create: {
          year: dto.year,
          month: dto.month,
          normDays: dto.normDays,
          normHours,
          comment: dto.comment ?? null,
        },
        update: {
          normDays: dto.normDays,
          normHours,
          comment: dto.comment ?? null,
        },
      });
      await this.audit.log(
        {
          event: 'PAYROLL_CALENDAR_MONTH_UPSERTED',
          entityType: 'PAYROLL_CALENDAR_MONTH',
          entityId: saved.id,
          employeeId: actorEmployeeId ?? undefined,
          payload: {
            year: saved.year,
            month: saved.month,
            before: before
              ? {
                  normDays: before.normDays,
                  normHours: Number(before.normHours),
                  comment: before.comment,
                }
              : null,
            after: {
              normDays: saved.normDays,
              normHours: Number(saved.normHours),
              comment: saved.comment,
            },
          },
        },
        tx,
      );
      return saved;
    });

    this.logger.log(
      `event=payroll_calendar.upsert year=${row.year} month=${row.month} normDays=${row.normDays} normHours=${Number(row.normHours)}`,
    );
    return toDto(row);
  }

  /**
   * Удалить строку месяца. Не запрещаем и не каскадим: уже начисленные
   * `SalaryEntry` норму не хранят и не пересчитываются, а будущие
   * расчёты просто упадут на `DEFAULT_MONTH_NORM_HOURS`. Единственное
   * последствие — экран календаря снова подсветит месяц как
   * незаполненный.
   */
  async remove(
    year: number,
    month: number,
    actorEmployeeId?: string | null,
  ): Promise<{ ok: true }> {
    const row = await this.prisma.payrollCalendarMonth.findUnique({
      where: {
        PayrollCalendarMonth_year_month_uniq: { year, month },
      },
    });
    if (!row) throw new PayrollCalendarMonthNotFoundException();

    await this.prisma.$transaction(async (tx) => {
      await tx.payrollCalendarMonth.delete({ where: { id: row.id } });
      await this.audit.log(
        {
          event: 'PAYROLL_CALENDAR_MONTH_DELETED',
          entityType: 'PAYROLL_CALENDAR_MONTH',
          entityId: row.id,
          employeeId: actorEmployeeId ?? undefined,
          payload: {
            year: row.year,
            month: row.month,
            normDays: row.normDays,
            normHours: Number(row.normHours),
          },
        },
        tx,
      );
    });
    return { ok: true };
  }
}

function toDto(row: {
  id: string;
  year: number;
  month: number;
  normDays: number;
  normHours: Prisma.Decimal;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PayrollCalendarMonthDto {
  return {
    id: row.id,
    year: row.year,
    month: row.month,
    normDays: row.normDays,
    normHours: Number(row.normHours),
    comment: row.comment,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
