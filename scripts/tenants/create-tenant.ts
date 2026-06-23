/**
 * Провижининг нового тенанта (DB-per-tenant, Фаза 2).
 *
 * Запускать ТАМ, где достижимы хосты control-plane и тенант-БД (в dev/prod —
 * внутри api-контейнера), через tsx:
 *
 *   docker exec -e CONTROL_PLANE_DATABASE_URL=... -e DATABASE_URL=... \
 *     sewing-api-1 npx tsx scripts/tenants/create-tenant.ts \
 *       --slug acme --name "ООО Акме" --db-name tenant_acme \
 *       --host acme.teeon.ru --admin-login admin --admin-password 'Secret123!'
 *
 * Шаги (идемпотентность ограничена — повторный запуск с тем же slug падает):
 *   1) определить dbUrl тенанта (из --db-url или --db-name + шаблон DATABASE_URL);
 *   2) CREATE DATABASE;
 *   3) prisma migrate deploy на новую БД;
 *   4) DB-инварианты (partial unique indexes);
 *   5) сид справочников (операции/размеры) + CompanySettings + админ;
 *   6) регистрация в control-plane (Tenant + TenantDomain + TenantMigration).
 *
 * `--db-url` имеет приоритет над `--db-name`. `--host` можно указать несколько раз.
 */
import { execSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { PrismaClient, Prisma, type OperationCategory } from '@prisma/client';
import { PrismaClient as ControlPlaneClient } from '.prisma/control-plane-client';
import {
  REFERENCE_OPERATIONS,
  REFERENCE_SIZES,
} from '../../apps/api/src/modules/bootstrap/reference-data.js';
import { latestMigration } from './migrations-util.js';

interface Args {
  slug: string;
  name: string;
  dbUrl: string;
  dbName: string;
  hosts: string[];
  adminLogin: string;
  adminPassword: string;
  adminName: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const single: Record<string, string> = {};
  const hosts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).trim();
    let value: string | undefined;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      // Защита от проглатывания следующего флага как значения
      // (`--admin-password --host x` иначе сделал бы пароль = "--host").
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Нет значения для --${key}`);
      }
      value = argv[++i];
    }
    if (key === 'host') hosts.push(value);
    else single[key] = value;
  }

  const slug = required(single, 'slug');
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`--slug должен быть [a-z0-9-]: получено "${slug}"`);
  }
  const name = required(single, 'name');

  const baseUrl = process.env.DATABASE_URL;
  let dbUrl = single['db-url'];
  if (!dbUrl) {
    const dbName = required(single, 'db-name');
    if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
      throw new Error(`--db-name должен быть [A-Za-z0-9_]: получено "${dbName}"`);
    }
    if (!baseUrl) {
      throw new Error('Нужен DATABASE_URL (шаблон) либо явный --db-url');
    }
    const u = new URL(baseUrl);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
  }
  const dbName = new URL(dbUrl).pathname.replace(/^\//, '');
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Имя БД из dbUrl невалидно: "${dbName}"`);
  }

  return {
    slug,
    name,
    dbUrl,
    dbName,
    hosts: hosts.length > 0 ? hosts : [`${slug}.localhost`],
    adminLogin: single['admin-login'] ?? 'admin',
    // Пароль предпочтительно через env (не светится в `ps`/argv, CWE-214);
    // --admin-password оставлен для ручного CLI-запуска.
    adminPassword: requirePassword(single['admin-password']),
    adminName: single['admin-name'] ?? 'Администратор',
  };
}

function requirePassword(fromArg: string | undefined): string {
  const v = process.env.TENANT_ADMIN_PASSWORD ?? fromArg;
  if (!v) {
    throw new Error(
      'Пароль админа не задан: укажите TENANT_ADMIN_PASSWORD (env) или --admin-password',
    );
  }
  return v;
}

function required(map: Record<string, string>, key: string): string {
  const v = map[key];
  if (!v) throw new Error(`Обязательный аргумент --${key} не задан`);
  return v;
}

