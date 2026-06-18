import type { Role } from '@prisma/client';
import type { Request } from 'express';

/**
 * Данные авторизованного пользователя, прикреплённые к запросу
 * после прохождения `AuthGuard` (см. `./auth.guard.ts`).
 *
 * Это минимально достаточный набор: id для бизнес-логики и роль для
 * RBAC-проверок без обращения в БД.
 */
export interface AuthPrincipal {
  employeeId: string;
  /**
   * ОСНОВНАЯ роль (`Employee.role`) — для категоризации и дефолтного
   * экрана. RBAC опирается на `roles` (см. ниже), а не на это поле.
   */
  role: Role;
  /**
   * Полный набор ролей доступа (`Employee.roles`, фича «несколько
   * ролей»). ИНВАРИАНТ: всегда содержит `role`. На него опирается
   * `AuthGuard` при проверке `@Roles(...)`.
   */
  roles: Role[];
  /**
   * Текущая активная роль (`Employee.activeRole`) — последняя, на
   * которую переключились сканом рабочего места. `null` — берётся `role`.
   */
  activeRole: Role | null;
  /** Логин (`Employee.login`) для удобства логирования и UI. */
  login: string;
  /** ФИО для шапки UI. */
  fullName: string;
}

export interface RequestWithAuth extends Request {
  auth?: AuthPrincipal;
}
