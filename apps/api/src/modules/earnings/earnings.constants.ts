/**
 * Константы модуля начислений (Шаг 9 MVP).
 *
 * Изолирует «политику» — какие операции считаются piecework и какие
 * payment-типы участвуют — от прочей логики, чтобы её было видно
 * в одном месте при добавлении новых ролей/операций.
 */

import type { Role } from '@prisma/client';

/**
 * Роли, которым разрешено видеть начисления всех сотрудников и в любом
 * статусе. Все остальные роли в `EarningsService.list / summary /
 * listByPassport` принудительно фильтруются по своему `employeeId` и
 * только на финальный (`APPROVED`) статус — это и есть backend-источник
 * истины RBAC начислений (см. `docs/api.md §10`).
 *
 * `ADMIN` всегда проходит как полный wildcard в `AuthGuard`, но мы
 * явно перечисляем его здесь, чтобы политика «кто видит чужие
 * начисления» жила в одном месте и не размазывалась по проверкам
 * `role !== 'ADMIN'`.
 */
export const EARNINGS_MANAGER_ROLES = ['SHOP_MANAGER', 'ADMIN'] as const;

export function isEarningsManager(role: Role | undefined | null): boolean {
  if (!role) return false;
  return (EARNINGS_MANAGER_ROLES as readonly Role[]).includes(role);
}

/**
 * Исторический MVP-список piecework-кодов. После выделения блока
 * «Операции» (см. ADR-0017, `docs/domain.md §16a`) единственный
 * источник истины — `Operation.pricingMode`:
 *   `FIXED` / `BY_SIZE` → сдельная;
 *   `SALARY_ONLY`       → оклад, начисление не создаётся.
 *
 * Список оставлен как ориентир для сидов и тестов: в `prisma/seed.ts`
 * мы выставляем именно этим операциям `pricingMode != SALARY_ONLY`.
 * В рантайме `EarningsService` его больше не использует.
 */
export const DEFAULT_PIECEWORK_OPERATION_CODES = [
  'CUT_CUT',
  'SEW_OVERLOCK_1',
  'SEW_BINDING',
  'SEW_OVERLOCK_2',
  'SEW_COVERSTITCH',
] as const;