const INVARIANTS: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "shift_session_active_employee_uniq"
     ON "ShiftSession" ("employeeId") WHERE "endedAt" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_active_uniq"
     ON "CuttingClosureRequest" ("orderId", "productId", "sizeId") WHERE "status" = 'REQUESTED'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "cutting_closure_request_approved_uniq"
     ON "CuttingClosureRequest" ("orderId", "productId", "sizeId") WHERE "status" = 'APPROVED'`,
];

async function main(): Promise<void> {
  const args = parseArgs();
  const cpUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!cpUrl) throw new Error('CONTROL_PLANE_DATABASE_URL не задан — control-plane обязателен для провижининга');

  const cp = new ControlPlaneClient();
  try {
    const exists = await cp.tenant.findUnique({ where: { slug: args.slug } });
    if (exists) throw new Error(`Тенант со slug "${args.slug}" уже зарегистрирован`);

    // Fail-fast по доменам ДО дорогого CREATE DATABASE/migrate: иначе коллизия
    // host (TenantDomain.host @unique) всплыла бы только на шаге [6/6], оставив
    // осиротевшую БД.
    const hostClash = await cp.tenantDomain.findMany({
      where: { host: { in: args.hosts.map((h) => h.trim().toLowerCase()) } },
      select: { host: true },
    });
    if (hostClash.length > 0) {
      throw new Error(`Домены уже заняты: ${hostClash.map((d) => d.host).join(', ')}`);
    }

    // CREATE DATABASE идемпотентно (Postgres не поддерживает IF NOT EXISTS):
    // если БД уже есть (повторный запуск после частичного провала) — пропускаем
    // и продолжаем; migrate/seed/upsert ниже идемпотентны.
    const dbRows = await cp.$queryRawUnsafe<Array<{ one: number }>>(
      'SELECT 1 AS one FROM pg_database WHERE datname = $1',
      args.dbName,
    );
    if (dbRows.length > 0) {
      console.log(`[1/6] БД "${args.dbName}" уже существует — пропускаю CREATE (resume)`);
    } else {
      console.log(`[1/6] CREATE DATABASE "${args.dbName}"`);
      await cp.$executeRawUnsafe(`CREATE DATABASE "${args.dbName}"`);
    }

    console.log(`[2/6] migrate deploy → ${args.dbName}`);
    execSync('npx prisma migrate deploy --schema=prisma/schema.prisma', {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: args.dbUrl },
    });

    const tenantDb = new PrismaClient({ datasources: { db: { url: args.dbUrl } } });
    try {
      console.log('[3/6] DB-инварианты');
      for (const sql of INVARIANTS) await tenantDb.$executeRawUnsafe(sql);

      console.log('[4/6] сид справочников (операции/размеры)');
      await seedReferenceData(tenantDb);

      console.log('[5/6] CompanySettings + админ');
      await tenantDb.companySettings.upsert({
        where: { id: 'default' },
        create: { id: 'default', legalName: args.name, shortName: args.slug },
        update: {},
      });
      const pinHash = await bcrypt.hash(args.adminPassword, 10);
      await tenantDb.employee.upsert({
        where: { login: args.adminLogin },
        create: {
          login: args.adminLogin,
          pinHash,
          fullName: args.adminName,
          role: 'ADMIN',
          roles: ['ADMIN'],
          compensationType: 'PIECEWORK',
        },
        update: { pinHash, role: 'ADMIN', roles: ['ADMIN'] },
      });
    } finally {
      await tenantDb.$disconnect();
    }

    console.log('[6/6] регистрация в control-plane');
    await cp.tenant.create({
      data: {
        slug: args.slug,
        name: args.name,
        dbUrl: args.dbUrl,
        status: 'ACTIVE',
        domains: {
          create: args.hosts.map((host, i) => ({
            host: host.trim().toLowerCase(),
            isPrimary: i === 0,
          })),
        },
        migration: {
          create: { lastMigration: latestMigration(), lastStatus: 'ok' },
        },
      },
    });

    console.log(
      `\n✅ Тенант "${args.slug}" создан. Хосты: ${args.hosts.join(', ')}. Логин админа: ${args.adminLogin}`,
    );
  } finally {
    await cp.$disconnect();
  }
}

async function seedReferenceData(db: PrismaClient): Promise<void> {
  await db.operation.createMany({
    data: REFERENCE_OPERATIONS.map((op) => ({
      code: op.code,
      name: op.name,
      category: op.category as OperationCategory,
      sortOrder: op.sortOrder,
      active: true,
      pricingMode: op.pricingMode,
      fixedRate:
        op.pricingMode === 'FIXED' && op.fixedRate !== undefined
          ? new Prisma.Decimal(op.fixedRate)
          : null,
    })),
    skipDuplicates: true,
  });
  await db.size.createMany({
    data: REFERENCE_SIZES.map((code, i) => ({ code, sortOrder: (i + 1) * 10 })),
    skipDuplicates: true,
  });
}

main().catch((err) => {
  console.error('\n❌ create-tenant failed:', (err as Error).message);
  process.exit(1);
});
