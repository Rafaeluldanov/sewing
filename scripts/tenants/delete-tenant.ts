/**
 * Удаление тенанта (DB-per-tenant, Фаза 4). ОБРАТНАЯ операция к
 * create-tenant.ts. НЕОБРАТИМО: дропает БД тенанта со всеми данными.
 *
 * Запускать ТАМ, где достижимы control-plane и БД тенанта (в dev/prod —
 * внутри api-контейнера), через tsx:
 *
 *   docker exec -e CONTROL_PLANE_DATABASE_URL=... -e DATABASE_URL=... \
 *     sewing-api-1 npx tsx scripts/tenants/delete-tenant.ts \
 *       --slug acme --confirm acme
 *
 * Идентификация: `--slug` ЛИБО `--id`. `--confirm <slug>` обязателен и должен
 * совпадать со slug тенанта (защита от опечатки).
 *
 * Предохранители (жёсткие, без флагов-обхода):
 *   - тенант обязан быть SUSPENDED (сначала приостановите в панели/через API);
 *   - нельзя удалить дефолтного тенанта (DEFAULT_TENANT_ID/SLUG);
 *   - имя БД тенанта не должно совпадать с БД из DATABASE_URL или
 *     CONTROL_PLANE_DATABASE_URL (защита от сноса общей/реестровой БД).
 *
 * Шаги (идемпотентно/resumable — если БД уже удалена, снимает только запись):
 *   1) pg_dump БД тенанта → backups/tenants/<slug>-<ts>.sql (сеть безопасности);
 *   2) DROP DATABASE ... WITH (FORCE);
 *   3) удалить запись Tenant в control-plane (каскад доменов/модулей/миграции).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient as ControlPlaneClient } from '.prisma/control-plane-client';

interface Args {
  slug?: string;
  id?: string;
  confirm: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const single: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).trim();
    let value: string;
    if (eq >= 0) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Нет значения для --${key}`);
      }
      value = argv[++i]!;
    }
    single[key] = value;
  }
  const confirm = single.confirm;
  if (!confirm) throw new Error('Обязателен --confirm <slug> (подтверждение)');
  if (!single.slug && !single.id) {
    throw new Error('Укажите --slug или --id удаляемого тенанта');
  }
  return { slug: single.slug, id: single.id, confirm };
}

/** Имя БД из connection string (без ведущего слэша). */
function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cpUrl = process.env.CONTROL_PLANE_DATABASE_URL;
  if (!cpUrl) {
    throw new Error('CONTROL_PLANE_DATABASE_URL не задан — control-plane обязателен');
  }

  const cp = new ControlPlaneClient();
  try {
    const tenant = args.id
      ? await cp.tenant.findUnique({ where: { id: args.id } })
      : await cp.tenant.findUnique({ where: { slug: args.slug! } });
    if (!tenant) {
      throw new Error(`Тенант не найден (${args.id ?? args.slug})`);
    }

    // Гард: подтверждение совпадает со slug.
    if (args.confirm.trim() !== tenant.slug) {
      throw new Error(
        `--confirm "${args.confirm}" не совпадает со slug тенанта "${tenant.slug}"`,
      );
    }
    // Гард: только приостановленный (двухшаговость — сначала SUSPENDED).
    if (tenant.status !== 'SUSPENDED') {
      throw new Error(
        `Тенант "${tenant.slug}" в статусе ${tenant.status}: удаление только из SUSPENDED. Сначала приостановите.`,
      );
    }
    // Гард: не дефолтный тенант (single-tenant fallback).
    const defId = process.env.DEFAULT_TENANT_ID ?? 'default';
    const defSlug = process.env.DEFAULT_TENANT_SLUG ?? 'default';
    if (tenant.id === defId || tenant.slug === defSlug) {
      throw new Error('Дефолтного тенанта удалить нельзя');
    }

    const dbName = dbNameOf(tenant.dbUrl);
    // Гард: не снести общую БД приложения или реестр control-plane.
    const forbidden = new Set<string>();
    if (process.env.DATABASE_URL) forbidden.add(dbNameOf(process.env.DATABASE_URL));
    forbidden.add(dbNameOf(cpUrl));
    if (forbidden.has(dbName)) {
      throw new Error(
        `Отказ: БД "${dbName}" совпадает с общей/реестровой БД — удалять нельзя`,
      );
    }

    // Существует ли ещё БД тенанта? (resume после частичного удаления.)
    const dbRows = await cp.$queryRawUnsafe<Array<{ one: number }>>(
      'SELECT 1 AS one FROM pg_database WHERE datname = $1',
      dbName,
    );
    if (dbRows.length === 0) {
      console.log(`[1-2/3] БД "${dbName}" уже удалена — пропускаю backup/DROP (resume)`);
    } else {
      console.log(`[1/3] pg_dump "${dbName}" → backup`);
      const backupPath = dumpDatabase(tenant.slug, tenant.dbUrl);
      console.log(`BACKUP_PATH=${backupPath}`);

      console.log(`[2/3] DROP DATABASE "${dbName}" WITH (FORCE)`);
      await cp.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }

    console.log('[3/3] дерегистрация в control-plane (delete Tenant, каскад)');
    await cp.tenant.delete({ where: { id: tenant.id } });

    console.log(`\n✅ Тенант "${tenant.slug}" удалён (БД "${dbName}" дропнута).`);
  } finally {
    await cp.$disconnect();
  }
}

/**
 * pg_dump БД тенанта в backups/tenants/<slug>-<ts>.sql. Креды передаём через
 * PGPASSWORD (не в argv, CWE-214) и параметры соединения — флагами, а не URI:
 * URI может нести `?schema=...`, которого libpq/pg_dump не понимает.
 * Fail-closed: любая ошибка pg_dump → исключение (без бэкапа не дропаем).
 */
function dumpDatabase(slug: string, dbUrl: string): string {
  const u = new URL(dbUrl);
  const dir = path.join(process.cwd(), 'backups', 'tenants');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${slug}-${stamp}.sql`);
  execFileSync(
    'pg_dump',
    [
      '-h', u.hostname,
      '-p', u.port || '5432',
      '-U', decodeURIComponent(u.username),
      '-d', u.pathname.replace(/^\//, ''),
      '--no-owner',
      '--no-privileges',
      '-f', file,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
    },
  );
  return file;
}

main().catch((err) => {
  console.error('\n❌ delete-tenant failed:', (err as Error).message);
  process.exit(1);
});
