/**
 * Контракты панели супер-админа control-plane (мультитенантность, Фаза 4).
 * Используются API (`/api/superadmin/*`) и web (`/superadmin`). Работают с
 * РЕЕСТРОМ тенантов (control-plane БД), а не с данными конкретного тенанта.
 */
import { z } from 'zod';
import { FEATURE_MODULE_KEYS } from './auth';

export type TenantStatus = 'ACTIVE' | 'SUSPENDED';

export interface TenantDomainDto {
  id: string;
  host: string;
  isPrimary: boolean;
}

export interface TenantModuleDto {
  /** Ключ модуля (`FEATURE_MODULE_KEYS`). */
  moduleKey: string;
  /** Эффективное значение: default-on, если явной строки нет. */
  enabled: boolean;
  /** Есть ли явная строка `TenantModule` (иначе значение — дефолт). */
  explicit: boolean;
}

export interface TenantMigrationDto {
  lastMigration: string | null;
  lastStatus: string | null;
  updatedAt: string | null;
}

export interface TenantSummaryDto {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  /** ISO. */
  createdAt: string;
  dbName: string;
  domains: TenantDomainDto[];
  modules: TenantModuleDto[];
  migration: TenantMigrationDto | null;
}

// --- Запросы (Zod) -----------------------------------------------------------

export const SetModuleSchema = z.object({
  moduleKey: z.enum(FEATURE_MODULE_KEYS),
  enabled: z.boolean(),
});
export type SetModuleDto = z.infer<typeof SetModuleSchema>;

export const SetStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});
export type SetStatusDto = z.infer<typeof SetStatusSchema>;

const hostField = z
  .string()
  .trim()
  .min(1, 'Host обязателен')
  .max(253, 'Host слишком длинный')
  .transform((s) => s.toLowerCase())
  .refine((s) => /^[a-z0-9.-]+$/.test(s), 'Host: только буквы/цифры/точка/дефис');

export const AddDomainSchema = z.object({ host: hostField });
export type AddDomainDto = z.infer<typeof AddDomainSchema>;

export const CreateTenantSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'slug: только [a-z0-9-]'),
  name: z.string().trim().min(1, 'Название обязательно').max(200),
  dbName: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-zA-Z0-9_]+$/, 'Имя БД: только [A-Za-z0-9_]'),
  host: hostField,
  adminLogin: z.string().trim().min(1).max(100).default('admin'),
  adminPassword: z.string().min(6, 'Пароль не короче 6 символов').max(200),
  adminName: z.string().trim().max(200).optional(),
});
export type CreateTenantDto = z.infer<typeof CreateTenantSchema>;

export interface CreateTenantResultDto {
  ok: boolean;
  slug: string;
  /** Хвост вывода провижининга (для показа оператору). */
  log: string;
}

export const DeleteTenantSchema = z.object({
  /**
   * Подтверждение: оператор обязан ввести точный slug удаляемого тенанта —
   * защита от случайного удаления (как ввод имени репозитория на GitHub).
   */
  confirmSlug: z.string().trim().min(1, 'Введите slug для подтверждения'),
});
export type DeleteTenantDto = z.infer<typeof DeleteTenantSchema>;

export interface DeleteTenantResultDto {
  ok: boolean;
  slug: string;
  /** Хвост вывода удаления (backup → DROP → дерегистрация) для оператора. */
  log: string;
}
