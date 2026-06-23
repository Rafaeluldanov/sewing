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
