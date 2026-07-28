/**
 * Smoke-тест гейта архивации операций (source-grep, без БД).
 *
 * Фиксирует правило, которого не было и которое стоило двух заказов:
 * операцию НЕЛЬЗЯ отправить в архив, пока ею пользуются незакрытые
 * заказы или активные шаблоны маршрутов.
 *
 * Почему это важно. Архив операции физически — `active = false`, а
 * список операций станка отдаёт швее только активные. Значит архивация
 * операции, стоящей в снимке маршрута живого заказа, делает шаг
 * НЕВЫПОЛНИМЫМ: швея не может её выбрать, заказ встаёт намертво и
 * молчит. Так умерли O-20260615-0004 (188 паспортов, 3 500 шт, простой
 * 28 дней) и O-20260615-0005 — у обоих ВСЕ швейные операции маршрута
 * были заархивированы, а работу закрывали на мусорных дублях по 1 ₽.
 * На месте проверки стояла заглушка `gate: () => null`.
 *
 * Сторож грепом, а не интеграционным тестом, потому что регрессия здесь
 * выглядит как «кто-то вернул заглушку» — это ловится текстом надёжнее
 * и на порядок дешевле.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const SERVICE = 'apps/api/src/modules/operations/operations.service.ts';

describe('архивация операции — гейт «используется в заказе»', () => {
  test('archiveMany больше НЕ имеет заглушки gate: () => null', () => {
    const src = read(SERVICE);
    const archiveIdx = src.indexOf('async archiveMany(');
    expect(archiveIdx).toBeGreaterThan(0);
    const restoreIdx = src.indexOf('async restoreMany(');
    const archiveBody = src.slice(archiveIdx, restoreIdx);
    // Именно в archiveMany заглушки быть не должно. В restoreMany она
    // законна: вернуть операцию из архива безопасно всегда.
    expect(archiveBody).not.toMatch(/gate:\s*\(\)\s*=>\s*null/);
    expect(archiveBody).toMatch(/blockersByOp/);
  });

  test('гейт считает и живые заказы, и активные шаблоны', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/loadArchiveBlockers/);
    // Заказ считается «живым», пока не DONE/CANCELLED.
    expect(src).toMatch(/status:\s*\{\s*notIn:\s*\[\s*OrderStatus\.DONE,\s*OrderStatus\.CANCELLED\s*\]/);
    // Шаблон блокирует только активный.
    expect(src).toMatch(/template:\s*\{\s*isActive:\s*true\s*\}/);
  });

  test('причина отказа НАЗЫВАЕТ конкретные заказы, а не «используется»', () => {
    const src = read(SERVICE);
    expect(src).toMatch(/незакрытые заказы/);
    expect(src).toMatch(/активные шаблоны маршрутов/);
    // И подсказывает, что делать дальше.
    expect(src).toMatch(/Сначала закройте или отмените заказ/);
    expect(src).toMatch(/reason:\s*'IN_USE'/);
  });

  test('один запрос на пачку, а не на строку (без N+1 в gate)', () => {
    const src = read(SERVICE);
    const idx = src.indexOf('async archiveMany(');
    const body = src.slice(idx, src.indexOf('async restoreMany('));
    // Блокеры грузятся ДО runBulkArchive, gate остаётся синхронным.
    expect(body).toMatch(
      /const blockersByOp = await this\.loadArchiveBlockers\(ids\);[\s\S]*runBulkArchive/,
    );
    expect(body).toMatch(/gate:\s*\(row\)\s*=>/);
  });
});
