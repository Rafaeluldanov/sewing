/**
 * Smoke-тест гейтов «архивная операция в маршруте» (source-grep).
 *
 * Три правила, каждое оплачено инцидентом:
 *
 *   1. Заказ нельзя ЗАПУСТИТЬ, если в шаблоне маршрута есть архивные
 *      ШВЕЙНЫЕ операции. Список операций станка отдаёт швее только
 *      активные — такой шаг невыполним, заказ уходит в производство
 *      мёртвым и молчит. Так умерли O-20260615-0004 (188 паспортов,
 *      3 500 шт, простой 28 дней) и O-20260615-0005.
 *   2. Проверка только для `SEWING`. Крой/ОТК/ВТО/упаковка закрываются
 *      на своих гейтах и из списка станка не выбираются. Это не теория:
 *      основные шаблоны 01 и 02 работают с архивным «Делением кроя», и
 *      расширение проверки на все категории положило бы основной поток
 *      футболок в первый же день.
 *   3. В шаблон нельзя ДОБАВИТЬ архивную операцию — но проверяются
 *      только ДОБАВЛЯЕМЫЕ. На проде 14 из 20 активных шаблонов уже
 *      содержат архивные шаги; проверка «все шаги активны» сделала бы
 *      несохраняемыми почти все шаблоны, и её бы просто убрали.
 *
 * Ровно эти три ограничения легко «упростить» при рефакторинге, поэтому
 * они зафиксированы текстом.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

const ROUTES = 'apps/api/src/modules/routes/routes.service.ts';
const ORDERS = 'apps/api/src/modules/orders/orders.service.ts';

describe('архивные операции в шаблоне маршрута', () => {
  test('start() вызывает гейт ДО снятия снимка маршрута', () => {
    const src = read(ORDERS);
    const gateIdx = src.indexOf('assertTemplateUsableForProduction');
    expect(gateIdx).toBeGreaterThan(0);
    const snapIdx = src.indexOf('getActiveStepsForSnapshot', gateIdx);
    expect(snapIdx).toBeGreaterThan(gateIdx);
  });

  test('гейт запуска — только SEWING (иначе ляжет основной поток)', () => {
    const src = read(ROUTES);
    const idx = src.indexOf('async assertTemplateUsableForProduction');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2000);
    expect(body).toMatch(/OperationCategory\.SEWING/);
    expect(body).toMatch(/!op\.active/);
    // Архивный ШАБЛОН — отдельная причина отказа.
    expect(body).toMatch(/OrderRouteTemplateArchivedException/);
    expect(body).toMatch(/OrderRouteTemplateHasArchivedOperationsException/);
  });

  test('в шаблон нельзя добавить архивную операцию', () => {
    const src = read(ROUTES);
    expect(src).toMatch(/assertNoNewArchivedOperations/);
    expect(src).toMatch(/RouteTemplateStepOperationArchivedException/);
  });

  test('проверяются ТОЛЬКО добавляемые операции, а не весь список шагов', () => {
    const src = read(ROUTES);
    const idx = src.indexOf('private async assertNoNewArchivedOperations');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1600);
    // Текущие шаги шаблона вычитаются из проверяемого набора.
    expect(body).toMatch(/alreadyInTemplate/);
    expect(body).toMatch(/wanted\.filter\(\(id\) => !alreadyInTemplate\.has\(id\)\)/);
    // Ранний выход, если ничего не добавляют.
    expect(body).toMatch(/if \(added\.length === 0\) return;/);
  });

  test('update передаёт id шаблона, create — null', () => {
    const src = read(ROUTES);
    // В update набор «уже в шаблоне» берётся по id; в create его нет.
    expect(src).toMatch(/assertNoNewArchivedOperations\(\s*id,/);
    expect(src).toMatch(/assertNoNewArchivedOperations\(\s*null,/);
  });

  test('тексты ошибок объясняют, что делать', () => {
    const src = read('apps/api/src/common/errors.ts');
    expect(src).toMatch(/ORDER_ROUTE_TEMPLATE_HAS_ARCHIVED_OPERATIONS/);
    expect(src).toMatch(/ORDER_ROUTE_TEMPLATE_ARCHIVED/);
    expect(src).toMatch(/ROUTE_TEMPLATE_STEP_OPERATION_ARCHIVED/);
    expect(src).toMatch(/Швея не сможет их выбрать/);
    expect(src).toMatch(/Верните операции из архива или поправьте шаблон/);
  });
});
