/**
 * DB-помощники для интеграционных тестов MVP 1.1.
 *
 * Тесты, которым нужна реальная PostgreSQL, читают `TEST_DATABASE_URL`.
 * Если переменной нет — `describeWithDb` превращается в `describe.skip`,
 * чтобы локальный `npm test` не падал на чистом окружении.
 *
 * Перед каждым тестом БД полностью очищается (`truncate`) и заново
 * сидируется через `prisma/seed.ts`, чтобы:
 *   - тесты были независимы (порядок не имеет значения);
 *   - инварианты вроде уникальных номеров заказов проверялись с нуля;
 *   - не оставалось мусора между прогонами.
 */
import { describe, type SuiteAPI } from 'vitest';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (TEST_DATABASE_URL) {
  // Передаём строку Prisma-клиенту: проще всего через DATABASE_URL,
  // т.к. seed.ts и AppModule читают именно её.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // На тестах хотим короткий TTL для cookie, и фиксированный JWT_SECRET.
  process.env.JWT_SECRET ??= 'test-secret-please-do-not-use-in-prod';
  process.env.JWT_EXPIRES_IN ??= '1h';
}

/**
 * Аналог `describe`, который самоустраняется, если `TEST_DATABASE_URL`
 * не задан. Используем во всех integration-сьютах.
 */
export const describeWithDb: SuiteAPI = (TEST_DATABASE_URL
  ? describe
  : (describe.skip as unknown as SuiteAPI));

/**
 * Полностью очищает все таблицы домена и заново применяет seed.
 * Идемпотентно — можно звать в `beforeEach`.
 */
export async function resetDatabase(prisma: {
  $executeRawUnsafe: (sql: string) => Promise<unknown>;
}): Promise<void> {
  // TRUNCATE с CASCADE снимает FK и быстрее, чем serial DELETE.
  // Список таблиц синхронизирован с `prisma/schema.prisma`.
  const tables = [
    'PassportDefect',
    'OperationEntry',
    'SalaryEntry',
    'BoxItem',
    'Box',
    'PassportEvent',
    'CellContent',
    'Passport',
    'CuttingClosureRequest',
    'OrderRouteStep',
    'OrderItem',
    '"Order"',
    'PrintJob',
    'Printer',
    'ShiftSession',
    'PieceRate',
    'OperationRateBySize',
    'RouteTemplateStep',
    'RouteTemplate',
    'Cell',
    'WarehouseLine',
    'Warehouse',
    'EquipmentOperation',
    'Equipment',
    'Employee',
    'Operation',
    'Product',
    'Size',
    'DefectType',
  ];
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => (t.startsWith('"') ? t : `"${t}"`)).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
