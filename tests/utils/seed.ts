/**
 * Минимальный seed для интеграционных тестов.
 *
 * Полный `prisma/seed.ts` тоже можно использовать, но тестам обычно
 * нужен только подмножество (один продукт, один-два размера, по одному
 * работнику нужной роли). Это и быстрее, и проще читать.
 */
import { Prisma, type PrismaClient, type Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

export interface SeedResult {
  sizes: Record<string, string>;
  product: { id: string; name: string; color: string };
  operations: Record<string, { id: string; code: string }>;
  employees: Record<string, { id: string; login: string; role: Role; fullName: string }>;
  equipment: Record<string, { id: string; code: string; qrCode: string }>;
  cells: Record<string, { id: string; code: string; qrCode: string }>;
  defectType: { id: string };
}

const SIZE_CODES: Array<{ code: string; sortOrder: number }> = [
  { code: 'S', sortOrder: 10 },
  { code: 'M', sortOrder: 20 },
  { code: 'L', sortOrder: 30 },
];

/**
 * Тестовый набор операций. `pricingMode` соответствует продакшен-сидам
 * (`prisma/seed.ts`):
 *   - оверлоки → BY_SIZE (ставки заполняются ниже в `seedMinimal`);
 *   - CUT_CUT → FIXED;
 *   - остальные → SALARY_ONLY (CUT_DIVISION, ОТК, ВТО, PACKING).
 *
 * `fixedRate` для CUT_CUT берём = 10 — совпадает с тем, что раньше
 * было в `pieceRate` с `ratePerUnit = 10`. Так старые тесты, считающие
 * `qty * 10`, сохраняют ожидаемые суммы.
 */
const OP_CODES: Array<{
  code: string;
  name: string;
  category: 'CUTTING' | 'SEWING' | 'QC' | 'IRONING' | 'PACKING';
  sortOrder: number;
  pricingMode: 'FIXED' | 'BY_SIZE' | 'SALARY_ONLY';
  fixedRate?: number;
}> = [
  { code: 'CUT_DIVISION', name: 'Деление кроя', category: 'CUTTING', sortOrder: 40, pricingMode: 'SALARY_ONLY' },
  { code: 'CUT_CUT', name: 'Раскрой', category: 'CUTTING', sortOrder: 30, pricingMode: 'FIXED', fixedRate: 10 },
  { code: 'SEW_OVERLOCK_1', name: 'Оверлок 1', category: 'SEWING', sortOrder: 80, pricingMode: 'BY_SIZE' },
  { code: 'SEW_OVERLOCK_2', name: 'Оверлок 2', category: 'SEWING', sortOrder: 100, pricingMode: 'BY_SIZE' },
  { code: 'QC', name: 'ОТК', category: 'QC', sortOrder: 120, pricingMode: 'SALARY_ONLY' },
  // ВТО role-terminal: для теста /wto и derived-стадии WTO_DONE нам
  // нужна реальная операция категории IRONING. Имя и порядок — по
  // аналогии с QC/PACKING (они идут между ОТК и упаковкой).
  { code: 'IRONING', name: 'ВТО', category: 'IRONING', sortOrder: 130, pricingMode: 'SALARY_ONLY' },
  { code: 'PACKING', name: 'Упаковка', category: 'PACKING', sortOrder: 140, pricingMode: 'SALARY_ONLY' },
];

/**
 * Тестовые сотрудники. `compensationType` оставляем дефолтным
 * (`PIECEWORK`) — этого достаточно: сдельный гейт в `EarningsService`
 * пропускает `PIECEWORK`/`MIXED` и блокирует `SALARY`. Для тестов
 * окладного контура (`/api/salary`) сотрудник переключается явно
 * через `prisma.employee.update({ compensationType: 'SALARY', ... })`.
 */
const EMPLOYEE_SEEDS: Array<{ login: string; fullName: string; role: Role }> = [
  { login: 'shop-chief', fullName: 'Test Shop Manager', role: 'SHOP_MANAGER' },
  { login: 'cutter', fullName: 'Test Cutter', role: 'CUTTER' },
  { login: 'seamstress', fullName: 'Test Seamstress', role: 'SEAMSTRESS' },
  { login: 'qc', fullName: 'Test QC', role: 'QC' },
  { login: 'ironing', fullName: 'Test Ironing', role: 'IRONING' },
  { login: 'packer', fullName: 'Test Packer', role: 'PACKING' },
  // Мастер цеха — нужен для интеграционных тестов вызова мастера
  // (`tests/integration/master-calls.test.ts`). По матрице
  // `docs/domain.md §10a` он закрывает `OPEN`-вызовы сканом QR.
  { login: 'master', fullName: 'Test Shopfloor Master', role: 'SHOPFLOOR_MASTER' },
];

const EQUIPMENT_SEEDS: ReadonlyArray<{
  code: string;
  name: string;
  /** Ручной отображаемый номер станка (см. `Equipment.displayNumber`). */
  displayNumber: string;
  /** Какие `Operation.code` сразу разрешены на этом станке (ADR-0017). */
  allowedOperationCodes: readonly string[];
}> = [
  {
    code: 'cutting-table-01',
    name: 'Стол раскройный 01',
    displayNumber: '1',
    allowedOperationCodes: ['CUT_DIVISION'],
  },
  {
    code: 'overlock-01',
    name: 'Оверлок 01',
    displayNumber: '1',
    allowedOperationCodes: ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'],
  },
  {
    code: 'qc-station-01',
    name: 'Рабочее место ОТК 01',
    displayNumber: '1',
    allowedOperationCodes: ['QC'],
  },
  {
    code: 'ironing-station-01',
    name: 'Рабочее место ВТО 01',
    displayNumber: '1',
    allowedOperationCodes: ['IRONING'],
  },
  {
    code: 'packing-station-01',
    name: 'Рабочее место упаковки 01',
    displayNumber: '1',
    allowedOperationCodes: ['PACKING'],
  },
];

const CELL_SEEDS = [{ code: 'A1' }, { code: 'A2' }];

const DEMO_PASSWORD = 'TestPass!1';

export async function seedMinimal(prisma: PrismaClient): Promise<SeedResult> {
  const sizes: Record<string, string> = {};
  for (const s of SIZE_CODES) {
    const row = await prisma.size.upsert({
      where: { code: s.code },
      create: { code: s.code, sortOrder: s.sortOrder },
      update: { sortOrder: s.sortOrder },
    });
    sizes[s.code] = row.id;
  }

  const product = await prisma.product.create({
    data: { name: 'Test Tee', color: 'Белая', active: true },
  });

  const operations: SeedResult['operations'] = {};
  for (const op of OP_CODES) {
    const fixedRate =
      op.pricingMode === 'FIXED' && op.fixedRate !== undefined
        ? new Prisma.Decimal(op.fixedRate)
        : null;
    const row = await prisma.operation.upsert({
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
    operations[op.code] = { id: row.id, code: row.code };
  }

  const pinHash = await bcrypt.hash(DEMO_PASSWORD, 4);
  const employees: SeedResult['employees'] = {};
  for (const e of EMPLOYEE_SEEDS) {
    const row = await prisma.employee.upsert({
      where: { login: e.login },
      create: {
        login: e.login,
        fullName: e.fullName,
        role: e.role,
        active: true,
        pinHash,
      },
      update: {
        fullName: e.fullName,
        role: e.role,
        active: true,
        pinHash,
      },
    });
    employees[e.login] = {
      id: row.id,
      login: row.login,
      role: row.role,
      fullName: row.fullName,
    };
  }

  const equipment: SeedResult['equipment'] = {};
  for (const eq of EQUIPMENT_SEEDS) {
    const row = await prisma.equipment.upsert({
      where: { code: eq.code },
      create: {
        code: eq.code,
        name: eq.name,
        displayNumber: eq.displayNumber,
        qrCode: `equipment-pending:${eq.code}`,
        active: true,
      },
      update: {
        name: eq.name,
        displayNumber: eq.displayNumber,
        active: true,
      },
    });
    let qrCode = row.qrCode;
    if (!qrCode.startsWith('equipment:')) {
      qrCode = `equipment:${row.id}`;
      await prisma.equipment.update({
        where: { id: row.id },
        data: { qrCode },
      });
    }
    equipment[eq.code] = { id: row.id, code: row.code, qrCode };

    for (let i = 0; i < eq.allowedOperationCodes.length; i += 1) {
      const opCode = eq.allowedOperationCodes[i]!;
      const op = operations[opCode];
      if (!op) continue;
      await prisma.equipmentOperation.upsert({
        where: {
          EquipmentOperation_equipment_operation_uniq: {
            equipmentId: row.id,
            operationId: op.id,
          },
        },
        create: {
          equipmentId: row.id,
          operationId: op.id,
          sortOrder: (i + 1) * 10,
          isActive: true,
        },
        update: { sortOrder: (i + 1) * 10, isActive: true },
      });
    }
  }

  const cells: SeedResult['cells'] = {};
  for (const c of CELL_SEEDS) {
    const row = await prisma.cell.upsert({
      where: { code: c.code },
      create: { code: c.code, qrCode: `cell-pending:${c.code}`, active: true },
      update: { active: true },
    });
    let qrCode = row.qrCode;
    if (!qrCode.startsWith('cell:')) {
      qrCode = `cell:${row.id}`;
      await prisma.cell.update({
        where: { id: row.id },
        data: { qrCode },
      });
    }
    cells[c.code] = { id: row.id, code: row.code, qrCode };
  }

  // Минимальный тариф для оверлока (BY_SIZE).
  // CUT_CUT — `FIXED`, ставка уже зашита в `Operation.fixedRate` выше,
  // так что отдельных строк здесь не нужно (см. `docs/domain.md §16a`,
  // `OperationsService.resolveRate`).
  const bySizeOps = ['SEW_OVERLOCK_1', 'SEW_OVERLOCK_2'];
  for (const code of bySizeOps) {
    const op = operations[code];
    for (const sizeId of Object.values(sizes)) {
      await prisma.operationRateBySize.upsert({
        where: {
          OperationRateBySize_operation_size_uniq: {
            operationId: op.id,
            sizeId,
          },
        },
        create: {
          operationId: op.id,
          sizeId,
          rate: new Prisma.Decimal(10),
        },
        update: {
          rate: new Prisma.Decimal(10),
        },
      });
    }
  }

  const defectType = await prisma.defectType.upsert({
    where: { code: 'STAIN' },
    create: { code: 'STAIN', name: 'Пятно', sortOrder: 10, isActive: true },
    update: { name: 'Пятно', sortOrder: 10, isActive: true },
  });

  return {
    sizes,
    product: { id: product.id, name: product.name, color: product.color },
    operations,
    employees,
    equipment,
    cells,
    defectType: { id: defectType.id },
  };
}

export const TEST_PASSWORD = DEMO_PASSWORD;
