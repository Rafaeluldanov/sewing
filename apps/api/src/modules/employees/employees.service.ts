import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { CompensationType, Prisma, Role } from '@prisma/client';
import type {
  CreateEmployeeDto,
  EmployeeDetailDto,
  EmployeeListItemDto,
  ListEmployeesQuery,
  UpdateEmployeeDto,
} from '@sewing/shared/employees';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  EmployeeLoginTakenException,
  EmployeeNotFoundException,
  EmployeeSalaryRateRequiredException,
} from '../../common/errors.js';
import { requiresSalaryRate } from './compensation.js';

/**
 * Сервис управления сотрудниками (post-Шаг 18 / Шаг 19, ADR-0021,
 * + post-задача «Добавить сотрудника» с UI на `/admin/employees/new`).
 *
 * Скоуп MVP — read + management-поля (`compensationType`,
 * `salaryPerShift`, `active`) и минимальное создание новой карточки
 * (`fullName`, `login`, `pinHash`, `role` и стартовая окладная
 * конфигурация). Удаление по-прежнему out-of-scope — менеджер
 * мягко гасит карточку через `active = false`.
 *
 * PIN хранится только как bcrypt-hash в `Employee.pinHash`, наружу не
 * отдаётся ни одним DTO (см. `toListDto` / `toDetailDto`). Тот же
 * cost-factor (10), что и в `prisma/seed.ts`/`AuthService`.
 */
const PIN_HASH_COST = 10;

@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

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
  // CREATE
  // ===========================================================================

  /**
   * Создание новой карточки сотрудника. Используется со страницы
   * `/admin/employees/new` (см. `docs/screens.md §10d`).
   *
   * Инварианты:
   *   - `login` уникален (`Employee.login @unique`); конфликт
   *     транслируется в `EMPLOYEE_LOGIN_TAKEN` (409);
   *   - окладная пара `(compensationType, salaryPerShift)` валидируется
   *     тем же правилом, что и в `update`: для `SALARY`/`MIXED`
   *     обязателен положительный `salaryPerShift`. Это уже зеркалит
   *     `CreateEmployeeSchema.superRefine`, но мы дублируем guard на
   *     сервисе, чтобы не зависеть от того, что наружу однажды появится
   *     ещё один путь записи (например, импорт).
   *
   * `pinHash` всегда вычисляется из присланного `pin` через bcrypt
   * c тем же cost-factor (10), что и `prisma/seed.ts` — чтобы у нового
   * сотрудника логин работал ровно так же, как у seed-аккаунтов.
   */
  async create(dto: CreateEmployeeDto): Promise<EmployeeDetailDto> {
    if (
      requiresSalaryRate(dto.compensationType as CompensationType) &&
      (dto.salaryPerShift === null ||
        dto.salaryPerShift === undefined ||
        dto.salaryPerShift <= 0)
    ) {
      throw new EmployeeSalaryRateRequiredException();
    }

    const pinHash = await bcrypt.hash(dto.pin, PIN_HASH_COST);

    let created;
    try {
      created = await this.prisma.employee.create({
        data: {
          fullName: dto.fullName,
          login: dto.login,
          pinHash,
          role: dto.role as Role,
          compensationType: dto.compensationType as CompensationType,
          salaryPerShift:
            dto.salaryPerShift === undefined || dto.salaryPerShift === null
              ? null
              : new Prisma.Decimal(dto.salaryPerShift.toFixed(2)),
          // B2B-процент закройщика (см.
          // `docs/payroll-cutter-compensation-recon.md §«Настраиваемый
          // процент»`). Поле имеет смысл только для роли `CUTTER` —
          // UI скрывает его для остальных ролей. Здесь сервер не
          // делает role-guard: если значение пришло — сохраняем.
          // B2B-flow `EarningsService.createImmediateForCutter`
          // читает это поле уже после собственного role-фильтра.
          cutterB2bSewingPercent:
            dto.cutterB2bSewingPercent === undefined ||
            dto.cutterB2bSewingPercent === null
              ? null
              : new Prisma.Decimal(dto.cutterB2bSewingPercent.toFixed(2)),
          active: dto.active ?? true,
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const target = (e.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        if (fields.some((f) => String(f).includes('login'))) {
          throw new EmployeeLoginTakenException();
        }
      }
      throw e;
    }

    this.logger.log(
      `event=employee.create id=${created.id} login=${created.login} role=${created.role}`,
    );
    return toDetailDto(created);
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
      requiresSalaryRate(next.compensationType) &&
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
    if (dto.cutterB2bSewingPercent !== undefined) {
      // `null` → стираем процент (backend возьмёт fallback из ENV
      // `CUTTER_B2B_SEWING_PERCENT`). `undefined` → не трогаем
      // колонку. Подробнее — `docs/payroll-cutter-compensation-recon.md`.
      data.cutterB2bSewingPercent =
        dto.cutterB2bSewingPercent === null
          ? null
          : new Prisma.Decimal(dto.cutterB2bSewingPercent.toFixed(2));
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
    cutterB2bSewingPercent:
      e.cutterB2bSewingPercent === null
        ? null
        : Number(e.cutterB2bSewingPercent),
  };
}
