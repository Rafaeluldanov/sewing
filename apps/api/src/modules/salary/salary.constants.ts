/**
 * Константы модуля окладных начислений (post-Шаг 18 / Шаг 19,
 * ADR-0021). Изолируют RBAC-политику от бизнес-логики, чтобы её было
 * видно в одном месте и не размазывалось по проверкам `role !== ...`.
 */

import type { Role } from '@prisma/client';

/**
 * Роли, которым разрешено:
 *   - видеть окладные начисления всех сотрудников;
 *   - править `amount` / `managerComment` (`PATCH /api/salary/:id`);
 *   - управлять `compensationType` / `salaryPerShift` сотрудников.
 *
 * `ADMIN` всегда проходит как полный wildcard в `RolesGuard`, но мы
 * явно перечисляем его здесь, чтобы политика «кто видит чужие оклады»
 * жила в одном месте.
 */
export const SALARY_MANAGER_ROLES = ['SHOP_MANAGER', 'ADMIN'] as const;

export function isSalaryManager(
  role: string | undefined | null,
): boolean {
  if (!role) return false;
  return (SALARY_MANAGER_ROLES as readonly string[]).includes(role);
}
