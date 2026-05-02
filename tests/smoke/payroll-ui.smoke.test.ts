/**
 * Smoke-тесты для нового слоя «К выплате сейчас» (netToPayRub).
 *
 * Проверяем на уровне исходников:
 *   1. Страница `/admin/payroll` содержит «К выплате сейчас» и «Уже в выплатах».
 *   2. Shared DTO `PayrollPeriodEmployeeRowDto` содержит поля
 *      `netToPayRub` / `payoutCoveredRub` / `grossAccruedRub`.
 *   3. Shared DTO `PayrollPeriodSummaryDto` содержит
 *      `totalPayoutCoveredRub` / `totalNetToPayRub`.
 *   4. Backend `PayrollService.period` выполняет запрос покрытия выплатами.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Frontend page содержит UI «К выплате сейчас»
// ---------------------------------------------------------------------------

describe('/admin/payroll — UI «К выплате сейчас»', () => {
  const PAGE = 'apps/web/app/admin/payroll/page.tsx';

  test('страница содержит KPI «К выплате сейчас»', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/К выплате сейчас/);
  });

  test('страница содержит колонку «Уже в выплатах»', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/Уже в выплатах/);
  });

  test('страница содержит KPI «Выплачено / в выплатах»', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/Выплачено \/ в выплатах/);
  });

  test('страница использует поле netToPayRub', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/netToPayRub/);
  });

  test('страница использует поле payoutCoveredRub', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/payoutCoveredRub/);
  });

  test('страница показывает бейдж «выплачено/закрыто» при netToPayRub = 0', () => {
    const src = readSrc(PAGE);
    expect(src).toMatch(/выплачено\/закрыто/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared DTO — PayrollPeriodEmployeeRowDto
// ---------------------------------------------------------------------------

describe('shared DTO — PayrollPeriodEmployeeRowDto содержит новые поля', () => {
  const SHARED = 'packages/shared/src/payroll.ts';

  test('DTO содержит netToPayRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/netToPayRub\s*:/);
  });

  test('DTO содержит payoutCoveredRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/payoutCoveredRub\s*:/);
  });

  test('DTO содержит grossAccruedRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/grossAccruedRub\s*:/);
  });

  test('DTO содержит payoutPieceworkCoveredRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/payoutPieceworkCoveredRub\s*:/);
  });

  test('DTO содержит payoutSalaryCoveredRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/payoutSalaryCoveredRub\s*:/);
  });
});

// ---------------------------------------------------------------------------
// 3. Shared DTO — PayrollPeriodSummaryDto
// ---------------------------------------------------------------------------

describe('shared DTO — PayrollPeriodSummaryDto содержит новые поля', () => {
  const SHARED = 'packages/shared/src/payroll.ts';

  test('summary содержит totalPayoutCoveredRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/totalPayoutCoveredRub\s*:/);
  });

  test('summary содержит totalNetToPayRub', () => {
    const src = readSrc(SHARED);
    expect(src).toMatch(/totalNetToPayRub\s*:/);
  });
});

// ---------------------------------------------------------------------------
// 4. Backend PayrollService — запрос покрытия выплатами
// ---------------------------------------------------------------------------

describe('backend PayrollService — логика покрытия выплатами', () => {
  const SERVICE = 'apps/api/src/modules/payroll/payroll.service.ts';

  test('сервис запрашивает PayrollPayoutLine для покрытия', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/PayrollPayoutLine/);
  });

  test('сервис фильтрует по статусам DRAFT, ISSUED, ACKNOWLEDGED', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/DRAFT.*ISSUED.*ACKNOWLEDGED/s);
  });

  test('сервис вычисляет netToPayRub через Math.max', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/netToPayRub/);
    expect(src).toMatch(/Math\.max\(0/);
  });

  test('сервис вычисляет grossAccruedRub', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/grossAccruedRub/);
  });

  test('emptyPeriodSummary содержит totalPayoutCoveredRub', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/totalPayoutCoveredRub:\s*0/);
  });

  test('emptyPeriodSummary содержит totalNetToPayRub', () => {
    const src = readSrc(SERVICE);
    expect(src).toMatch(/totalNetToPayRub:\s*0/);
  });
});
