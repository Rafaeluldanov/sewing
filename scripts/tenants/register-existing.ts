/**
 * Регистрация УЖЕ существующей (мигрированной и засеянной) БД как тенанта
 * в control-plane — без CREATE DATABASE / migrate / seed.
 *
 * Главный кейс: первый («дефолтный») тенант при включении control-plane —
 * текущая прод/dev-БД уже живёт, её надо просто внести в реестр и привязать
 * домены, чтобы резолвер начал её находить.
 *
 *   docker exec -e CONTROL_PLANE_DATABASE_URL=... -e DATABASE_URL=... \
 *     sewing-api-1 npx tsx scripts/tenants/register-existing.ts \
 *       --slug default --name "Основная компания" \
 *       --host api --host localhost --host dev.teeon.ru
 *
 * `--db-url` приоритетнее, иначе берётся DATABASE_URL. Повторный запуск
 * обновляет name/dbUrl и доустанавливает недостающие домены (idempotent).
 */
import { PrismaClient as ControlPlaneClient } from '.prisma/control-plane-client';
import { latestMigration } from './migrations-util.js';

function parse(): {
  slug: string;
  name: string;
  dbUrl: string;
  hosts: string[];
} {
  const argv = process.argv.slice(2);
  const single: Record<string, string> = {};
  const hosts: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (!t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    const key = (eq >= 0 ? t.slice(2, eq) : t.slice(2)).trim();
    let value: string | undefined;
    if (eq >= 0) {
      value = t.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`Нет значения для --${key}`);
      }
      value = argv[++i];
    }
    if (key === 'host') hosts.push(value);
    else single[key] = value;
  }
  const slug = single.slug;
  const name = single.name;
  if (!slug || !name) throw new Error('Обязательны --slug и --name');
  const dbUrl = single['db-url'] ?? process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('Нужен --db-url или DATABASE_URL');
  if (hosts.length === 0) throw new Error('Нужен хотя бы один --host');
  return { slug, name, dbUrl, hosts: hosts.map((h) => h.trim().toLowerCase()) };
}

async function main(): Promise<void> {
  if (!process.env.CONTROL_PLANE_DATABASE_URL) {
    throw new Error('CONTROL_PLANE_DATABASE_URL не задан');
  }
  const { slug, name, dbUrl, hosts } = parse();
  const cp = new ControlPlaneClient();
  try {
    const tenant = await cp.tenant.upsert({
      where: { slug },
      create: {
        slug,
        name,
        dbUrl,
        status: 'ACTIVE',
        migration: { create: { lastMigration: latestMigration(), lastStatus: 'ok' } },
      },
      update: { name, dbUrl, status: 'ACTIVE' },
    });
    for (let i = 0; i < hosts.length; i += 1) {
      const host = hosts[i]!;
      await cp.tenantDomain.upsert({
        where: { host },
        create: { host, tenantId: tenant.id, isPrimary: i === 0 },
        update: { tenantId: tenant.id },
      });
    }
    console.log(
      `✅ Тенант "${slug}" зарегистрирован (${tenant.id}). Домены: ${hosts.join(', ')}`,
    );
  } finally {
    await cp.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ register-existing:', (err as Error).message);
  process.exit(1);
});
