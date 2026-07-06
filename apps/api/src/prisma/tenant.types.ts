/**
 * Описание одного тенанта (компании) для DB-per-tenant.
 *
 * Тенант = отдельная БД в одном Postgres-кластере. Источник этих данных:
 *   - Фаза 0 — env (один дефолтный тенант, dbUrl = DATABASE_URL);
 *   - Фаза 2 — control-plane БД (таблицы Tenant / TenantDomain).
 *
 * Интерфейс одинаков для обоих источников — меняется только реализация
 * `TenantRegistry`, не потребители.
 */
export interface TenantInfo {
  /** Стабильный id тенанта — ключ кэша Prisma-клиентов и TenantContext. */
  id: string;
  /** Человекочитаемый slug / поддомен (для логов и резолва по Host). */
  slug: string;
  /** Connection string на БД именно этого тенанта. */
  dbUrl: string;
}

/**
 * Итог резолва Host → тенант. Различаем три исхода, чтобы middleware мог
 * отдать разные ответы, а web — показать корректную заглушку:
 *   - `active`    — известный ACTIVE тенант, запрос обслуживаем;
 *   - `suspended` — тенант существует, но приостановлен (403 TENANT_SUSPENDED,
 *     заглушка «обратитесь к администратору сервиса»);
 *   - `unknown`   — хост не привязан ни к одному тенанту (404 UNKNOWN_TENANT).
 *
 * Раньше `suspended` и `unknown` схлопывались в один `null` → оба давали
 * 404 UNKNOWN_TENANT, и приостановленный тенант выглядел как «Not Found».
 */
export type TenantResolution =
  | { outcome: 'active'; tenant: TenantInfo }
  | { outcome: 'suspended' }
  | { outcome: 'unknown' };
