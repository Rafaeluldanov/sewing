/**
 * Smoke-тесты MVP «Мастер цеха».
 *
 * Цель: зафиксировать структурные инварианты, которые легко проверить
 * без поднятия Nest/Prisma — чтобы случайный рефакторинг не сломал
 * матрицу ролей, не выпилил мобильную страницу `/master`, не убрал
 * кнопку «Мастер» и CSS-класс пульсации, и не «уехал» в передачу
 * паспортов раньше времени (см. ТЗ §10 «НЕ ДЕЛАТЬ СЕЙЧАС»).
 *
 * Матрица из ТЗ §9 «TESTS / Smoke»:
 *   1. role SHOPFLOOR_MASTER exists
 *   2. /master page exists
 *   3. worker UI has «Мастер» button
 *   4. display has master-call CSS class
 *   5. no passport transfer logic added yet
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  canSeeMasterPage,
  getPrimaryWorkspace,
  isWorkingRole,
  MASTER_PAGE_ALLOWED_ROLES,
} from '../../apps/web/lib/rbac';
import { EMPLOYEE_QR_PREFIX, parseEmployeeQr } from '../../packages/shared/src/master-calls';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('master-calls smoke — role SHOPFLOOR_MASTER', () => {
  test('Prisma schema содержит роль и модель MasterCall', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/^\s*SHOPFLOOR_MASTER\s*$/m);
    expect(schema).toMatch(/enum\s+MasterCallStatus\s*\{[^}]*OPEN[^}]*RESOLVED/);
    expect(schema).toMatch(/model\s+MasterCall\s*\{/);
    // Индексы из ТЗ §2: status+createdAt, employeeId+status, equipmentId+status.
    expect(schema).toMatch(/@@index\(\[status,\s*createdAt\]\)/);
    expect(schema).toMatch(/@@index\(\[employeeId,\s*status\]\)/);
    expect(schema).toMatch(/@@index\(\[equipmentId,\s*status\]\)/);
  });

  test('shared employees enum включает SHOPFLOOR_MASTER', () => {
    const src = readSrc('packages/shared/src/employees.ts');
    expect(src).toMatch(/'SHOPFLOOR_MASTER'/);
  });

  test('rbac.ts: SHOPFLOOR_MASTER отправляется в /master и считается рабочей ролью', () => {
    expect(getPrimaryWorkspace('SHOPFLOOR_MASTER')).toBe('/master');
    expect(isWorkingRole('SHOPFLOOR_MASTER')).toBe(true);
    expect(canSeeMasterPage('SHOPFLOOR_MASTER')).toBe(true);
    expect(canSeeMasterPage('SHOP_MANAGER')).toBe(true);
    expect(canSeeMasterPage('ADMIN')).toBe(true);
    // Рабочим ролям /master не нужен — экран чужой.
    expect(canSeeMasterPage('SEAMSTRESS')).toBe(false);
    expect(canSeeMasterPage('QC')).toBe(false);
    expect(canSeeMasterPage('PACKING')).toBe(false);
    expect(canSeeMasterPage(undefined)).toBe(false);
    expect(MASTER_PAGE_ALLOWED_ROLES).toEqual(
      expect.arrayContaining(['SHOPFLOOR_MASTER', 'SHOP_MANAGER', 'ADMIN']),
    );
  });

  test('middleware.ts редиректит SHOPFLOOR_MASTER на /master, не трогая /api', () => {
    const src = readSrc('apps/web/middleware.ts');
    expect(src).toMatch(/SHOPFLOOR_MASTER/);
    expect(src).toMatch(/'\/master'/);
    // API-запросы Next-middleware не должен заворачивать в HTML-редирект.
    expect(src).toMatch(/isApiPath|\/api/);
  });
});

describe('master-calls smoke — /master mobile page', () => {
  test('apps/web/app/master/page.tsx существует и охраняется canSeeMasterPage', () => {
    const src = readSrc('apps/web/app/master/page.tsx');
    expect(src).toMatch(/canSeeMasterPage/);
    expect(src).toMatch(/MasterPageClient/);
    expect(src).toMatch(/listOpenMasterCalls/);
  });

  test('master-page-client.tsx — карточный список + сканер QR + polling', () => {
    const src = readSrc('apps/web/app/master/master-page-client.tsx');
    // Cards, не таблица — обязательное требование ТЗ §6.
    expect(src).toMatch(/master-call-card/);
    expect(src).not.toMatch(/<table/);
    // QR-сканер общий с /work, не локальный «свой».
    expect(src).toMatch(/QrScannerModal/);
    // Polling и закрытие через server action.
    expect(src).toMatch(/refreshOpenMasterCallsAction/);
    expect(src).toMatch(/resolveMasterCallByEmployeeQrAction/);
    // Success «Вызов закрыт».
    expect(src).toMatch(/Вызов закрыт/);
    // Большая кнопка «Сканировать QR сотрудника» в карточке.
    expect(src).toMatch(/Сканировать QR сотрудника/);
  });

  test('actions.ts содержит callMaster / refresh / resolveByEmployeeQr', () => {
    const src = readSrc('apps/web/app/master/actions.ts');
    expect(src).toMatch(/export async function callMasterAction/);
    expect(src).toMatch(/export async function refreshOpenMasterCallsAction/);
    expect(src).toMatch(/export async function resolveMasterCallByEmployeeQrAction/);
  });
});

describe('master-calls smoke — кнопка «Мастер» на рабочих экранах', () => {
  test('CallMasterButton — единый клиентский компонент', () => {
    const src = readSrc('apps/web/components/call-master-button.tsx');
    expect(src).toMatch(/'use client'/);
    expect(src).toMatch(/callMasterAction/);
    expect(src).toMatch(/Мастер вызван/);
    // FAB-режим для мобильных рабочих экранов.
    expect(src).toMatch(/call-master-btn--fab|call-master-btn/);
  });

  test('кнопка подключена в layouts /work, /qc, /wto, /packing', () => {
    for (const p of [
      'apps/web/app/work/layout.tsx',
      'apps/web/app/qc/layout.tsx',
      'apps/web/app/wto/layout.tsx',
      'apps/web/app/packing/layout.tsx',
    ]) {
      const src = readSrc(p);
      expect(src, `${p} должен импортировать CallMasterButton`).toMatch(
        /CallMasterButton/,
      );
    }
  });
});

describe('master-calls smoke — display pulse', () => {
  test('CSS-класс display-equipment-tile--master-call существует и НЕ совпадает с bottleneck', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.display-equipment-tile--master-call/);
    // Bottleneck pulse сохранился отдельным правилом (не сливаем
    // селекторы).
    expect(css).toMatch(/bottleneck/i);
    expect(css).not.toMatch(
      /\.display-equipment-tile--master-call[^{]*\.display-equipment-tile--bottleneck/,
    );
  });

  test('display-board.tsx навешивает класс по ShopfloorEquipmentStatusDto.hasOpenMasterCall', () => {
    const src = readSrc('apps/web/app/shopfloor/display/display-board.tsx');
    expect(src).toMatch(/hasOpenMasterCall/);
    expect(src).toMatch(/display-equipment-tile--master-call/);
    // Orphan-блок «Вызовы мастера» рендерится для вызовов без
    // оборудования.
    expect(src).toMatch(/orphanMasterCalls/);
  });

  test('shopfloor.service.ts грузит OPEN-вызовы и заполняет hasOpenMasterCall + orphanMasterCalls', () => {
    const src = readSrc('apps/api/src/modules/shopfloor/shopfloor.service.ts');
    expect(src).toMatch(/MasterCallStatus\.OPEN/);
    expect(src).toMatch(/hasOpenMasterCall/);
    expect(src).toMatch(/orphanMasterCalls/);
  });
});

describe('master-calls smoke — QR сотрудника', () => {
  test('parseEmployeeQr принимает EMPLOYEE:<id> и нечувствителен к регистру префикса', () => {
    expect(EMPLOYEE_QR_PREFIX).toBe('EMPLOYEE:');
    expect(parseEmployeeQr('EMPLOYEE:emp-123')).toBe('emp-123');
    expect(parseEmployeeQr('employee:emp-123')).toBe('emp-123');
    expect(parseEmployeeQr('  EMPLOYEE:emp-123  ')).toBe('emp-123');
    expect(parseEmployeeQr('CELL:emp-123')).toBeNull();
    expect(parseEmployeeQr('EMPLOYEE:')).toBeNull();
    expect(parseEmployeeQr('')).toBeNull();
    expect(parseEmployeeQr(null)).toBeNull();
    expect(parseEmployeeQr(undefined)).toBeNull();
  });

  test('employees.controller.ts отдаёт публичные /qr и /print', () => {
    const src = readSrc('apps/api/src/modules/employees/employees.controller.ts');
    expect(src).toMatch(/@Get\(['"]:id\/qr['"]\)/);
    expect(src).toMatch(/@Get\(['"]:id\/print['"]\)/);
    expect(src).toMatch(/EMPLOYEE:/);
    expect(src).toMatch(/@Public\(\)/);
  });

  test('admin employee detail — кнопки «QR сотрудника» и «Печать QR»', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/QR сотрудника/);
    expect(src).toMatch(/Печать QR/);
    expect(src).toMatch(/buildEmployeeQrPath/);
    expect(src).toMatch(/buildEmployeePrintPath/);
  });
});

describe('master-calls smoke — что сознательно не делаем (ТЗ §10)', () => {
  test('master-calls.service не трогает паспорта (no transfer / no issue)', () => {
    const src = readSrc('apps/api/src/modules/master-calls/master-calls.service.ts');
    // Сервис должен быть строго read-only по паспортам — никаких
    // updateMany/transfer/issue/complete над ними. Чтение через
    // findMany + select допустимо (нужно для currentPassports на
    // карточке вызова).
    expect(src).not.toMatch(/passport\.update\b/);
    expect(src).not.toMatch(/passport\.create\b/);
    expect(src).not.toMatch(/issuePassport|transferPassport|movePassport/i);
  });

  test('actions.ts /master не дёргает passport-эндпоинты', () => {
    const src = readSrc('apps/web/app/master/actions.ts');
    expect(src).not.toMatch(/\/api\/passports/);
    expect(src).not.toMatch(/issuePassport|transferPassport/i);
  });
});
