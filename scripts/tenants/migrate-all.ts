/**
 * Оркестратор миграций по всем тенант-БД (DB-per-tenant, Фаза 2).
 *
 * Боль №1 DB-per-tenant: каждое изменение схемы надо применить к N базам.
 * Скрипт берёт список тенантов из control-plane и для каждого:
 *   1) `prisma migrate deploy` против его dbUrl;
 *   2) применяет DB-инварианты (partial unique indexes);
 *   3) обновляет `TenantMigration` (lastMigration / lastStatus).
 * Останавливается на первом падении и печатает сводку (кто на какой версии) —
 * чтобы видеть version skew. Докатить отставших = повторный запуск.
 *
 * Запуск (внутри api-контейнера, где достижимы БД):
 *   docker exec -e CONTROL_PLANE_DATABASE_URL=... sewing-api-1 \
 *     npx tsx scripts/tenants/migrate-all.ts
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaClient as ControlPlaneClient } from '.prisma/control-plane-client';
import { latestMigration } from './migrations-util.js';

const INVARIANTS: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "shift_session_active_employee_uniq"
     ON "ShiftSession" ("employeeId") WHERE "endedAt" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_active_uniq"
     ON "CuttingClosureRequest" ("orderId", "productId", "sizeId") WHERE "status" = 'REQUESTED'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_approved_uniq"
     ON "CuttingClosureRequest" ("orderId", "productId", "sizeId") WHERE "status" = 'APPROVED'`,
];

async function main(): Promise<void> {
  if (!process.env.CONTROL_PLANE_DATABASE_URL) {
    throw new Error('CONTROL_PLANE_DATABASE_URL не задан — нечего оркестрировать');
  }
  const target = latestMigration();
  console.log(`Целевая миграция: ${target}\n`);

  const cp = new ControlPlaneClient();
  // Пред-заполняем сводку всеми тенантами как «pending», чтобы при остановке
  // на первом падении были видны и НЕ обработанные (истинный масштаб skew),
  // а не только дошедшие до точки отказа.
  const status = new Map<string, string>();
  try {
    const tenants = await cp.tenant.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (tenants.length === 0) {
      console.log('Активных тенантов нет.');
      return;
    }
    for (const t of tenants) status.set(t.slug, 'pending (не обработан)');

    for (const t of tenants) {
      console.log(`\n=== ${t.slug} (${t.id}) ===`);
      try {
        execSync('npx prisma migrate deploy --schema=prisma/schema.prisma', {
          stdio: 'inherit',
          env: { ...process.env, DATABASE_URL: t.dbUrl },
        });
        const db = new PrismaClient({ datasources: { db: { url: t.dbUrl } } });
        try {
          for (const sql of INVARIANTS) await db.$executeRawUnsafe(sql);
        } finally {
          await db.$disconnect();
        }
        await cp.tenantMigration.upsert({
          where: { tenantId: t.id },
          create: { tenantId: t.id, lastMigration: target, lastStatus: 'ok' },
          update: { lastMigration: target, lastStatus: 'ok' },
        });
        status.set(t.slug, `ok → ${target}`);
      } catch (err) {
        await cp.tenantMigration
          .upsert({
            where: { tenantId: t.id },
            create: { tenantId: t.id, lastStatus: 'failed' },
            update: { lastStatus: 'failed' },
          })
          .catch(() => undefined);
        status.set(t.slug, `FAILED: ${(err as Error).message.split('\n')[0]}`);
        printSummary(status);
        throw new Error(`Остановлено на тенанте "${t.slug}" (version skew выше).`);
      }
    }
    printSummary(status);
  } finally {
    await cp.$disconnect();
  }
}

function printSummary(status: Map<string, string>): void {
  const done = [...status.values()].filter((s) => !s.startsWith('pending')).length;
  console.log(`\n──────── Сводка (${done}/${status.size}) ────────`);
  for (const [slug, st] of status) console.log(`  ${slug.padEnd(20)} ${st}`);
}

main().catch((err) => {
  console.error('\n❌ migrate-all:', (err as Error).message);
  process.exit(1);
});
