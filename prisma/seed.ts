/**
 * Seed-скрипт (Шаг 3).
 *
 * Заполняет справочники MVP: размеры, продукты, операции, сотрудники с
 * оборудованием и ячейками, базовые сдельные тарифы.
 *
 * Идемпотентен: повторный запуск не плодит дубликаты — используется `upsert`
 * по уникальным полям (`code`, `login`, `(operationId, productId, sizeId,
 * validFrom)` для PieceRate и т. п.).
 *
 * Запуск:
 *   npm run db:seed
 *   # или
 *   npx prisma db seed
 */

import {
  OperationCategory,
  Prisma,
  PrismaClient,
  Role,
} from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Общий демо-пароль для всех демо-учёток. Хранится в БД только как bcrypt-hash.
 * В проде заменяется на реальный флоу выдачи PIN/пароля.
 */
const DEMO_PASSWORD = 'Demo12345!';

// ---------------------------------------------------------------------------
// SIZES
// ---------------------------------------------------------------------------

const SIZES: readonly string[] = [
  '104',
  '110',
  '116',
  '122',
  '128',
  '134',
  '140',
  '146',
  '152',
  '158',
  '164',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
  '6XL',
];

async function seedSizes() {
  let created = 0;
  let updated = 0;
  for (let i = 0; i < SIZES.length; i += 1) {
    const code = SIZES[i];
    const sortOrder = (i + 1) * 10;
    const existing = await prisma.size.findUnique({ where: { code } });
    await prisma.size.upsert({
      where: { code },
      create: { code, sortOrder },
      update: { sortOrder },
    });
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: SIZES.length };
}

// ---------------------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------------------

/**
 * В текущей схеме `Product` не имеет поля `code`/`slug` — только `name`,
 * `color`, `active`. Используем `name` как стабильный ключ для идемпотентности.
 */
const PRODUCTS = [
  { slug: 'tshirt_white', name: 'Футболка белая', color: 'Белая' },
  { slug: 'tshirt_black', name: 'Футболка черная', color: 'Черная' },
] as const;

async function seedProducts() {
  let created = 0;
  let updated = 0;
  const byslug: Record<string, string> = {};
  for (const p of PRODUCTS) {
    const existing = await prisma.product.findFirst({ where: { name: p.name } });
    if (existing) {
      const upd = await prisma.product.update({
        where: { id: existing.id },
        data: { color: p.color, active: true },
      });
      byslug[p.slug] = upd.id;
      updated += 1;
    } else {
      const ins = await prisma.product.create({
        data: { name: p.name, color: p.color, active: true },
      });
      byslug[p.slug] = ins.id;
      created += 1;
    }
  }
  return { created, updated, total: PRODUCTS.length, byslug };
}

// ---------------------------------------------------------------------------
// OPERATIONS
// ---------------------------------------------------------------------------

type PricingModeSeed = 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY';

type OperationSeed = {
  code: string;
  name: string;
  category: OperationCategory;
  sortOrder: number;
  pricingMode: PricingModeSeed;
  /** Только для FIXED. Игнорируется иначе. */
  fixedRate?: number;
};

/**
 * Базовая бизнес-семантика (см. `docs/domain.md §16a`):
 *   - оверлок отличается по размеру → `BY_SIZE`;
 *   - остальные piecework (раскрой, киперка, распошив) — фиксированная
 *     ставка → `FIXED`;
 *   - подсобные/окладные операции (печать лекал, настил, ОТК, ВТО,
 *     упаковка и т.п.) — `SALARY_ONLY`, начисление не создаётся.
 *
 * Конкретные ставки специально консервативные демо-цифры: лежат в
 * допустимом диапазоне `Decimal(12,2)` и совпадают с adult-tier из
 * исторического `RATES_BY_OP`. Менеджер дальше правит их в
 * `/admin/operations`.
 */
