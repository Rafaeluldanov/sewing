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
    'AuditLog',
    // PHASE 3 «PayrollPayout»: выплаты + строки. Подчинены `Employee`
    // (несколько relation-ов: employee/createdBy/issuedBy/...). Без
    // явного truncate `TRUNCATE Employee CASCADE` всё равно бы их
    // снёс, но явный список читабельнее и страхует от случайной
    // потери CASCADE-связи в будущем.
    'PayrollPayoutLine',
    'PayrollPayout',
    // Этап «Себестоимость заказа»: история расчётов + строки.
    // Подчинены `Order` через `ON DELETE CASCADE`, но truncate явный
    // ради читаемости и стабильности (UNIQUE `(orderId, version)`
    // — зомби-строки между тестами могли бы конфликтовать с
    // повторными completeCalculation в одном test-suite).
    'OrderCostEstimateLine',
    'OrderCostEstimate',
    // Этап 6А «Заказы поставщикам»: PO-документ + строки. Truncate
    // явный, потому что `customerOrderId` стоит `ON DELETE SET NULL`,
    // и каскад от `Order` сам PO не убил бы (зомби осталось бы между
    // тестами и ломало UNIQUE-номер `PurchaseOrder.number`).
    'PurchaseOrderLine',
    'PurchaseOrder',
    // Этап 5 «Поставщики»: справочник + каталог + контакты. Truncate
    // обязателен: на `Supplier.name` стоит UNIQUE, и зомби-строка из
    // прошлого теста отбила бы повторную вставку с `P2002`.
    'SupplierCatalogItem',
    'SupplierContact',
    'Supplier',
    'CutReleasePolicy',
    'MasterCall',
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
    'OrderMaterialRequirement',
    'OrderOutsourceRequirement',
    // Этап «Нанесение на заказе покупателя»: заказные нанесения,
    // подчинены `Order` через `ON DELETE CASCADE`. Truncate явный
    // ради читаемости и стабильности списка.
    'OrderApplication',
    // Этап «Ручная отметка поступления материала» (см.
    // `apps/api/src/modules/order-material-arrivals/*`,
    // `prisma/schema.prisma::OrderMaterialArrivalOverride`):
    // override готовности к крою, подчинён `Order` через
    // `ON DELETE CASCADE`. Truncate явный ради читаемости.
    'OrderMaterialArrivalOverride',
    // Этап 4А «Потребность цеха»: одна строка на материал заказа,
    // подчинена `Order` через `ON DELETE CASCADE`. Truncate явный
    // ради читаемости, хотя CASCADE на `"Order"` ниже сделал бы то же.
    'WorkshopNeed',
    'OrderItem',
    '"Order"',
    // MVP-1 «Лекала»: справочные таблицы лекала. Truncate обязателен,
    // потому что у `PatternItem.article` стоит UNIQUE — если оставить
    // от прошлого теста запись с `P-DEMO-1`, следующий тест получит
    // `P2002` на повторной вставке.
    'PatternMaterialArea',
    // Этап «Погонные метры по размерам»: numeric-by-size значения,
    // подчинены `PatternItem`/`PatternCategoryParameter`/`Size` через
    // `ON DELETE CASCADE`, но truncate явный — для читаемости.
    'PatternItemSizeParameterValue',
    'PatternSizeFile',
    'PatternItem',
    // Этап «Категории номенклатуры»: справочник категорий + параметры.
    // Параметры удалятся каскадом от `PatternCategory`
    // (`ON DELETE CASCADE`), но truncate явный ради читаемости.
    'PatternCategoryParameter',
    'PatternCategory',
    'TechCardMaterialLine',
    'TechCardOutsourceLine',
    'TechCardTemplate',
    'PrintJob',
    'Printer',
    'ShiftSession',
    'OperationRateBySize',
    // Этап 1 «Нормы времени операции» (recon §10): отдельная таблица
    // для плановых норм времени по размеру. Подчинена `Operation`
    // через `ON DELETE CASCADE`, но truncate явный ради читаемости.
    'OperationTimeNormBySize',
    'RouteTemplateStep',
    'RouteTemplate',
    'Cell',
    'WarehouseLine',
    'Warehouse',
    'EquipmentOperation',
    'Equipment',
    'DisplayScreenConfig',
    'Employee',
    'Operation',
    'Product',
    'Size',
    'DefectType',
    // Управленческий справочник `Client` живёт независимо от
    // паспорт-флоу: на него ссылается только `Order.clientId`
    // (с `ON DELETE SET NULL`). Truncate здесь нужен, чтобы тесты,
    // создающие клиентов в `beforeEach`, начинали с чистой таблицы.
    'Client',
    // PHASE 1 «CompanyDivision как master-справочник» (см.
    // `prisma/schema.prisma::CompanyDivision`,
    // `tests/utils/seed.ts::seedMinimal`): справочник подразделений,
    // на который ссылаются `Order.companyDivisionId` и
    // `DisplayScreenConfig.companyDivisionId`. Truncate явный, чтобы
    // повторный seed `MARKETPLACE`/`OTHER` шёл с пустой таблицы и
    // FK с предыдущего теста не «висел» на освобождённом id.
    'CompanyDivision',
  ];
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => (t.startsWith('"') ? t : `"${t}"`)).join(', ')} RESTART IDENTITY CASCADE`,
  );
}
