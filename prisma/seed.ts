/**
 * Seed-скрипт (Шаг 3).
 *
 * Заполняет справочники MVP: размеры, продукты, операции, сотрудники с
 * оборудованием и ячейками, базовые сдельные тарифы.
 *
 * Идемпотентен: повторный запуск не плодит дубликаты — используется `upsert`
 * по уникальным полям (`code`, `login`,
 * `(operationId, sizeId)` для `OperationRateBySize` и т. п.).
 *
 * Запуск:
 *   npm run db:seed
 *   # или
 *   npx prisma db seed
 */

import { Prisma, PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import {
  REFERENCE_OPERATIONS,
  REFERENCE_SIZES,
  type ReferenceOperationSeed,
} from '../apps/api/src/modules/bootstrap/reference-data.js';

const prisma = new PrismaClient();

/**
 * Общий демо-пароль для всех демо-учёток. Хранится в БД только как bcrypt-hash.
 * В проде заменяется на реальный флоу выдачи PIN/пароля.
 */
const DEMO_PASSWORD = 'Demo12345!';

// ---------------------------------------------------------------------------
// SIZES
// ---------------------------------------------------------------------------

/**
 * Канонический список размеров — единственный источник истины
 * (`apps/api/src/modules/bootstrap/reference-data.ts`). Тот же массив
 * читает `ReferenceDataBootstrapService` на старте API; здесь —
 * стандартный re-seed с обновлением `sortOrder` (на dev/CI мы хотим
 * воспроизводимость).
 */
const SIZES: readonly string[] = REFERENCE_SIZES;

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

/**
 * Канонический список операций — единственный источник истины
 * (`apps/api/src/modules/bootstrap/reference-data.ts`). Тот же массив
 * читает `ReferenceDataBootstrapService` на старте API; здесь —
 * полный re-seed с обновлением полей (на dev/CI мы хотим
 * воспроизводимость).
 *
 * `OperationCategory` (Prisma-enum) совместим со строковыми
 * литералами в `REFERENCE_OPERATIONS` (см. enum `OperationCategory`
 * в `prisma/schema.prisma`).
 */
type OperationSeed = ReferenceOperationSeed;
const OPERATIONS: readonly OperationSeed[] = REFERENCE_OPERATIONS;

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
  { login: 'admin',         fullName: 'Демо Админ',              role: 'ADMIN' },
  { login: 'shop-chief',    fullName: 'Демо Начальник цеха',     role: 'SHOP_MANAGER' },
  { login: 'cutter',        fullName: 'Демо Раскройщик',         role: 'CUTTER',            compensationType: 'PIECEWORK' },
  { login: 'cutter-helper', fullName: 'Демо Помощник раскройщика', role: 'CUTTER_ASSISTANT', compensationType: 'SALARY', salaryPerShift: 3_500 },
  { login: 'seamstress',    fullName: 'Демо Швея',               role: 'SEAMSTRESS',        compensationType: 'PIECEWORK' },
  // Вторая демо-швея для отладки сценариев с несколькими швеями на
  // смене (передача паспорта между операциями, очередь /work). Та же
  // роль / тип компенсации, что и `seamstress` — отличается только
  // login и fullName. Пароль — общий `DEMO_PASSWORD` (см. ниже).
  { login: 'seamstress2',   fullName: 'Демо Швея 2',             role: 'SEAMSTRESS',        compensationType: 'PIECEWORK' },
  { login: 'qc',            fullName: 'Демо ОТК',                role: 'QC',                compensationType: 'SALARY', salaryPerShift: 3_750 },
  { login: 'wto',           fullName: 'Демо ВТО',                role: 'IRONING',           compensationType: 'SALARY', salaryPerShift: 3_500 },
  { login: 'packer',        fullName: 'Демо Упаковщик',          role: 'PACKING',           compensationType: 'SALARY', salaryPerShift: 3_250 },
  // Мастер цеха (MVP «Мастер цеха», см. `docs/domain.md §10a`).
  // Окладная роль: ставка за смену, без сдельных начислений. Логин
  // короткий, чтобы быстро вводить на телефоне.
  { login: 'master',        fullName: 'Демо Мастер цеха',        role: 'SHOPFLOOR_MASTER',  compensationType: 'SALARY', salaryPerShift: 4_000 },
  // Аккаунт под большой экран цеха (shopfloor display). Роль read-only:
  // не считается ни в зарплате, ни в окладах — `compensationType: PIECEWORK`
  // (без авто-окладов).
  { login: 'display',       fullName: 'Экран цеха',              role: 'DISPLAY' },
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
  /**
   * Роль «рабочего места» (фича «смена роли сканом», `Equipment.role`).
   * Сканируя QR станка/участка, сотрудник переключается на терминал
   * этой роли. Раскройный стол → CUTTER, швейные станки → SEAMSTRESS,
   * участки ОТК/ВТО/Упаковки → QC/IRONING/PACKING.
   */
  role: Role;
  allowedOperations: readonly string[];
}> = [
  {
    code: 'cutting-table-01',
    name: 'Стол раскройный 01',
    displayNumber: '1',
    role: 'CUTTER',
    allowedOperations: [
      'CUT_DIVISION',
      'CUT_BASE_PREP',
      'CUT_RIBANA_PREP',
      'CUT_ISSUE',
    ],
  },
  { code: 'overlock-01',       name: 'Оверлок 01',                displayNumber: '1', role: 'SEAMSTRESS', allowedOperations: ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'] },
  { code: 'binding-01',        name: 'Машина киперка 01',         displayNumber: '1', role: 'SEAMSTRESS', allowedOperations: ['SEW_BINDING'] },
  { code: 'overlock-02',       name: 'Оверлок 02',                displayNumber: '2', role: 'SEAMSTRESS', allowedOperations: ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'] },
  { code: 'coverstitch-01',    name: 'Распошивальная 01',         displayNumber: '1', role: 'SEAMSTRESS', allowedOperations: ['SEW_COVERSTITCH'] },
  { code: 'qc-station-01',     name: 'Рабочее место ОТК 01',      displayNumber: '1', role: 'QC',        allowedOperations: ['QC'] },
  { code: 'wto-station-01',    name: 'Рабочее место ВТО 01',      displayNumber: '1', role: 'IRONING',   allowedOperations: ['WTO'] },
  { code: 'packing-station-01', name: 'Рабочее место упаковки 01', displayNumber: '1', role: 'PACKING',   allowedOperations: ['PACKING'] },
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
    // Роль рабочего места (фича «смена роли сканом»): на create ставим
    // каноничную из seed; на update — только если в БД ещё пусто
    // (NULL), чтобы re-seed не затирал роль, заданную вручную в админке.
    const shouldSetRole = !existing || existing.role === null;
    const row = await prisma.equipment.upsert({
      where: { code: eq.code },
      create: {
        code: eq.code,
        name: eq.name,
        displayNumber: eq.displayNumber,
        role: eq.role,
        // qrCode UNIQUE NOT NULL — ставим временный плейсхолдер, сразу обновим ниже.
        qrCode: `equipment-pending:${eq.code}`,
        active: true,
      },
      update: {
        name: eq.name,
        active: true,
        ...(shouldSetDisplayNumber ? { displayNumber: eq.displayNumber } : {}),
        ...(shouldSetRole ? { role: eq.role } : {}),
      },
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
 * Источник истины сдельных ставок — `OperationRateBySize`. Историческая
 * таблица `PieceRate` удалена в PHASE 2 STEP 1 (см. ADR-0020 §«PHASE 2 —
 * drop legacy»).
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
// PATTERN CATEGORIES + PARAMETERS (этап «Категории номенклатуры»)
// ---------------------------------------------------------------------------

/**
 * Демо-категории номенклатуры с набором параметров (см. модели
 * `PatternCategory` / `PatternCategoryParameter` и
 * `packages/shared/src/pattern-categories.ts`):
 *   - HOODIE / SHIRT / PANTS — три тип-«раскладки» MVP-каталога;
 *   - параметры покрывают: основной материал, рибана/подклад (площади м²),
 *     нитки (текст-описание), фурнитуру (молния/шнур/бирка/пуговицы —
 *     QTY_PER_ITEM).
 *
 * `slug` уникален в БД — используется как ключ идемпотентности при re-seed.
 */
type CategoryParamSeed = {
  paramKey: string; // локальный ключ внутри категории (для линка из лекал)
  roleKey: string;
  label: string;
  inputType: 'AREA_M2_BY_SIZE' | 'LINEAR_M_BY_SIZE' | 'QTY_PER_ITEM' | 'TEXT_ONLY';
  unit: string;
  isRequired?: boolean;
  sortOrder: number;
};

type CategorySeed = {
  code: string; // локальный ключ для линка из лекал
  slug: string;
  name: string;
  iconKey: string;
  sortOrder: number;
  description?: string;
  parameters: CategoryParamSeed[];
};

const PATTERN_CATEGORIES: readonly CategorySeed[] = [
  {
    code: 'HOODIE',
    slug: 'hoodie',
    name: 'Худи',
    iconKey: 'HOODIE',
    sortOrder: 10,
    description: 'Худи / толстовка с капюшоном',
    parameters: [
      { paramKey: 'main', roleKey: 'MAIN_FABRIC', label: 'Основной материал', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', isRequired: true, sortOrder: 10 },
      { paramKey: 'rib', roleKey: 'RIB', label: 'Кашкорсе', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', sortOrder: 20 },
      { paramKey: 'thread', roleKey: 'THREAD', label: 'Нитки', inputType: 'TEXT_ONLY', unit: '', sortOrder: 30 },
      { paramKey: 'zipper', roleKey: 'PACKAGING', label: 'Молния', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 40 },
      { paramKey: 'cord', roleKey: 'PACKAGING', label: 'Шнур', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 50 },
      { paramKey: 'tips', roleKey: 'PACKAGING', label: 'Наконечники', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 60 },
    ],
  },
  {
    code: 'SHIRT',
    slug: 'tshirt',
    name: 'Футболка',
    iconKey: 'SHIRT',
    sortOrder: 20,
    description: 'Футболка / лонгслив',
    parameters: [
      { paramKey: 'main', roleKey: 'MAIN_FABRIC', label: 'Основной материал', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', isRequired: true, sortOrder: 10 },
      { paramKey: 'rib', roleKey: 'RIB', label: 'Воротник (рибана)', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', sortOrder: 20 },
      { paramKey: 'thread', roleKey: 'THREAD', label: 'Нитки', inputType: 'TEXT_ONLY', unit: '', sortOrder: 30 },
      { paramKey: 'tag', roleKey: 'PACKAGING', label: 'Бирка', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 40 },
    ],
  },
  {
    code: 'PANTS',
    slug: 'pants',
    name: 'Брюки',
    iconKey: 'PANTS',
    sortOrder: 30,
    description: 'Брюки / штаны спортивные',
    parameters: [
      { paramKey: 'main', roleKey: 'MAIN_FABRIC', label: 'Основной материал', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', isRequired: true, sortOrder: 10 },
      { paramKey: 'lining', roleKey: 'LINING', label: 'Подклад', inputType: 'AREA_M2_BY_SIZE', unit: 'м²', sortOrder: 20 },
      { paramKey: 'thread', roleKey: 'THREAD', label: 'Нитки', inputType: 'TEXT_ONLY', unit: '', sortOrder: 30 },
      { paramKey: 'cord', roleKey: 'PACKAGING', label: 'Шнур', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 40 },
      { paramKey: 'buttons', roleKey: 'PACKAGING', label: 'Пуговицы', inputType: 'QTY_PER_ITEM', unit: 'шт', sortOrder: 50 },
    ],
  },
];

interface SeededCategory {
  id: string;
  paramIdsByKey: Record<string, string>;
}

async function seedPatternCategories(): Promise<{
  created: number;
  updated: number;
  total: number;
  paramsCreated: number;
  paramsUpdated: number;
  byCode: Record<string, SeededCategory>;
}> {
  let created = 0;
  let updated = 0;
  let paramsCreated = 0;
  let paramsUpdated = 0;
  const byCode: Record<string, SeededCategory> = {};

  for (const cat of PATTERN_CATEGORIES) {
    const existing = await prisma.patternCategory.findUnique({
      where: { slug: cat.slug },
    });
    const upserted = await prisma.patternCategory.upsert({
      where: { slug: cat.slug },
      create: {
        name: cat.name,
        slug: cat.slug,
        iconKey: cat.iconKey,
        sortOrder: cat.sortOrder,
        status: 'ACTIVE',
        description: cat.description ?? null,
      },
      update: {
        name: cat.name,
        iconKey: cat.iconKey,
        sortOrder: cat.sortOrder,
        status: 'ACTIVE',
        description: cat.description ?? null,
      },
    });
    if (existing) updated += 1;
    else created += 1;

    const paramIdsByKey: Record<string, string> = {};
    // Параметры: уникальность `(categoryId, roleKey, label)` не enforce-ится
    // на уровне БД (см. комментарий у модели). Идемпотентность обеспечиваем
    // вручную через `findFirst` по тройке.
    for (const p of cat.parameters) {
      const existingParam = await prisma.patternCategoryParameter.findFirst({
        where: {
          categoryId: upserted.id,
          roleKey: p.roleKey,
          label: p.label,
        },
      });
      if (existingParam) {
        const upd = await prisma.patternCategoryParameter.update({
          where: { id: existingParam.id },
          data: {
            inputType: p.inputType,
            unit: p.unit,
            isRequired: p.isRequired ?? false,
            sortOrder: p.sortOrder,
            status: 'ACTIVE',
          },
        });
        paramIdsByKey[p.paramKey] = upd.id;
        paramsUpdated += 1;
      } else {
        const ins = await prisma.patternCategoryParameter.create({
          data: {
            categoryId: upserted.id,
            roleKey: p.roleKey,
            label: p.label,
            inputType: p.inputType,
            unit: p.unit,
            isRequired: p.isRequired ?? false,
            sortOrder: p.sortOrder,
            status: 'ACTIVE',
          },
        });
        paramIdsByKey[p.paramKey] = ins.id;
        paramsCreated += 1;
      }
    }

    byCode[cat.code] = { id: upserted.id, paramIdsByKey };
  }

  return {
    created,
    updated,
    total: PATTERN_CATEGORIES.length,
    paramsCreated,
    paramsUpdated,
    byCode,
  };
}

// ---------------------------------------------------------------------------
// PATTERN ITEMS (Лекала) + площади + фурнитурные нормы
// ---------------------------------------------------------------------------

/**
 * Демо-лекала с привязкой к категории. Для удобства проверок UI
 * добавлены площади основного материала по 4 размерам (XS/S/M/L) и
 * нормы фурнитуры на изделие — этого достаточно, чтобы экраны
 * `/admin/patterns/[id]` (площади, нормы) и `WorkshopNeedsService`
 * видели реальные значения.
 */
type PatternItemSeed = {
  article: string;
  name: string;
  categoryCode: string; // ссылка на CategorySeed.code
  description?: string;
  /** Площади м² по `(roleKey, sizeCode)`. */
  materialAreas: Array<{
    paramKey: string; // должен существовать в paramIdsByKey категории
    roleKey: string;
    bySize: Record<string, number>; // sizeCode → м²
  }>;
  /** Нормы «количество на изделие» по фурнитуре. */
  parameterNorms: Array<{ paramKey: string; qtyPerItem: number }>;
  /** Опциональная привязка к legacy-Product (по slug из PRODUCTS). */
  legacyProductSlug?: string;
};

const PATTERN_ITEMS: readonly PatternItemSeed[] = [
  {
    article: 'HOODIE-CLASSIC-001',
    name: 'Худи классический',
    categoryCode: 'HOODIE',
    description: 'Демо-лекало: классический худи с капюшоном на молнии.',
    materialAreas: [
      {
        paramKey: 'main',
        roleKey: 'MAIN_FABRIC',
        bySize: { XS: 1.85, S: 1.95, M: 2.1, L: 2.25, XL: 2.4 },
      },
      {
        paramKey: 'rib',
        roleKey: 'RIB',
        bySize: { XS: 0.18, S: 0.2, M: 0.22, L: 0.24, XL: 0.26 },
      },
    ],
    parameterNorms: [
      { paramKey: 'zipper', qtyPerItem: 1 },
      { paramKey: 'cord', qtyPerItem: 1 },
      { paramKey: 'tips', qtyPerItem: 2 },
    ],
  },
  {
    article: 'TSHIRT-WHITE-001',
    name: 'Футболка белая',
    categoryCode: 'SHIRT',
    description: 'Демо-лекало: базовая белая футболка.',
    legacyProductSlug: 'tshirt_white',
    materialAreas: [
      {
        paramKey: 'main',
        roleKey: 'MAIN_FABRIC',
        bySize: { XS: 0.95, S: 1.05, M: 1.15, L: 1.25, XL: 1.35 },
      },
      {
        paramKey: 'rib',
        roleKey: 'RIB',
        bySize: { XS: 0.05, S: 0.06, M: 0.07, L: 0.08, XL: 0.09 },
      },
    ],
    parameterNorms: [{ paramKey: 'tag', qtyPerItem: 1 }],
  },
  {
    article: 'TSHIRT-BLACK-001',
    name: 'Футболка черная',
    categoryCode: 'SHIRT',
    description: 'Демо-лекало: базовая чёрная футболка.',
    legacyProductSlug: 'tshirt_black',
    materialAreas: [
      {
        paramKey: 'main',
        roleKey: 'MAIN_FABRIC',
        bySize: { XS: 0.95, S: 1.05, M: 1.15, L: 1.25, XL: 1.35 },
      },
      {
        paramKey: 'rib',
        roleKey: 'RIB',
        bySize: { XS: 0.05, S: 0.06, M: 0.07, L: 0.08, XL: 0.09 },
      },
    ],
    parameterNorms: [{ paramKey: 'tag', qtyPerItem: 1 }],
  },
  {
    article: 'PANTS-SPORT-001',
    name: 'Брюки спортивные',
    categoryCode: 'PANTS',
    description: 'Демо-лекало: спортивные брюки на резинке.',
    materialAreas: [
      {
        paramKey: 'main',
        roleKey: 'MAIN_FABRIC',
        bySize: { XS: 1.6, S: 1.7, M: 1.8, L: 1.9, XL: 2.0 },
      },
    ],
    parameterNorms: [
      { paramKey: 'cord', qtyPerItem: 1 },
      { paramKey: 'buttons', qtyPerItem: 0 },
    ],
  },
];

async function seedPatternItems(
  categories: Record<string, SeededCategory>,
  productsBySlug: Record<string, string>,
): Promise<{
  created: number;
  updated: number;
  total: number;
  areasCreated: number;
  areasUpdated: number;
  normsCreated: number;
  normsUpdated: number;
}> {
  // Подгружаем размеры один раз — понадобятся для FK в `PatternMaterialArea`.
  const sizes = await prisma.size.findMany();
  const sizeIdByCode: Record<string, string> = Object.fromEntries(
    sizes.map((s) => [s.code, s.id]),
  );

  let created = 0;
  let updated = 0;
  let areasCreated = 0;
  let areasUpdated = 0;
  let normsCreated = 0;
  let normsUpdated = 0;

  for (const item of PATTERN_ITEMS) {
    const cat = categories[item.categoryCode];
    if (!cat) {
      throw new Error(
        `Pattern seed: category ${item.categoryCode} for article ${item.article} not found`,
      );
    }
    const legacyProductId = item.legacyProductSlug
      ? productsBySlug[item.legacyProductSlug] ?? null
      : null;

    const existing = await prisma.patternItem.findUnique({
      where: { article: item.article },
    });
    const upserted = await prisma.patternItem.upsert({
      where: { article: item.article },
      create: {
        article: item.article,
        name: item.name,
        categoryId: cat.id,
        description: item.description ?? null,
        status: 'ACTIVE',
        legacyProductId,
      },
      update: {
        name: item.name,
        categoryId: cat.id,
        description: item.description ?? null,
        status: 'ACTIVE',
        legacyProductId,
      },
    });
    if (existing) updated += 1;
    else created += 1;

    // ----- Площади материалов: bulk-replace через upsert по `(pattern, size, role)`.
    for (const area of item.materialAreas) {
      for (const [sizeCode, areaM2] of Object.entries(area.bySize)) {
        const sizeId = sizeIdByCode[sizeCode];
        if (!sizeId) continue; // размер не сидится в данном dev-окружении
        const existingArea = await prisma.patternMaterialArea.findUnique({
          where: {
            PatternMaterialArea_pattern_size_role_uniq: {
              patternItemId: upserted.id,
              sizeId,
              materialRole: area.roleKey,
            },
          },
        });
        await prisma.patternMaterialArea.upsert({
          where: {
            PatternMaterialArea_pattern_size_role_uniq: {
              patternItemId: upserted.id,
              sizeId,
              materialRole: area.roleKey,
            },
          },
          create: {
            patternItemId: upserted.id,
            sizeId,
            materialRole: area.roleKey,
            areaM2: new Prisma.Decimal(areaM2),
          },
          update: {
            areaM2: new Prisma.Decimal(areaM2),
          },
        });
        if (existingArea) areasUpdated += 1;
        else areasCreated += 1;
      }
    }

    // ----- Нормы фурнитуры (QTY_PER_ITEM).
    for (const norm of item.parameterNorms) {
      const paramId = cat.paramIdsByKey[norm.paramKey];
      if (!paramId) continue;
      // Snapshot-поля (`labelSnapshot`/`unit`/`roleKey`) нужно достать
      // из самого параметра категории — берём из БД для консистентности.
      const param = await prisma.patternCategoryParameter.findUnique({
        where: { id: paramId },
      });
      if (!param) continue;
      const existingNorm = await prisma.patternItemParameterNorm.findFirst({
        where: { patternItemId: upserted.id, categoryParameterId: paramId },
      });
      const data = {
        roleKey: param.roleKey,
        labelSnapshot: param.label,
        inputTypeSnapshot: param.inputType,
        unit: param.unit,
        qtyPerItem: new Prisma.Decimal(norm.qtyPerItem),
      };
      if (existingNorm) {
        await prisma.patternItemParameterNorm.update({
          where: { id: existingNorm.id },
          data,
        });
        normsUpdated += 1;
      } else {
        await prisma.patternItemParameterNorm.create({
          data: {
            patternItemId: upserted.id,
            categoryParameterId: paramId,
            ...data,
          },
        });
        normsCreated += 1;
      }
    }
  }

  return {
    created,
    updated,
    total: PATTERN_ITEMS.length,
    areasCreated,
    areasUpdated,
    normsCreated,
    normsUpdated,
  };
}

// ---------------------------------------------------------------------------
// TECH CARDS (Шаблоны техкарт)
// ---------------------------------------------------------------------------

type TechCardMaterialSeed = {
  name: string;
  unit: string;
  qtyPerUnit: number;
  materialRole: string;
  fabricType?: string;
  densityGsm?: number;
  plannedWidthCm?: number;
  colorRule?: 'ORDER_COLOR' | 'FIXED_COLOR' | 'NO_COLOR';
  fixedColorText?: string;
  hardwareSizeText?: string;
  hardwareMaterialText?: string;
  note?: string;
};

type TechCardOutsourceSeed = {
  name: string;
  unit?: string;
  qtyPerUnit?: number;
  vendorName?: string;
  note?: string;
  triggerType?: 'MANUAL' | 'CUT_READY';
};

type TechCardSeed = {
  code: string;
  name: string;
  materialLines: TechCardMaterialSeed[];
  outsourceLines: TechCardOutsourceSeed[];
};

const TECH_CARDS: readonly TechCardSeed[] = [
  {
    code: 'HOODIE-MAT',
    name: 'Худи — материалы и подряд',
    materialLines: [
      { name: 'Футер 3-нитка с начёсом', unit: 'м', qtyPerUnit: 1.4, materialRole: 'MAIN_FABRIC', fabricType: 'футер 3-нитка', densityGsm: 320, plannedWidthCm: 180, colorRule: 'ORDER_COLOR' },
      { name: 'Кашкорсе (манжеты/пояс)', unit: 'м', qtyPerUnit: 0.25, materialRole: 'RIB', fabricType: 'кашкорсе', densityGsm: 280, plannedWidthCm: 100, colorRule: 'ORDER_COLOR' },
      { name: 'Нитки 50/2', unit: 'кат.', qtyPerUnit: 0.05, materialRole: 'THREAD', colorRule: 'ORDER_COLOR' },
      { name: 'Молния разъёмная 60 см', unit: 'шт', qtyPerUnit: 1, materialRole: 'PACKAGING', hardwareSizeText: '60 см', hardwareMaterialText: 'металл', colorRule: 'FIXED_COLOR', fixedColorText: 'чёрный' },
      { name: 'Шнур плоский 8 мм', unit: 'м', qtyPerUnit: 1.4, materialRole: 'PACKAGING', hardwareSizeText: '8 мм', hardwareMaterialText: 'полиэстер', colorRule: 'ORDER_COLOR' },
      { name: 'Наконечники для шнура', unit: 'шт', qtyPerUnit: 2, materialRole: 'PACKAGING', hardwareMaterialText: 'металл', colorRule: 'FIXED_COLOR', fixedColorText: 'серебро' },
    ],
    outsourceLines: [
      { name: 'Шелкография на спинке', unit: 'шт', qtyPerUnit: 1, vendorName: 'Принт-Студия', triggerType: 'CUT_READY', note: 'Принт A4, 1 цвет' },
    ],
  },
  {
    code: 'TSHIRT-MAT',
    name: 'Футболка — материалы',
    materialLines: [
      { name: 'Кулирка', unit: 'м', qtyPerUnit: 0.8, materialRole: 'MAIN_FABRIC', fabricType: 'кулирка', densityGsm: 160, plannedWidthCm: 180, colorRule: 'ORDER_COLOR' },
      { name: 'Воротник рибана', unit: 'м', qtyPerUnit: 0.05, materialRole: 'RIB', fabricType: 'рибана', densityGsm: 200, plannedWidthCm: 60, colorRule: 'ORDER_COLOR' },
      { name: 'Нитки 50/2', unit: 'кат.', qtyPerUnit: 0.03, materialRole: 'THREAD', colorRule: 'ORDER_COLOR' },
      { name: 'Бирка размерная', unit: 'шт', qtyPerUnit: 1, materialRole: 'PACKAGING', hardwareMaterialText: 'тканевая', colorRule: 'NO_COLOR' },
    ],
    outsourceLines: [],
  },
  {
    code: 'PANTS-MAT',
    name: 'Брюки спортивные — материалы',
    materialLines: [
      { name: 'Футер 2-нитка', unit: 'м', qtyPerUnit: 1.2, materialRole: 'MAIN_FABRIC', fabricType: 'футер 2-нитка', densityGsm: 280, plannedWidthCm: 180, colorRule: 'ORDER_COLOR' },
      { name: 'Подклад тонкий', unit: 'м', qtyPerUnit: 0.6, materialRole: 'LINING', fabricType: 'подклад', densityGsm: 80, plannedWidthCm: 150, colorRule: 'FIXED_COLOR', fixedColorText: 'серый' },
      { name: 'Нитки 50/2', unit: 'кат.', qtyPerUnit: 0.04, materialRole: 'THREAD', colorRule: 'ORDER_COLOR' },
      { name: 'Шнур плоский 8 мм', unit: 'м', qtyPerUnit: 1.0, materialRole: 'PACKAGING', hardwareSizeText: '8 мм', hardwareMaterialText: 'полиэстер', colorRule: 'ORDER_COLOR' },
      { name: 'Пуговица декоративная', unit: 'шт', qtyPerUnit: 1, materialRole: 'PACKAGING', hardwareSizeText: '15 мм', hardwareMaterialText: 'пластик', colorRule: 'FIXED_COLOR', fixedColorText: 'чёрный' },
    ],
    outsourceLines: [
      { name: 'Вышивка логотипа', unit: 'шт', qtyPerUnit: 1, vendorName: 'Вышивка-Сервис', triggerType: 'MANUAL', note: 'Лого 5x5 см на левом кармане' },
    ],
  },
];

async function seedTechCards(): Promise<{
  created: number;
  updated: number;
  total: number;
  matLinesCreated: number;
  outLinesCreated: number;
}> {
  let created = 0;
  let updated = 0;
  let matLinesCreated = 0;
  let outLinesCreated = 0;

  for (const tc of TECH_CARDS) {
    const existing = await prisma.techCardTemplate.findUnique({
      where: { code: tc.code },
    });
    const upserted = await prisma.techCardTemplate.upsert({
      where: { code: tc.code },
      create: { code: tc.code, name: tc.name, isActive: true },
      update: { name: tc.name, isActive: true },
    });
    if (existing) updated += 1;
    else created += 1;

    // Bulk-replace строк (как делает `TechCardsService.replaceMaterialLines`):
    // на seed мы держим канонический набор, поэтому полностью пересоздаём
    // строки — иначе при изменении состава остались бы «фантомы».
    await prisma.techCardMaterialLine.deleteMany({
      where: { techCardId: upserted.id },
    });
    for (let i = 0; i < tc.materialLines.length; i += 1) {
      const m = tc.materialLines[i];
      await prisma.techCardMaterialLine.create({
        data: {
          techCardId: upserted.id,
          sortOrder: (i + 1) * 10,
          name: m.name,
          unit: m.unit,
          qtyPerUnit: new Prisma.Decimal(m.qtyPerUnit),
          materialRole: m.materialRole,
          fabricType: m.fabricType ?? null,
          densityGsm: m.densityGsm ?? null,
          plannedWidthCm: m.plannedWidthCm ?? null,
          colorRule: m.colorRule ?? null,
          fixedColorText: m.colorRule === 'FIXED_COLOR' ? m.fixedColorText ?? null : null,
          hardwareSizeText: m.hardwareSizeText ?? null,
          hardwareMaterialText: m.hardwareMaterialText ?? null,
          note: m.note ?? null,
        },
      });
      matLinesCreated += 1;
    }

    await prisma.techCardOutsourceLine.deleteMany({
      where: { techCardId: upserted.id },
    });
    for (let i = 0; i < tc.outsourceLines.length; i += 1) {
      const o = tc.outsourceLines[i];
      await prisma.techCardOutsourceLine.create({
        data: {
          techCardId: upserted.id,
          sortOrder: (i + 1) * 10,
          name: o.name,
          unit: o.unit ?? null,
          qtyPerUnit: o.qtyPerUnit !== undefined ? new Prisma.Decimal(o.qtyPerUnit) : null,
          vendorName: o.vendorName ?? null,
          note: o.note ?? null,
          triggerType: o.triggerType ?? 'MANUAL',
        },
      });
      outLinesCreated += 1;
    }
  }

  return {
    created,
    updated,
    total: TECH_CARDS.length,
    matLinesCreated,
    outLinesCreated,
  };
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
  console.log('→ Seeding pattern categories + parameters…');
  const categories = await seedPatternCategories();
  console.log('→ Seeding pattern items + areas + norms…');
  const patterns = await seedPatternItems(categories.byCode, products.byslug);
  console.log('→ Seeding tech-card templates…');
  const techCards = await seedTechCards();

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
  console.log(`PatternCategories: total=${categories.total} created=${categories.created} updated=${categories.updated} params+${categories.paramsCreated}/upd${categories.paramsUpdated}`);
  console.log(`PatternItems: total=${patterns.total} created=${patterns.created} updated=${patterns.updated} areas+${patterns.areasCreated}/upd${patterns.areasUpdated} norms+${patterns.normsCreated}/upd${patterns.normsUpdated}`);
  console.log(`TechCards:   total=${techCards.total}  created=${techCards.created} updated=${techCards.updated} matLines+${techCards.matLinesCreated} outLines+${techCards.outLinesCreated}`);
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