const OPERATIONS: readonly OperationSeed[] = [
  { code: 'CUT_PATTERN_PRINT', name: 'Печать лекал',      category: 'CUTTING', sortOrder: 10,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_SPREADING',     name: 'Настил',            category: 'CUTTING', sortOrder: 20,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_CUT',           name: 'Раскрой',           category: 'CUTTING', sortOrder: 30,  pricingMode: 'FIXED',    fixedRate: 12.0 },
  { code: 'CUT_DIVISION',      name: 'Деление кроя',      category: 'CUTTING', sortOrder: 40,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_BASE_PREP',     name: 'Подготовка основы', category: 'CUTTING', sortOrder: 50,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_RIBANA_PREP',   name: 'Подготовка рибаны', category: 'CUTTING', sortOrder: 60,  pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_ISSUE',         name: 'Выдача кроя',       category: 'SEWING',  sortOrder: 70,  pricingMode: 'SALARY_ONLY' },
  { code: 'SEW_OVERLOCK_1',    name: 'Оверлок 1',         category: 'SEWING',  sortOrder: 80,  pricingMode: 'BY_SIZE' },
  { code: 'SEW_BINDING',       name: 'Киперка',           category: 'SEWING',  sortOrder: 90,  pricingMode: 'FIXED',    fixedRate: 9.0 },
  { code: 'SEW_OVERLOCK_2',    name: 'Оверлок 2',         category: 'SEWING',  sortOrder: 100, pricingMode: 'BY_SIZE' },
  { code: 'SEW_COVERSTITCH',   name: 'Распошив',          category: 'SEWING',  sortOrder: 110, pricingMode: 'FIXED',    fixedRate: 13.5 },
  { code: 'QC',                name: 'ОТК',               category: 'QC',      sortOrder: 120, pricingMode: 'SALARY_ONLY' },
  { code: 'WTO',               name: 'ВТО',               category: 'IRONING', sortOrder: 130, pricingMode: 'SALARY_ONLY' },
  { code: 'PACKING',           name: 'Упаковка',          category: 'PACKING', sortOrder: 140, pricingMode: 'SALARY_ONLY' },
];

/**
 * `Operation` upsert-ит и `pricingMode`/`fixedRate`.
 *
 * Сделано идемпотентно: каждый re-seed возвращает операции к
 * каноническому состоянию из `OPERATIONS`. Это намеренно — на dev/CI
 * мы хотим воспроизводимость; в проде seed не запускают, и
 * управление операциями идёт через `/admin/operations`.
 */
async function seedOperations() {
  let created = 0;
  let updated = 0;
  const byCode: Record<string, string> = {};
  for (const op of OPERATIONS) {
    const existing = await prisma.operation.findUnique({ where: { code: op.code } });
    const fixedRate =
      op.pricingMode === 'FIXED' && op.fixedRate !== undefined
        ? new Prisma.Decimal(op.fixedRate)
        : null;
    const upserted = await prisma.operation.upsert({
      where: { code: op.code },
      create: {
        code: op.code,
        name: op.name,
        category: op.category,
        sortOrder: op.sortOrder,
        active: true,
        pricingMode: op.pricingMode,
        fixedRate,
      },
      update: {
        name: op.name,
        category: op.category,
        sortOrder: op.sortOrder,
        active: true,
        pricingMode: op.pricingMode,
        fixedRate,
      },
    });
    byCode[op.code] = upserted.id;
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: OPERATIONS.length, byCode };
}

// ---------------------------------------------------------------------------
// USERS / EMPLOYEES
// ---------------------------------------------------------------------------

type EmployeeSeed = {
  login: string;
  fullName: string;
  role: Role;
  /**
   * Историческая месячная ставка `Employee.salaryBase`. На MVP runtime
   * её не читает — оставлена в схеме для будущего месячного payroll
   * (см. `docs/domain.md §9.1`). Здесь сохраняем на demo-аккаунтах,
   * чтобы карточка `/admin/employees/[id]` показывала привычные цифры.
   */
  salaryBase?: number;
  /**
   * Управленческий тип компенсации (ADR-0021) — единая ось «как
   * платим». Если не задан — берём безопасный дефолт `PIECEWORK`:
   * автогенерация окладных записей не запустится, пока менеджер сам
   * не переключит сотрудника. На demo мы явно выставляем SALARY/MIXED
   * для ОТК/ВТО/упаковки — чтобы UI окладов был «не пустым» сразу
   * после `db:seed`.
   */
  compensationType?: 'PIECEWORK' | 'SALARY' | 'MIXED';
  /** Ставка за смену; обязательна для SALARY/MIXED. */
  salaryPerShift?: number;
};

/**
 * В текущей модели `User` и `Employee` не разделены — есть одна таблица
 * `Employee` с `login` + `pinHash` + `role`. Если на следующем шаге
 * появится отдельный `User` (auth), seed можно будет расширить без
 * перестройки: `login` уже стабильный ключ.
 */
const EMPLOYEES: readonly EmployeeSeed[] = [
  { login: 'admin',         fullName: 'Демо Админ',              role: 'ADMIN',             salaryBase: 0 },
  { login: 'shop-chief',    fullName: 'Демо Начальник цеха',     role: 'SHOP_MANAGER',      salaryBase: 120_000 },
  { login: 'cutter',        fullName: 'Демо Раскройщик',         role: 'CUTTER',            compensationType: 'PIECEWORK' },
  { login: 'cutter-helper', fullName: 'Демо Помощник раскройщика', role: 'CUTTER_ASSISTANT', salaryBase: 70_000, compensationType: 'SALARY', salaryPerShift: 3_500 },
  { login: 'seamstress',    fullName: 'Демо Швея',               role: 'SEAMSTRESS',        compensationType: 'PIECEWORK' },
  // Вторая демо-швея для отладки сценариев с несколькими швеями на
  // смене (передача паспорта между операциями, очередь /work). Та же
  // роль / тип компенсации, что и `seamstress` — отличается только
  // login и fullName. Пароль — общий `DEMO_PASSWORD` (см. ниже).
  { login: 'seamstress2',   fullName: 'Демо Швея 2',             role: 'SEAMSTRESS',        compensationType: 'PIECEWORK' },
  { login: 'qc',            fullName: 'Демо ОТК',                role: 'QC',                salaryBase: 75_000, compensationType: 'SALARY', salaryPerShift: 3_750 },
  { login: 'wto',           fullName: 'Демо ВТО',                role: 'IRONING',           salaryBase: 70_000, compensationType: 'SALARY', salaryPerShift: 3_500 },
  { login: 'packer',        fullName: 'Демо Упаковщик',          role: 'PACKING',           salaryBase: 65_000, compensationType: 'SALARY', salaryPerShift: 3_250 },
  // Мастер цеха (MVP «Мастер цеха», см. `docs/domain.md §10a`).
  // Окладная роль: ставка за смену, без сдельных начислений. Логин
  // короткий, чтобы быстро вводить на телефоне.
  { login: 'master',        fullName: 'Демо Мастер цеха',        role: 'SHOPFLOOR_MASTER',  salaryBase: 80_000, compensationType: 'SALARY', salaryPerShift: 4_000 },
  // Аккаунт под большой экран цеха (shopfloor display). Роль read-only:
  // не считается ни в зарплате, ни в окладах — `compensationType: PIECEWORK`
  // (без авто-окладов), `salaryBase: 0`.
  { login: 'display',       fullName: 'Экран цеха',              role: 'DISPLAY',           salaryBase: 0 },
];

async function seedUsersEmployees() {
  const pinHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  let created = 0;
  let updated = 0;
  const byLogin: Record<string, string> = {};
  for (const e of EMPLOYEES) {
    const existing = await prisma.employee.findUnique({ where: { login: e.login } });
    const data = {
      fullName: e.fullName,
      role: e.role,
      salaryBase:
        e.salaryBase !== undefined ? new Prisma.Decimal(e.salaryBase) : null,
      compensationType: e.compensationType ?? 'PIECEWORK',
      salaryPerShift:
        e.salaryPerShift !== undefined
          ? new Prisma.Decimal(e.salaryPerShift)
          : null,
      active: true,
    };
    // MVP 1.1: re-seed всегда восстанавливает demo-пароль `DEMO_PASSWORD`,
    // чтобы инструкция «migrate + seed → залогиниться» всегда работала.
    // На prod seed не запускается — реальные пользователи создаются через
    // отдельный admin-flow (см. ADR-0014 §6).
    const upserted = await prisma.employee.upsert({
      where: { login: e.login },
      create: { login: e.login, pinHash, ...data },
      update: { ...data, pinHash },
    });
    byLogin[e.login] = upserted.id;
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: EMPLOYEES.length, byLogin };
}

// ---------------------------------------------------------------------------
// EQUIPMENT
// ---------------------------------------------------------------------------

/**
 * Источник истины для разрешённых операций оборудования — таблица
 * `EquipmentOperation` (см. ADR-0017). Здесь, рядом с самим списком
 * оборудования, держим стартовый набор связей: после `npm run db:seed`
 * швея на /work сразу видит на своём станке только релевантные операции.
 *
 * Поле `allowedOperations` — массив `Operation.code` (см. `OPERATIONS`).
 * Порядок задаёт `sortOrder` в `EquipmentOperation` (см. `seedEquipment`).
 */
/**
 * `displayNumber` — ручной порядковый номер для физической маркировки
 * станка (см. `Equipment.displayNumber` в `prisma/schema.prisma`,
 * ADR-0017, `docs/domain.md §5c`). Заводим стартовые номера, чтобы
 * после `npm run db:seed` начальник цеха сразу мог распечатать
 * QR-этикетки и наклеить на станки. Уникальность по типу станка
 * (№1 для оверлока, №1 для распошива) — это нормально и не глобальный
 * unique.
 *
 * Re-seed аккуратно с уже изменёнными вручную номерами: см.
 * `seedEquipment` ниже — мы перезаписываем `displayNumber` только
 * если это канонический номер из этого массива (т. е. dev-старт),
 * иначе оставляем то, что выставил начальник цеха.
 */
const EQUIPMENT: ReadonlyArray<{
  code: string;
  name: string;
  displayNumber: string;
  allowedOperations: readonly string[];
}> = [
  {
    code: 'cutting-table-01',
    name: 'Стол раскройный 01',
    displayNumber: '1',
    allowedOperations: [
      'CUT_DIVISION',
      'CUT_BASE_PREP',
      'CUT_RIBANA_PREP',
      'CUT_ISSUE',
    ],
  },
  { code: 'overlock-01',       name: 'Оверлок 01',                displayNumber: '1', allowedOperations: ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'] },
  { code: 'binding-01',        name: 'Машина киперка 01',         displayNumber: '1', allowedOperations: ['SEW_BINDING'] },
  { code: 'overlock-02',       name: 'Оверлок 02',                displayNumber: '2', allowedOperations: ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'] },
  { code: 'coverstitch-01',    name: 'Распошивальная 01',         displayNumber: '1', allowedOperations: ['SEW_COVERSTITCH'] },
  { code: 'qc-station-01',     name: 'Рабочее место ОТК 01',      displayNumber: '1', allowedOperations: ['QC'] },
  { code: 'wto-station-01',    name: 'Рабочее место ВТО 01',      displayNumber: '1', allowedOperations: ['WTO'] },
  { code: 'packing-station-01', name: 'Рабочее место упаковки 01', displayNumber: '1', allowedOperations: ['PACKING'] },
];

async function seedEquipment(opByCode: Record<string, string>) {
  let created = 0;
  let updated = 0;
  let linksCreated = 0;
  let linksKept = 0;
  for (const eq of EQUIPMENT) {
    // Две фазы: upsert (не зная id заранее), затем проставляем qrCode = equipment:{id}.
    const existing = await prisma.equipment.findUnique({ where: { code: eq.code } });
    // Идемпотентная стратегия для displayNumber:
    //   - если ряда ещё нет → создаём с каноничным номером из seed;
    //   - если ряд уже есть и displayNumber пустой (NULL/'') → проставляем
    //     каноничный номер (это типичный путь для существующих станков
    //     после первой миграции колонки);
    //   - если в БД уже стоит свой номер (например, начальник цеха задал
    //     «5» вручную в админке) — НЕ трогаем. Иначе re-seed
    //     перезатирал бы реальную физическую маркировку, что мы
    //     стараемся избегать (см. ADR-0017 §«Идемпотентность»).
    const shouldSetDisplayNumber =
      !existing ||
      existing.displayNumber === null ||
      existing.displayNumber === '';
    const row = await prisma.equipment.upsert({
      where: { code: eq.code },
      create: {
        code: eq.code,
        name: eq.name,
        displayNumber: eq.displayNumber,
        // qrCode UNIQUE NOT NULL — ставим временный плейсхолдер, сразу обновим ниже.
        qrCode: `equipment-pending:${eq.code}`,
        active: true,
      },
      update: shouldSetDisplayNumber
        ? { name: eq.name, active: true, displayNumber: eq.displayNumber }
        : { name: eq.name, active: true },
    });
    const targetQr = `equipment:${row.id}`;
    if (row.qrCode !== targetQr) {
      await prisma.equipment.update({
        where: { id: row.id },
        data: { qrCode: targetQr },
      });
    }
    if (existing) updated += 1;
    else created += 1;

    // Идемпотентный seed связей: для каждого ожидаемого Operation
    // добавляем строку, если её ещё нет. Лишнего НЕ удаляем — связи,
    // настроенные вручную в /admin/equipment, должны переживать
    // повторный seed (см. ADR-0017 §«Идемпотентность»).
    for (let i = 0; i < eq.allowedOperations.length; i += 1) {
      const opCode = eq.allowedOperations[i]!;
      const operationId = opByCode[opCode];
      if (!operationId) {
        throw new Error(
          `Equipment seed: unknown operation code "${opCode}" for "${eq.code}"`,
        );
      }
      const sortOrder = (i + 1) * 10;
      const link = await prisma.equipmentOperation.upsert({
        where: {
          EquipmentOperation_equipment_operation_uniq: {
            equipmentId: row.id,
            operationId,
          },
        },
        create: {
          equipmentId: row.id,
          operationId,
          sortOrder,
          isActive: true,
        },
        // Re-seed обновляет sortOrder/active под каноничный набор —
        // это полезно при правке seed; настройки, добавленные в админке
        // вручную, останутся в БД (они не пересекаются с этой парой).
        update: { sortOrder, isActive: true },
      });
      if (link.createdAt.getTime() === link.updatedAt.getTime()) linksCreated += 1;
      else linksKept += 1;
    }
  }
  return {
    created,
    updated,
    total: EQUIPMENT.length,
    linksCreated,
    linksKept,
  };
}

// ---------------------------------------------------------------------------
// CELLS
// ---------------------------------------------------------------------------

const CELLS = ['A1', 'A2', 'B1', 'B2'] as const;

async function seedCells() {
  let created = 0;
  let updated = 0;
  for (const code of CELLS) {
    const existing = await prisma.cell.findUnique({ where: { code } });
    const row = await prisma.cell.upsert({
      where: { code },
      create: {
        code,
        qrCode: `cell-pending:${code}`,
        active: true,
      },
      update: { active: true },
    });
    const targetQr = `cell:${row.id}`;
    if (row.qrCode !== targetQr) {
      await prisma.cell.update({
        where: { id: row.id },
        data: { qrCode: targetQr },
      });
    }
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: CELLS.length };
}

// ---------------------------------------------------------------------------
// OPERATION RATES BY SIZE (только для BY_SIZE-операций)
// ---------------------------------------------------------------------------

/**
 * Демо-цифры для BY_SIZE-операций (см. ADR-0017, `docs/domain.md §16a`).
 * Источник истины сдельных ставок — `OperationRateBySize`. Старая
 * таблица `PieceRate` оставлена в схеме как legacy-наблюдение, но новые
 * начисления (`EarningsService.resolveRate`) её не читают.
 *
 * Ставки в рублях за единицу (`Decimal(12,2)`). Тиры:
 *   - kids: 104..164 — детские размеры;
 *   - adult: XS..XL  — взрослые;
 *   - plus:  2XL..6XL — большие.
 */
type RateTier = 'kids' | 'adult' | 'plus';

const ADULT_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL']);
const PLUS_SIZES = new Set(['2XL', '3XL', '4XL', '5XL', '6XL']);

function tierOf(code: string): RateTier {
  if (ADULT_SIZES.has(code)) return 'adult';
  if (PLUS_SIZES.has(code)) return 'plus';
  return 'kids';
}

const RATES_BY_OP_BY_SIZE: Record<string, Record<RateTier, number>> = {
  SEW_OVERLOCK_1:  { kids: 10.0, adult: 15.0, plus: 18.0 },
  SEW_OVERLOCK_2:  { kids: 8.0,  adult: 12.0, plus: 15.0 },
};

async function seedOperationRatesBySize(opByCode: Record<string, string>) {
  let created = 0;
  let updated = 0;

  const sizes = await prisma.size.findMany({
    orderBy: { sortOrder: 'asc' },
  });

  let total = 0;
  for (const [opCode, rateByTier] of Object.entries(RATES_BY_OP_BY_SIZE)) {
    const operationId = opByCode[opCode];
    if (!operationId) {
      throw new Error(`Operation not found for code=${opCode}`);
    }
    for (const size of sizes) {
      total += 1;
      const rate = rateByTier[tierOf(size.code)];
      const existing = await prisma.operationRateBySize.findUnique({
        where: {
          OperationRateBySize_operation_size_uniq: {
            operationId,
            sizeId: size.id,
          },
        },
      });
      if (existing) {
        await prisma.operationRateBySize.update({
          where: { id: existing.id },
          data: { rate: new Prisma.Decimal(rate) },
        });
        updated += 1;
      } else {
        await prisma.operationRateBySize.create({
          data: {
            operationId,
            sizeId: size.id,
            rate: new Prisma.Decimal(rate),
          },
        });
        created += 1;
      }
    }
  }
  return { created, updated, total };
}

// ---------------------------------------------------------------------------
// DEFECT TYPES (Шаг 7)
// ---------------------------------------------------------------------------

/**
 * Минимальный справочник видов брака для MVP. Идемпотентен по `code`.
 * Расширять можно через админ-UI на следующих шагах. См. docs/domain.md §10.
 */
const DEFECT_TYPES = [
  { code: 'STAIN',         name: 'Пятно',           sortOrder: 10 },
  { code: 'HOLE',          name: 'Дырка',           sortOrder: 20 },
  { code: 'CROOKED_SEAM',  name: 'Неровный шов',    sortOrder: 30 },
  { code: 'SKEW',          name: 'Перекос',         sortOrder: 40 },
  { code: 'INCOMPLETE',    name: 'Недокомплект',    sortOrder: 50 },
  { code: 'OTHER',         name: 'Прочее',          sortOrder: 100 },
] as const;

async function seedDefectTypes() {
  let created = 0;
  let updated = 0;
  for (const d of DEFECT_TYPES) {
    const existing = await prisma.defectType.findUnique({
      where: { code: d.code },
    });
    await prisma.defectType.upsert({
      where: { code: d.code },
      create: {
        code: d.code,
        name: d.name,
        sortOrder: d.sortOrder,
        isActive: true,
      },
      update: {
        name: d.name,
        sortOrder: d.sortOrder,
        isActive: true,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: DEFECT_TYPES.length };
}

// ---------------------------------------------------------------------------
// COMPANY DIVISIONS (master-справочник подразделений заказа / display screens)
// ---------------------------------------------------------------------------

/**
 * PHASE 1 «CompanyDivision как master-справочник» (см.
 * `docs/domain.md §«Подразделения заказа»`,
 * `docs/erd.md §«CompanyDivision»`): идемпотентно создаёт базовые
 * карточки `MARKETPLACE` и `OTHER` (B2B), на которые ссылаются
 * `Order.companyDivisionId` и `DisplayScreenConfig.companyDivisionId`.
 *
 * `code` уникален и используется как ключ синхронизации с legacy
 * `enum OrderDivision`. Имена (`Маркетплейс`, `B2B`) уже выровнены с
 * лейблами `ORDER_DIVISION_LABELS` (см.
 * `packages/shared/src/orders.ts`).
 *
 * Re-seed аккуратен с менеджерскими правками: если карточка уже есть,
 * обновляются только `name`/`sortOrder`/`isActive` к каноничным
 * значениям, а `description` сохраняется (`undefined` в `update`
 * — Prisma не трогает колонку).
 */
const COMPANY_DIVISIONS: ReadonlyArray<{
  code: string;
  name: string;
  sortOrder: number;
}> = [
  { code: 'MARKETPLACE', name: 'Маркетплейс', sortOrder: 10 },
  { code: 'OTHER', name: 'B2B', sortOrder: 20 },
];

async function seedCompanyDivisions() {
  let created = 0;
  let updated = 0;
  for (const d of COMPANY_DIVISIONS) {
    const existing = await prisma.companyDivision.findUnique({
      where: { code: d.code },
    });
    await prisma.companyDivision.upsert({
      where: { code: d.code },
      create: {
        code: d.code,
        name: d.name,
        sortOrder: d.sortOrder,
        isActive: true,
      },
      update: {
        name: d.name,
        sortOrder: d.sortOrder,
        isActive: true,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }
  return { created, updated, total: COMPANY_DIVISIONS.length };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log('→ Seeding sizes…');
  const sizes = await seedSizes();
  console.log('→ Seeding products…');
  const products = await seedProducts();
  console.log('→ Seeding operations…');
  const ops = await seedOperations();
  console.log('→ Seeding employees…');
  const employees = await seedUsersEmployees();
  console.log('→ Seeding equipment…');
  const equipment = await seedEquipment(ops.byCode);
  console.log('→ Seeding cells…');
  const cells = await seedCells();
  console.log('→ Seeding operation rates by size…');
  const rates = await seedOperationRatesBySize(ops.byCode);
  console.log('→ Seeding defect types…');
  const defects = await seedDefectTypes();
  console.log('→ Seeding company divisions…');
  const divisions = await seedCompanyDivisions();

  console.log('\n================ SEED SUMMARY ================');
  console.log(`Sizes:       total=${sizes.total}      created=${sizes.created}  updated=${sizes.updated}`);
  console.log(`Products:    total=${products.total}   created=${products.created}  updated=${products.updated}`);
  console.log(`Operations:  total=${ops.total}        created=${ops.created}  updated=${ops.updated}`);
  console.log(`Employees:   total=${employees.total}  created=${employees.created}  updated=${employees.updated}`);
  console.log(`Equipment:   total=${equipment.total}  created=${equipment.created}  updated=${equipment.updated}  links+${equipment.linksCreated}  keep=${equipment.linksKept}`);
  console.log(`Cells:       total=${cells.total}      created=${cells.created}  updated=${cells.updated}`);
  console.log(`OperationRatesBySize: total=${rates.total} created=${rates.created} updated=${rates.updated}`);
  console.log(`DefectTypes: total=${defects.total}    created=${defects.created}  updated=${defects.updated}`);
  console.log(`CompanyDivisions: total=${divisions.total} created=${divisions.created} updated=${divisions.updated}`);
  console.log('==============================================\n');
  console.log('Demo password for all demo logins:', DEMO_PASSWORD);
  console.log('Demo logins:', EMPLOYEES.map((e) => e.login).join(', '));
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
