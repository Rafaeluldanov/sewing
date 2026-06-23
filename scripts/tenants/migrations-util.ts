import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Имя последней миграции в `prisma/migrations` (целевая версия схемы).
 * Единый источник для всех tenant-скриптов — чтобы записанная в
 * `TenantMigration.lastMigration` версия не расходилась с реально
 * применённой `migrate deploy` (раньше дублировалась хардкод-константой).
 */
export function latestMigration(): string {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return names[names.length - 1] ?? '(none)';
}
