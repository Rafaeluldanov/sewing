/**
 * Smoke-сторожа пачечного заведения материалов в спецификации расцветки.
 *
 * Что фиксируем (полноценного React-рендерера в vitest нет, поэтому идём
 * текстовыми проверками исходников — как в соседних smoke):
 *
 *   1. Заведение живёт СТРОКАМИ ТАБЛИЦЫ, а не формой под ней: у таблицы
 *      `auto`-раскладка, и снаружи её колонки не повторить — форма
 *      разъезжалась на первом длинном названии.
 *   2. Пачка уезжает ОДНИМ запросом. На бэке каждое создание заканчивается
 *      `resyncTechCardDerived` (снимок + план операций + потребности цеха):
 *      N строк N запросами = N пересборок и N шансов упасть на середине.
 *   3. Поэтому в сервисе `resyncTechCardDerived` вызывается ВНЕ цикла по
 *      строкам, а вставка идёт одной транзакцией.
 *   4. Характеристики новой строки проходят через `normalizeMaterialLineCells`
 *      — иначе JSON `characteristics` и legacy-колонки (`densityGsm`,
 *      `plannedWidthCm`) разъедутся, и параметр был бы виден в интерфейсе, но
 *      не повлиял бы на закупку.
 *   5. Сдвоенная шапка ПОСТОЯННА и покрывает все 10 колонок тела
 *      (2 + 4 + 1 + 2 + 1): при 3 колонках зоны расхода заголовки съезжали
 *      влево, и «Закупка» вставала над служебной стрелкой. С фичи «единица
 *      закупки — списком» закупочные колонки не прячутся за наличием
 *      расщеплённых строк: селект единицы закупки живёт именно в них.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('спецификация расцветки — заведение материалов пачкой', () => {
  test('черновики рисуются строками таблицы, отдельной формы больше нет', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    // Черновая строка и подвал пачки — внутри <tbody>.
    expect(src).toMatch(/className="cws-draft"/);
    expect(src).toMatch(/className="cws-batch"/);
    expect(src).toMatch(/drafts\.map\(/);
    // Старая форма-коробка под таблицей убрана вместе со своим состоянием.
    expect(src).not.toMatch(/className="cws-form"[\s\S]{0,400}Название \(Лента/);
    expect(src).not.toMatch(/setNewLine\(/);
    // Распорка вместо каретки: иначе имя черновика встаёт уступом влево.
    expect(src).toMatch(/cws-caret--ghost/);
  });

  test('пачка уезжает одним действием, а не по строке за запрос', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    expect(src).toMatch(/createTechCardLinesAction\(/);
    // Поштучный action в этом окне больше не используется.
    expect(src).not.toMatch(/createTechCardLineAction\(/);

    const actions = readSrc(
      'apps/web/app/admin/orders/[id]/tech-card-params-actions.ts',
    );
    expect(actions).toMatch(/export async function createTechCardLinesAction/);
    expect(actions).toMatch(/CreateOrderTechCardLinesSchema/);

    const api = readSrc('apps/web/lib/order-tech-card-api.ts');
    expect(api).toMatch(/tech-card\/lines\/bulk/);
  });

  test('shared: схема пачки с лимитом и характеристиками при создании', () => {
    const src = readSrc('packages/shared/src/order-tech-cards.ts');
    expect(src).toMatch(/export const CreateOrderTechCardLinesSchema/);
    expect(src).toMatch(/ORDER_TECH_CARD_LINES_BATCH_MAX/);
    // Характеристики можно задать сразу — но они НЕ обязательны:
    // дозаполнение после сохранения и есть смысл фичи.
    const createBlock = src.slice(
      src.indexOf('export const CreateOrderTechCardLineSchema'),
      src.indexOf('export const ORDER_TECH_CARD_LINES_BATCH_MAX'),
    );
    expect(createBlock).toMatch(/subtypeKey/);
    expect(createBlock).toMatch(/characteristics/);
  });

  test('бэкенд: одна транзакция и ОДНА пересборка на всю пачку', () => {
    const src = readSrc(
      'apps/api/src/modules/order-tech-card/order-tech-card.service.ts',
    );
    const from = src.indexOf('async createManualLines(');
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf('private buildCharacteristics'));
    expect(body).toMatch(/\$transaction/);
    expect(body).toMatch(/normalizeMaterialLineCells\(/);
    // Пересборка ровно одна и вне цикла вставки.
    expect(body.match(/resyncTechCardDerived\(/g) ?? []).toHaveLength(1);
    const tx = body.slice(body.indexOf('$transaction'));
    expect(tx.indexOf('resyncTechCardDerived')).toBeGreaterThan(
      tx.indexOf('});'),
    );

    const controller = readSrc(
      'apps/api/src/modules/order-tech-card/order-tech-card.controller.ts',
    );
    expect(controller).toMatch(/@Post\('bulk'\)/);
    expect(controller).toMatch(/createManualLines\(/);
  });

  test('сдвоенная шапка постоянна и покрывает все колонки тела', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    // Зоны «Расход»/«Закупка» рендерятся всегда: селект единицы закупки
    // живёт в закупочных колонках, и прятать их за наличием расщеплённых
    // строк значило бы прятать сам селект.
    expect(src).not.toMatch(/hasSplitLines/);
    const head = src.slice(
      src.indexOf('<thead>'),
      src.indexOf('<th>Материал</th>'),
    );
    expect(head).toMatch(/colSpan=\{2\}/);
    expect(head).toMatch(/cws-grp--norm" colSpan=\{4\}/);
    expect(head).toMatch(/cws-grp--buy" colSpan=\{2\}/);
  });

  test('долг по параметрам показан чипом и проходом, но не гейтом', () => {
    const src = readSrc(
      'apps/web/components/orders/colorways/colorway-spec.tsx',
    );
    expect(src).toMatch(/cws-chip--todo/);
    expect(src).toMatch(/задать параметры/);
    expect(src).toMatch(/Заполнить параметры/);
    expect(src).toMatch(/материал \{queue\.index\} из \{queue\.total\}/);
    // Пачка сохраняется по ГОТОВЫМ строкам; параметры в готовность не входят.
    expect(src).toMatch(/function isDraftReady/);
    const ready = src.slice(
      src.indexOf('function isDraftReady'),
      src.indexOf('function isDraftBlank'),
    );
    expect(ready).not.toMatch(/characteristics|fabricType|subtypeKey/);
  });
});
