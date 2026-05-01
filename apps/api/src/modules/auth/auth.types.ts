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
  role: Role;
  /** Логин (`Employee.login`) для удобства логирования и UI. */
  login: string;
  /** ФИО для шапки UI. */
  fullName: string;
}

export interface RequestWithAuth extends Request {
  auth?: AuthPrincipal;
}
