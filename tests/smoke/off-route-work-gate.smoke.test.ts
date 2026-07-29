/**
 * Smoke-тест корневого гейта «работа мимо маршрута» (source-grep).
 *
 * Это та самая проверка, ради которой затевался весь разбор. До
 * 28.07.2026 случай «операции нет в маршруте заказа» не проверялся
 * ВООБЩЕ: `evaluateRouteOrder` возвращал пустой результат и отключал
 * проверку целиком, из-за чего правило было вывернуто наизнанку —
 * взять операцию на шаг раньше нельзя, перепрыгнуть незакрытый шаг
 * нельзя, а взять операцию, которой в маршруте нет вовсе, можно.
 * Шесть инцидентов с 13.05.2026; последний — 70 паспортов в 8 заказах,
 * лаг обнаружения 27 дней.
 *
 * На истории прода проверено: гейт отказал бы 01.07.2026 в 11:13:11,
 * на ПЕРВОМ паспорте, до остальных 17 в том же заказе.
 *
 * Сторож фиксирует три исключения, без которых гейт останавливает цех.
 * Каждое легко «упростить» при рефакторинге, а цена ошибки — простой.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const PASSPORTS = 'apps/api/src/modules/passports/passports.service.ts';

describe('гейт «операции нет в маршруте заказа»', () => {
  test('умолчание перевёрнуто: вместо немого return none — признак offRoute', () => {
    const src = read(PASSPORTS);
    // Ключевая строка. Раньше: `if (merged.length === 0) return none;`
    expect(src).toMatch(
      /if \(merged\.length === 0\) return \{ \.\.\.none, offRoute: true \};/,
    );
    // «Сравнивать не с чем» (нет заказа / нет снимка) — это НЕ нарушение.
    expect(src).toMatch(/offRoute: false,/);
  });

  test('гейт стоит на всех ТРЁХ каналах: выдача, скан, завершение', () => {
    const src = read(PASSPORTS);
    const calls = src.match(/enforceOffRoutePolicy\(/g) ?? [];
    // 1 объявление + 3 вызова.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(src).toMatch(/issueOrder\.offRoute/);
    expect(src).toMatch(/scanOrder\.offRoute/);
    expect(src).toMatch(/completeOrder\.offRoute/);
  });

  test('строгость берётся из настроек компании, а не зашита', () => {
    const src = read(PASSPORTS);
    expect(src).toMatch(/getOffRouteWorkPolicy\(\)/);
    expect(src).toMatch(/if \(policy === 'OFF'\) return;/);
    expect(src).toMatch(/if \(policy === 'BLOCK'\)/);
    // WARN обязан оставлять след — иначе он неотличим от OFF и по нему
    // нельзя решить, пора ли включать блокировку.
    expect(src).toMatch(/event=passport\.offRoute/);
    expect(src).toMatch(/PASSPORT_WORK_OUTSIDE_ROUTE/);
  });

  test('исключение 1: только SEWING (иначе лягут крой/ОТК/ВТО/упаковка)', () => {
    const src = read(PASSPORTS);
    const idx = src.indexOf('private async enforceOffRoutePolicy');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 4000);
    expect(body).toMatch(/category !== OperationCategory\.SEWING\) return;/);
  });

  test('исключение 2: открытая переделка пропускается', () => {
    const src = read(PASSPORTS);
    const body = src.slice(src.indexOf('private async enforceOffRoutePolicy'));
    expect(body).toMatch(/OPERATION_REWORK_OPENED/);
    expect(body).toMatch(/if \(!finished\) return;/);
  });

  test('исключение 3: уже выданный паспорт можно завершить', () => {
    const src = read(PASSPORTS);
    expect(src).toMatch(/allowIfAlreadyIssued/);
    // Послабление действует ТОЛЬКО на завершении: взять новый паспорт
    // мимо маршрута нельзя, доделать начатое — можно.
    const completeIdx = src.indexOf('completeOrder.offRoute');
    const completeCall = src.slice(completeIdx, completeIdx + 800);
    expect(completeCall).toMatch(/allowIfAlreadyIssued: true/);
    const issueIdx = src.indexOf('issueOrder.offRoute');
    const issueCall = src.slice(issueIdx, issueIdx + 250);
    expect(issueCall).not.toMatch(/allowIfAlreadyIssued/);
  });

  test('политика по умолчанию — WARN, а не BLOCK', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toMatch(
      /offRouteWorkPolicy OffRouteWorkPolicy @default\(WARN\)/,
    );
    const settings = read(
      'apps/api/src/modules/company-settings/company-settings.service.ts',
    );
    // Fallback на отсутствующей строке настроек — тоже WARN.
    expect(settings).toMatch(/offRouteWorkPolicy \?\? 'WARN'/);
  });
});
