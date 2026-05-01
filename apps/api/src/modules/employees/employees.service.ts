import { Injectable, NotFoundException } from '@nestjs/common';
import { CompensationType, Prisma, Role } from '@prisma/client';
import type {
  EmployeeDetailDto,
  EmployeeListItemDto,
  ListEmployeesQuery,
  UpdateEmployeeDto,
} from '@sewing/shared/employees';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EmployeeNotFoundException,
  EmployeeSalaryRateRequiredException,
} from '../../common/errors.js';

/**
 * Сервис управления сотрудниками (post-Шаг 18 / Шаг 19, ADR-0021).
 *
 * Скоуп MVP — только read + management-поля (`compensationType`,
 * `salaryPerShift`, `active`). Создание/удаление сотрудников
 * out-of-scope: их заводит seed/админ напрямую через Prisma. Эти
 * операции требуют отдельного UX (PIN, второй фактор, аудит) и
 * на текущий шаг сознательно не вытащены наружу.
 */
@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // READ
  // ===========================================================================

  async list(query: ListEmployeesQuery): Promise<EmployeeListItemDto[]> {
    const where: Prisma.EmployeeWhereInput = {};
    if (query.active !== undefined) where.active = query.active;
    if (query.role) where.role = query.role as Role;
    if (query.compensationType) {
      where.compensationType = query.compensationType as CompensationType;
    }
    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: 'insensitive' } },
        { login: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.employee.findMany({
      where,
      orderBy: [{ active: 'desc' }, { fullName: 'asc' }],
    });
    return rows.map(toListDto);
  }

  async get(id: string): Promise<EmployeeDetailDto> {
    const row = await this.prisma.employee.findUnique({ where: { id } });
    if (!row) throw new EmployeeNotFoundException();
    return toDetailDto(row);
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  /**
   * Точечный patch management-полей. Инвариант ADR-0021:
   *   - `compensationType in (SALARY, MIXED)` ⇒ `salaryPerShift > 0`.
   *
   * Если patch ломает инвариант — бросаем `EMPLOYEE_SALARY_RATE_REQUIRED`.
   * Это ловится на UI и подсвечивается на форме ставки.
   */
  async update(id: string, dto: UpdateEmployeeDto): Promise<EmployeeDetailDto> {
    const current = await this.prisma.employee.findUnique({ where: { id } });
    if (!current) throw new EmployeeNotFoundException();

    const next = {
      compensationType: dto.compensationType ?? current.compensationType,
      salaryPerShift:
        dto.salaryPerShift !== undefined
          ? dto.salaryPerShift
          : current.salaryPerShift !== null
          ? Number(current.salaryPerShift)
          : null,
      active: dto.active ?? current.active,
    };

    if (
      (next.compensationType === CompensationType.SALARY ||
        next.compensationType === CompensationType.MIXED) &&
      (next.salaryPerShift === null || next.salaryPerShift <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }

    const data: Prisma.EmployeeUpdateInput = {};
    if (dto.compensationType !== undefined) {
      data.compensationType = dto.compensationType as CompensationType;
    }
    if (dto.salaryPerShift !== undefined) {
      data.salaryPerShift =
        dto.salaryPerShift === null
          ? null
          : new Prisma.Decimal(dto.salaryPerShift.toFixed(2));
    }
    if (dto.active !== undefined) {
      data.active = dto.active;
    }

    const updated = await this.prisma.employee.update({
      where: { id },
      data,
    });
    return toDetailDto(updated);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type EmployeeRow = Prisma.EmployeeGetPayload<{}>;

function toListDto(e: EmployeeRow): EmployeeListItemDto {
  return {
    id: e.id,
    fullName: e.fullName,
    login: e.login,
    role: e.role,
    paymentType: e.paymentType,
    compensationType: e.compensationType,
    salaryPerShift: e.salaryPerShift === null ? null : Number(e.salaryPerShift),
    active: e.active,
    createdAt: e.createdAt.toISOString(),
  };
}

function toDetailDto(e: EmployeeRow): EmployeeDetailDto {
  return {
    ...toListDto(e),
    salaryBase: e.salaryBase === null ? null : Number(e.salaryBase),
  };
}
