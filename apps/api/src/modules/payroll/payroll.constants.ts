/**
 * Константы модуля Payroll (PHASE 1 read-only).
 *
 * Изолируют RBAC-политику от бизнес-логики, чтобы её было видно в
 * одном месте и не размазывалось по проверкам `role !== ...`.
 *
 * Источник истины — `docs/domain.md §10.6`, `docs/api.md §31a`.
 */

import type { Role } from '@prisma/client';

/**
 * Роли, которым разрешены `/api/payroll/*` маршруты:
 *
 *   - SHOP_MANAGER — управленец, должен видеть всю ведомость;
 *   - ADMIN — wildcard (как и в остальных RBAC-точках, см.
 *     `RolesGuard`).
 *
 * Все остальные роли (CUTTER / SEAMSTRESS / QC / IRONING / PACKING /
 * CUTTER_ASSISTANT / SHOPFLOOR_MASTER / DISPLAY) ходят за личной
 * зарплатой через `/api/earnings` и `/api/salary` — они не должны
 * получать сводки по другим сотрудникам, и payroll API про них не
 * знает.
 *
 * `ADMIN` всегда проходит как полный wildcard в `RolesGuard`, но мы
 * явно перечисляем его здесь, чтобы политика «кто видит ведомость»
 * жила в одном месте.
 */
export const PAYROLL_MANAGER_ROLES = ['SHOP_MANAGER', 'ADMIN'] as const;

export function isPayrollManager(role: Role | undefined | null): boolean {
  if (!role) return false;
  return (PAYROLL_MANAGER_ROLES as readonly Role[]).includes(role);
}
