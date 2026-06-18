/**
 * Smoke-тесты для нормирования операций по времени
 * (Этап 1 из `docs/operation-time-norms-recon.md`).
 *
 * Без рендера React и без работы с БД — просто проверяем, что
 * исходники содержат нужные сущности (additive). Это страхует от
 * регресса «случайно убрали поля времени из схемы / DTO / UI».
 *
 * Что фиксируем:
 *   - Prisma: Operation.timeNormMode/timeNormSec + OperationTimeNormBySize.
 *   - Shared: TIME_NORM_MODES, расширение Create/UpdateOperationSchema.
 *   - OperationsService: timeNormMode/timeNormSec в create/update +
 *     resolveTimeNormSec (resolveRate не изменён).
 *   - UI: блок «Норма времени», поля «Минуты»/«Секунды»,
 *     bulk-кнопка «Заполнить всем размерам», колонка «Норма времени»
 *     в списке операций.
 *   - Payroll/Earnings/Order/OrderCostEstimate/WorkshopNeed/Passport/
 *     RouteTemplate/production-cost — НЕ изменены (этап 1 их не трогает).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Prisma + миграция
// ---------------------------------------------------------------------------

describe('Этап 1 — Prisma: timeNormMode / timeNormSec / OperationTimeNormBySize', () => {
  test('Prisma-схема содержит Operation.timeNormMode и Operation.timeNormSec', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/timeNormMode\s+String\s+@default\("FIXED"\)/);
    expect(src).toMatch(/timeNormSec\s+Int\?/);
  });

  test('Prisma-схема содержит модель OperationTimeNormBySize с уникальностью (operationId, sizeId)', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/model\s+OperationTimeNormBySize\s*\{/);
    expect(src).toMatch(
      /@@unique\(\[operationId,\s*sizeId\],\s*name:\s*"OperationTimeNormBySize_operation_size_uniq"\)/,
    );
    expect(src).toMatch(/@@index\(\[operationId\]\)/);
    expect(src).toMatch(/@@index\(\[sizeId\]\)/);
  });

  test('Prisma-схема содержит back-relations Operation.timeNormsBySize и Size.operationTimeNormsBySize', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/timeNormsBySize\s+OperationTimeNormBySize\[\]/);
    expect(src).toMatch(/operationTimeNormsBySize\s+OperationTimeNormBySize\[\]/);
  });

  test('Миграция 20260522100000_add_operation_time_norms существует и additive', () => {
    const src = readSrc(
      'prisma/migrations/20260522100000_add_operation_time_norms/migration.sql',
    );
    // Только ALTER ADD COLUMN и CREATE TABLE — никаких DROP / ALTER на
    // существующих критичных таблицах (payroll/orders).
    expect(src).toMatch(/ALTER TABLE "Operation"\s+ADD COLUMN "timeNormMode"/);
    expect(src).toMatch(/ADD COLUMN "timeNormSec"\s+INTEGER/);
    expect(src).toMatch(/CREATE TABLE "OperationTimeNormBySize"/);
    expect(src).not.toMatch(/DROP TABLE/);
    expect(src).not.toMatch(/DROP COLUMN/);
    // На существующих таблицах payroll/orders не пишем.
    expect(src).not.toMatch(/ALTER TABLE "Order"/);
    expect(src).not.toMatch(/ALTER TABLE "OperationEntry"/);
    expect(src).not.toMatch(/ALTER TABLE "OperationRateBySize"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared
// ---------------------------------------------------------------------------

describe('Этап 1 — Shared: TIME_NORM_MODES + schemas + DTO', () => {
  test('packages/shared/src/operations.ts содержит TIME_NORM_MODES и labels', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    expect(src).toMatch(
      /TIME_NORM_MODES\s*=\s*\['FIXED',\s*'BY_SIZE'\]\s+as const/,
    );
    expect(src).toMatch(/TIME_NORM_MODE_LABELS/);
    expect(src).toMatch(/FIXED:\s*'Единая норма'/);
    expect(src).toMatch(/BY_SIZE:\s*'По размерам'/);
  });

  test('CreateOperationSchema принимает timeNormMode / timeNormSec / timeNormsBySize', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    // Внутри блока CreateOperationSchema должны быть три новых поля.
    const create = src.split('CreateOperationSchema')[1] ?? '';
    expect(create).toMatch(/timeNormMode/);
    expect(create).toMatch(/timeNormSec/);
    expect(create).toMatch(/timeNormsBySize/);
  });

  test('UpdateOperationSchema принимает timeNormMode / timeNormSec / timeNormsBySize', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    const update = src.split('UpdateOperationSchema')[1] ?? '';
    expect(update).toMatch(/timeNormMode/);
    expect(update).toMatch(/timeNormSec/);
    expect(update).toMatch(/timeNormsBySize/);
  });

  test('OperationSummaryDto содержит timeNormMode/timeNormSec/timeNormsBySizeCount', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    expect(src).toMatch(/timeNormMode:\s*TimeNormMode/);
    expect(src).toMatch(/timeNormSec:\s*number\s*\|\s*null/);
    expect(src).toMatch(/timeNormsBySizeCount:\s*number/);
  });

  test('OperationDetailDto содержит timeNormsBySize (с sizeId, sizeCode, sizeSortOrder, seconds)', () => {
    const src = readSrc('packages/shared/src/operations.ts');
    expect(src).toMatch(/OperationTimeNormBySizeDto/);
    expect(src).toMatch(/timeNormsBySize:\s*OperationTimeNormBySizeDto\[\]/);
  });
});

// ---------------------------------------------------------------------------
// 3. OperationsService
// ---------------------------------------------------------------------------

describe('Этап 1 — OperationsService: CRUD + resolveTimeNormSec', () => {
  test('OperationsService.create сохраняет timeNormMode/timeNormSec и timeNormsBySize', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    // create() пишет timeNormMode/timeNormSec в operation.create
    expect(src).toMatch(/timeNormMode,\s*\n\s*timeNormSec,/);
    // create() пишет операцию timeNormBySize.createMany для BY_SIZE
    expect(src).toMatch(
      /tx\.operationTimeNormBySize\.createMany\(\{\s*data:\s*dto\.timeNormsBySize/,
    );
  });

  test('OperationsService.update обновляет timeNormMode/timeNormSec и replace-all timeNormsBySize', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    expect(src).toMatch(/data\.timeNormMode\s*=\s*dto\.timeNormMode/);
    // BY_SIZE → deleteMany + createMany (replace-all)
    expect(src).toMatch(
      /tx\.operationTimeNormBySize\.deleteMany\(\{\s*where:\s*\{\s*operationId:\s*id/,
    );
    expect(src).toMatch(
      /tx\.operationTimeNormBySize\.createMany\(\{\s*data:\s*dto\.timeNormsBySize/,
    );
  });

  test('OperationsService содержит resolveTimeNormSec и НЕ меняет resolveRate', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    expect(src).toMatch(
      /async\s+resolveTimeNormSec\(\s*operationId:\s*string,\s*sizeId:\s*string/,
    );
    // Контракт resolveRate не должен поменяться — оставляем сигнатуру и
    // заворот в OperationRateMissingException.
    expect(src).toMatch(/async\s+resolveRate\(/);
    expect(src).toMatch(/OperationRateMissingException/);
  });

  test('list() / getOne() выдают timeNormsBySize counts/строки', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    // _count.timeNormsBySize в list()
    expect(src).toMatch(/timeNormsBySize:\s*true/);
    // Маппинг в DTO (в getOne)
    expect(src).toMatch(/sizeCode:\s*r\.size\.code/);
  });
});

// ---------------------------------------------------------------------------
// 4. Frontend UI
// ---------------------------------------------------------------------------

describe('Этап 1 — Frontend UI: блок «Норма времени»', () => {
  test('OperationEditForm содержит блок «Норма времени» с полями «Минуты»/«Секунды»', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    expect(src).toMatch(/Норма времени/);
    expect(src).toMatch(/Минуты/);
    expect(src).toMatch(/Секунды/);
    // Селектор режима «Единая норма / По размерам» — через
    // TIME_NORM_MODE_LABELS (в shared).
    expect(src).toMatch(/TIME_NORM_MODES/);
    expect(src).toMatch(/TIME_NORM_MODE_LABELS/);
  });

  test('OperationEditForm содержит bulk-кнопку «Заполнить всем размерам»', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    expect(src).toMatch(/Заполнить всем размерам/);
    // FIXED/BY_SIZE-инпуты по schema (полевой формат).
    expect(src).toMatch(/timeNormMin-\$\{s\.id\}/);
    expect(src).toMatch(/timeNormSec-\$\{s\.id\}/);
  });

  test('Норма времени по размерам — компактная сетка карточек, не таблица', () => {
    const src = readSrc('apps/web/app/admin/operations/[id]/edit-form.tsx');
    // Используем CSS-классы для сетки и карточек.
    expect(src).toMatch(/operation-time-size-grid/);
    expect(src).toMatch(/operation-time-size-card/);
    expect(src).toMatch(/operation-time-size-card__size/);
    expect(src).toMatch(/operation-time-size-card__inputs/);
    expect(src).toMatch(/operation-time-bulk-row/);

    // Старая таблица «Размер / Минуты / Секунды» в admin-table
    // больше не должна появляться внутри блока нормы времени —
    // мы заменили её на сетку карточек.
    const block =
      src.split("timeNormMode === 'BY_SIZE'")[1]?.split('</form>')[0] ?? '';
    expect(block).not.toMatch(/<table\b[^>]*\bclassName=["']admin-table/);
    expect(block).not.toMatch(/<th[^>]*>\s*Размер\s*<\/th>/);
  });

  test('globals.css содержит стили компактной сетки нормы времени', () => {
    const src = readSrc('apps/web/app/globals.css');
    expect(src).toMatch(/\.operation-time-size-grid\s*\{/);
    expect(src).toMatch(/\.operation-time-size-card\s*\{/);
    expect(src).toMatch(/\.operation-time-size-card__size\s*\{/);
    expect(src).toMatch(/\.operation-time-size-card__inputs\s*\{/);
    expect(src).toMatch(/\.operation-time-bulk-row\s*\{/);
  });

  test('actions.ts продолжает парсить timeNormMin-/timeNormSec- из FormData', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    expect(src).toMatch(/timeNormMin-/);
    expect(src).toMatch(/timeNormSec-/);
    expect(src).toMatch(/timeNormsBySize/);
  });

  test('CreateOperationForm содержит блок «Норма времени» (хотя бы FIXED-режим)', () => {
    const src = readSrc('apps/web/app/admin/operations/create-form.tsx');
    expect(src).toMatch(/Норма времени/);
    expect(src).toMatch(/timeNormMode/);
    expect(src).toMatch(/timeNormMin/);
    expect(src).toMatch(/timeNormSecPart/);
  });

  test('updateOperationAction парсит timeNorm-поля из FormData', () => {
    const src = readSrc('apps/web/app/admin/operations/actions.ts');
    expect(src).toMatch(/parseTimeNormFromForm/);
    expect(src).toMatch(/timeNormMode/);
    expect(src).toMatch(/timeNormsBySize/);
  });

  test('Список /admin/operations показывает колонку «Норма времени»', () => {
    const src = readSrc('apps/web/app/admin/operations/page.tsx');
    // После compact-redesign колонки описаны не массивом
    // `AdminTableColumn` (`header: '…'`), а напрямую как `<th>` —
    // защищаем именно DOM-разметку и render-helper.
    expect(src).toMatch(/<th>Норма времени<\/th>/);
    expect(src).toMatch(/formatTimeNorm/);
  });

  test('Helpers `splitSeconds` / `toSeconds` / `formatDuration` существуют в lib/operations-time-norm.ts', () => {
    const src = readSrc('apps/web/lib/operations-time-norm.ts');
    expect(src).toMatch(/export function splitSeconds/);
    expect(src).toMatch(/export function toSeconds/);
    expect(src).toMatch(/export function formatDuration/);
  });
});

// ---------------------------------------------------------------------------
// 5. Что НЕ должно меняться (см. recon §15)
// ---------------------------------------------------------------------------

describe('Этап 1 — НЕ трогаем payroll/Order/Cost/WorkshopNeed/Passport/Routes/Production-cost', () => {
  // Отдельная защита: эти файлы не должны содержать ссылок на
  // нормы времени (Этап 1 их не касается).
  const forbiddenInFiles = [
    'apps/api/src/modules/earnings/earnings.service.ts',
    'apps/api/src/modules/salary/salary.service.ts',
    'apps/api/src/modules/costs/costs.service.ts',
    'apps/api/src/modules/orders/orders.service.ts',
    'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    'apps/api/src/modules/passports/passports.service.ts',
    'apps/api/src/modules/routes/routes.service.ts',
    'apps/api/src/modules/workshop-needs/workshop-needs.service.ts',
  ];

  for (const file of forbiddenInFiles) {
    test(`${file} не упоминает timeNormSec / timeNormMode / OperationTimeNormBySize`, () => {
      const src = readSrc(file);
      // `timeNormSecOverride` — это per-order переопределение нормы
      // ВНУТРИ ЗАКАЗА (снимок маршрута, фича «редактирование операции
      // в заказе»), а не чтение справочной нормы операции, которое
      // запрещал Этап 1. Поэтому суффикс `Override` исключаем из запрета.
      expect(src).not.toMatch(/timeNormSec(?!Override)/);
      expect(src).not.toMatch(/timeNormMode/);
      expect(src).not.toMatch(/OperationTimeNormBySize/);
      expect(src).not.toMatch(/resolveTimeNormSec/);
    });
  }

  test('OperationsService.resolveRate сохраняет существующий контракт', () => {
    const src = readSrc(
      'apps/api/src/modules/operations/operations.service.ts',
    );
    // SALARY_ONLY → null, FIXED → fixedRate или OperationRateMissingException,
    // BY_SIZE → OperationRateBySize или OperationRateMissingException.
    // Режим эффективный (`mode = override?.pricingModeOverride ??
    // op.pricingMode`): заказ может переключать оклад ⇄ сделку, контракт
    // веток сохраняется.
    expect(src).toMatch(/if\s+\(mode\s+===\s+'SALARY_ONLY'\)\s+return\s+null/);
    expect(src).toMatch(/op\.fixedRate/);
    expect(src).toMatch(/operationRateBySize\.findUnique/);
  });
});
