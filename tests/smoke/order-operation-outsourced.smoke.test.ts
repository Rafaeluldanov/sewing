/**
 * Smoke-тесты «операция делается на стороне» (сторонние услуги на шаге
 * маршрута заказа, решение владельца 10.09.2026).
 *
 * Без БД и без рендера — grep по исходникам. Задача та же, что у соседних
 * смоков: зафиксировать КАРКАС фичи (колонки, контракт, правило расчёта,
 * поверхности UI) и — что здесь важнее всего — её ГРАНИЦУ. Метка про
 * деньги: плановое время, доска, паспорта, гейты ОТК/упаковки и ЗП её не
 * читают, и любое упоминание `outsourc*` в этих файлах означает, что
 * граница нарушена.
 *
 * Что фиксируем:
 *   1. Prisma + миграция: три колонки подряда и расшифровка на заказе;
 *      миграция аддитивная и не трогает payroll/Passport-таблицы.
 *   2. Общий контракт (`packages/shared`): DTO маршрута, вход правки,
 *      снимок варианта просчёта, строка план-факта, потолок объёма.
 *   3. Движок плана: деление тиража, деньги по остатку, ВРЕМЯ по полному
 *      количеству, тексты warnings, ROUND_HALF_UP у расшифровки.
 *   4. Снимок маршрута и варианты: carry при пересборке, явный сброс при
 *      переключении варианта, гарды правки.
 *   5. План-факт документа: метка + «в том числе размещение» внутри плана.
 *   6. UI-поверхности: редактор расценок, таблица операций, план-факт.
 *   7. ⛔ ГРАНИЦА: ЗП/паспорта/упаковка/ОТК/доска/диагностика/узкое место/
 *      смета/очередь сдач в ERP — ни одного упоминания подряда.
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

describe('Сторонние услуги — Prisma: колонки метки и расшифровки', () => {
  test('OrderRouteStep несёт метку и цену размещения, размерная строка — объём', () => {
    const src = readSrc('prisma/schema.prisma');
    // Метка живёт на шаге ЗАКАЗА, а не на справочнике операции: правка
    // справочника поехала бы во все запущенные тиражи.
    expect(src).toMatch(/outsourced\s+Boolean\s+@default\(false\)/);
    expect(src).toMatch(/outsourcePriceRub\s+Decimal\?\s+@db\.Decimal\(12,\s*2\)/);
    expect(src).toMatch(/outsourcedQty\s+Int\?/);
  });

  test('Order.operationOutsourceCostPlanRub — расшифровка «в том числе»', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(
      /operationOutsourceCostPlanRub\s+Decimal\?\s+@db\.Decimal\(14,\s*2\)/,
    );
    // Полный план операций остаётся на прежнем поле — иначе каждый
    // потребитель складывал бы суммы по-своему.
    expect(src).toMatch(/operationCostPlanRub\s+Decimal\?\s+@db\.Decimal\(14,\s*2\)/);
  });

  test('Миграция 20261105090000_route_step_outsourced аддитивная', () => {
    const src = readSrc(
      'prisma/migrations/20261105090000_route_step_outsourced/migration.sql',
    );
    expect(src).toMatch(
      /ADD COLUMN IF NOT EXISTS "outsourced"\s+BOOLEAN NOT NULL DEFAULT false/,
    );
    expect(src).toMatch(
      /ADD COLUMN IF NOT EXISTS "outsourcePriceRub" DECIMAL\(12,\s*2\)/,
    );
    expect(src).toMatch(/ADD COLUMN IF NOT EXISTS "outsourcedQty" INTEGER/);
    expect(src).toMatch(
      /ADD COLUMN IF NOT EXISTS "operationOutsourceCostPlanRub" DECIMAL\(14,\s*2\)/,
    );
    // Только ADD COLUMN: ни сноса, ни сужения типов, ни новых таблиц.
    expect(src).not.toMatch(/DROP TABLE/);
    expect(src).not.toMatch(/DROP COLUMN/);
    expect(src).not.toMatch(/ALTER COLUMN/);
    expect(src).not.toMatch(/CREATE TABLE/);
    // И никакого DML: фича не переписывает существующие тиражи.
    expect(src).not.toMatch(/^\s*UPDATE\s+"/m);
    expect(src).not.toMatch(/^\s*DELETE\s+FROM/m);
    expect(src).not.toMatch(/TRUNCATE/);
  });

  test('Миграция не трогает payroll / Passport-таблицы', () => {
    // Часть тиража по той же операции цех делает сам: «пропуск шага»
    // остановил бы паспорта на упаковке и потерял бы сдельные начисления.
    const src = readSrc(
      'prisma/migrations/20261105090000_route_step_outsourced/migration.sql',
    );
    for (const table of [
      'OperationEntry',
      'SalaryEntry',
      'Passport',
      'PassportEvent',
      'PassportDefect',
      'PayrollPayout',
      'PayrollPayoutLine',
      'Box',
      'BoxItem',
      'Employee',
      'ShiftSession',
      'Operation',
      'OperationRateBySize',
      'OperationTimeNormBySize',
    ]) {
      expect(src).not.toMatch(new RegExp(`ALTER TABLE "${table}"`));
    }
    // Затронуты ровно три таблицы.
    const altered = [...src.matchAll(/ALTER TABLE "([A-Za-z]+)"/g)].map(
      (m) => m[1],
    );
    expect([...new Set(altered)].sort()).toEqual([
      'Order',
      'OrderRouteStep',
      'OrderRouteStepSizeOverride',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Общий контракт (packages/shared)
// ---------------------------------------------------------------------------

describe('Сторонние услуги — shared: DTO и схемы ввода', () => {
  test('routes.ts: DTO шага, поразмерная строка и потолок объёма', () => {
    const src = readSrc('packages/shared/src/routes.ts');
    expect(src).toMatch(/outsourced:\s*boolean/);
    expect(src).toMatch(/outsourcePriceRub:\s*number\s*\|\s*null/);
    expect(src).toMatch(/outsourcedQty:\s*number\s*\|\s*null/);
    expect(src).toMatch(
      /export const ROUTE_STEP_OUTSOURCED_QTY_MAX = 1_000_000/,
    );
  });

  test('routes.ts: вход правки — «не передано = не менять»', () => {
    const src = readSrc('packages/shared/src/routes.ts');
    // Оба поля опциональны: частичная правка не должна гасить подряд.
    expect(src).toMatch(/outsourced:\s*z\.boolean\(\)\.optional\(\)/);
    expect(src).toMatch(
      /outsourcePriceRub:\s*RouteStepRateOverrideField\.optional\(\)/,
    );
    // А объём в поразмерной строке — с дефолтом null (строка replace-all).
    expect(src).toMatch(
      /outsourcedQty:\s*RouteStepOutsourcedQtyField\.optional\(\)\.default\(null\)/,
    );
  });

  test('orders.ts: расшифровка размещения в списке/детали заказа', () => {
    const src = readSrc('packages/shared/src/orders.ts');
    expect(src).toMatch(
      /operationOutsourceCostPlanRub\?:\s*string\s*\|\s*number\s*\|\s*null/,
    );
  });

  test('order-calculations.ts: снимок варианта читает старые снимки без полей', () => {
    const src = readSrc('packages/shared/src/order-calculations.ts');
    // `nullish` + дефолт обязателен: снимки, снятые до фичи, иначе упали
    // бы в SNAPSHOT_INVALID и вкладка варианта перестала бы открываться.
    expect(src).toMatch(
      /outsourced:\s*z[\s\S]{0,80}\.nullish\(\)[\s\S]{0,60}\?\?\s*false/,
    );
    expect(src).toMatch(
      /outsourcePriceRub:\s*decimalString[\s\S]{0,60}\.nullish\(\)/,
    );
    expect(src).toMatch(/outsourcedQty:\s*z[\s\S]{0,120}\.nullish\(\)/);
  });

  test('order-production-document.ts: строка план-факта несёт метку и расшифровку', () => {
    const src = readSrc('packages/shared/src/order-production-document.ts');
    expect(src).toMatch(/outsourced:\s*boolean/);
    expect(src).toMatch(/outsourcePlanRub:\s*string\s*\|\s*null/);
  });
});

// ---------------------------------------------------------------------------
// 3. Движок плана операций — ПРАВИЛО РАСЧЁТА
// ---------------------------------------------------------------------------

describe('Сторонние услуги — OrderOperationPlanService: правило расчёта', () => {
  const planSrc = () =>
    readSrc('apps/api/src/modules/orders/order-operation-plan.service.ts');

  test('оба входа (шаблон и снимок) читают метку, цену и поразмерный объём', () => {
    const src = planSrc();
    expect(src).toMatch(/outsourced:\s*true/);
    expect(src).toMatch(/outsourcePriceRub:\s*true/);
    expect(src).toMatch(/outsourcedQty:\s*true/);
    // Карта объёмов собирается с нулями: «расписан ноль» ≠ «размеры не
    // расписаны» (пустая карта означает «весь тираж на стороне»).
    expect(src).toMatch(/outsourcedQtyBySize\.set\(o\.sizeId,\s*o\.outsourcedQty\)/);
  });

  test('тираж делится на «своё» и «подряд», пустая карта = весь тираж', () => {
    const src = planSrc();
    expect(src).toMatch(/const wholeStepOutsourced = outMap\.size === 0/);
    // Жадная раздача остатка по размеру, но не больше строки плана —
    // объём сверх тиража сгорает, платить за несуществующие изделия нельзя.
    expect(src).toMatch(/Math\.min\(left,\s*item\.qtyPlan\)/);
    expect(src).toMatch(/const ownQty = qty - outQty/);
  });

  test('деньги считаются по остатку во всех трёх режимах PricingMode', () => {
    const src = planSrc();
    expect(src).toMatch(/salaryCostPerSec\.mul\(timeSec\)\.mul\(ownQty\)/);
    expect(src).toMatch(/totalCost\.add\(rate\.mul\(ownQty\)\)/);
    expect(src).toMatch(/step\.outsourcePriceRub\.mul\(outQty\)/);
  });

  test('ВРЕМЯ считается по полному количеству — метка только про деньги', () => {
    // Решение владельца: доска, узкое место и загрузка цеха живут по
    // полному тиражу. `mul(ownQty)` здесь означал бы смещение планирования.
    const src = planSrc();
    expect(src).toMatch(/totalTimeSec \+= timeSec \* qty/);
    expect(src).not.toMatch(/totalTimeSec \+= timeSec \* ownQty/);
  });

  test('warnings: цена обязательна, а ставка при полном подряде — нет', () => {
    const src = planSrc();
    expect(src).toMatch(/Не задана цена стороннего размещения по операции/);
    expect(src).toMatch(/размещение посчитано как 0/);
    // Подавление шума считается ДО цикла по строкам плана: своей части не
    // осталось ни в одной строке ⇒ ставка не нужна.
    expect(src).toMatch(/const fullyOutsourced =/);
    expect(src).toMatch(/if \(!fullyOutsourced\)/);
  });

  test('расшифровка округляется тем же ROUND_HALF_UP и пишется на заказ', () => {
    const src = planSrc();
    expect(src).toMatch(
      /totalOutsource\.toDecimalPlaces\(\s*2,\s*Prisma\.Decimal\.ROUND_HALF_UP/,
    );
    expect(src).toMatch(
      /operationOutsourceCostPlanRub:\s*result\.outsourceCostRub/,
    );
    // Полный план остаётся полным (своё + размещение) — контракт §5 ТЗ.
    expect(src).toMatch(/operationCostPlanRub:\s*result\.totalCostRub/);
  });
});

// ---------------------------------------------------------------------------
// 4. Снимок маршрута, правка и варианты просчёта
// ---------------------------------------------------------------------------

describe('Сторонние услуги — OrdersService: снимок и правка', () => {
  const ordersSrc = () =>
    readSrc('apps/api/src/modules/orders/orders.service.ts');

  test('пересборка снимка переносит метку, цену и объём', () => {
    // В шаблоне маршрута подряда нет: без carry метка слетала бы на первом
    // же ре-синке структуры (а он случается при обычном сохранении формы).
    const src = ordersSrc();
    // ⚠️ Только ПЕРВОМУ вхождению операции: «100 шт на сторону»,
    // разложенные на два вхождения одной операции в маршруте, дали бы
    // двойную стоимость размещения.
    expect(src).toMatch(
      /outsourced:\s*takesOutsource \? \(carry\?\.outsourced \?\? false\) : false/,
    );
    expect(src).toMatch(
      /outsourcePriceRub:\s*takesOutsource \? carry!\.outsourcePriceRub : null/,
    );
    expect(src).toMatch(
      /outsourcedQty:\s*takesOutsource \? o\.outsourcedQty : null/,
    );
  });

  test('объём на сторону не больше плана размера (400 на новое значение)', () => {
    const src = ordersSrc();
    expect(src).toMatch(/ORDER_ROUTE_OUTSOURCED_QTY_OVER_PLAN/);
    expect(src).toMatch(/на сторону нельзя отдать/);
    // ⚠️ Отбивается только НОВОЕ значение: уже лежащий объём мог стать
    // больше плана сам собой (уменьшили тираж), и жёсткий 400 на него
    // запер бы всю форму правки маршрута. Такое значение обрезается.
    expect(src).toMatch(/storedOutsourcedQty/);
    expect(src).toMatch(/so\.outsourcedQty = planQty;/);
  });

  test('гард «сделка без расценки» держится и при полном подряде', () => {
    const src = ordersSrc();
    // ⛔ Исключения для «целиком на стороне» БЫТЬ НЕ ДОЛЖНО: шаг остаётся в
    // маршруте, паспорт идёт через него, приёмщик закрывает операцию сканом
    // на возврате партии — сделка без расценки роняет скан
    // (`OperationRateMissingException`). Гард безусловный.
    expect(src).toMatch(/if \(!hasRate\) \{/);
    expect(src).not.toMatch(/!hasRate && !fullyOutsourced/);
    expect(src).toMatch(/ORDER_ROUTE_OVERRIDE_RATE_REQUIRED/);
  });

  test('повтор операции в маршруте: подряд достаётся ПЕРВОМУ вхождению', () => {
    // Расценка от повтора не страдает (она за штуку), а ОБЪЁМ страдает:
    // «100 шт на сторону», разложенные на два вхождения одной операции
    // (ОТК/ВТО до и после), дали бы двойную стоимость размещения. И carry
    // снимка, и восстановление варианта ключуются `operationId`, поэтому
    // оба обязаны отдавать подряд только первому шагу.
    expect(ordersSrc()).toMatch(/const outsourceCarried = new Set<string>\(\)/);
    const calcSrc = readSrc(
      'apps/api/src/modules/order-calculations/order-calculations.service.ts',
    );
    expect(calcSrc).toMatch(/const outsourceGiven = new Set<string>\(\)/);
    // Порядок «первого» должен быть порядком маршрута, а не выдачи БД.
    expect(calcSrc).toMatch(/orderBy: \{ index: 'asc' \}/);
  });

  test('план-факт: отклонение считается от СВОЕЙ части плана', () => {
    const src = readSrc(
      'apps/api/src/modules/costs/order-production-document.service.ts',
    );
    // Иначе отданная подрядчику операция вечно показывала бы «экономию» на
    // всю сумму подряда — работу, которую цех не делал и делать не должен.
    expect(src).toMatch(/planOutsourceRub: planOutsource\.toFixed\(2\)/);
    expect(src).toMatch(
      /factOperations\.sub\(planOperations\.sub\(planOutsource\)\)/,
    );
    // Подряд признаётся в факте плановой суммой — иначе маржа завышена.
    expect(src).toMatch(
      /issuedMaterials\.add\(factOperations\)\.add\(planOutsource\)/,
    );
  });

  test('снятие метки гасит цену и поразмерные объёмы', () => {
    const src = ordersSrc();
    expect(src).toMatch(/const clearsOutsource = step\.outsourced === false/);
    expect(src).toMatch(/outsourcedQty:\s*clearsOutsource \? null : o\.outsourcedQty/);
    // Строка с одним объёмом — законная: фильтр «непустой строки» обязан
    // её пропускать, иначе объём молча не сохранится.
    expect(src).toMatch(
      /o\.rate != null \|\| o\.seconds != null \|\| o\.outsourcedQty != null/,
    );
  });

  test('DTO заказа отдаёт метку, цену и расшифровку размещения', () => {
    const src = ordersSrc();
    expect(src).toMatch(/outsourced:\s*s\.outsourced/);
    expect(src).toMatch(/outsourcedQty:\s*o\.outsourcedQty \?\? null/);
    expect(src).toMatch(/operationOutsourceCostPlanRub/);
  });
});

describe('Сторонние услуги — варианты просчёта', () => {
  const calcSrc = () =>
    readSrc(
      'apps/api/src/modules/order-calculations/order-calculations.service.ts',
    );

  test('шаг с ОДНОЙ меткой попадает в снимок варианта', () => {
    // Самый частый случай: владелец отдал операцию подрядчику, расценку и
    // норму не трогал. По прежнему условию такой шаг в снимок не попадал,
    // и вариант «шьём на стороне» возвращался пустым.
    const src = calcSrc();
    expect(src).toMatch(/s\.outsourced \|\|/);
    expect(src).toMatch(/s\.outsourcePriceRub != null/);
    expect(src).toMatch(/outsourcedQty:\s*so\.outsourcedQty/);
  });

  test('шагам вне снимка пишется ЯВНЫЙ сброс подряда', () => {
    // «Не передано» бэкенд читает как «не менять», поэтому молчание
    // протащило бы метку соседнего варианта через carry снимка.
    const src = calcSrc();
    expect(src).toMatch(
      /outsourced:\s*takesOutsource \? \(o\?\.outsourced \?\? false\) : false/,
    );
    expect(src).toMatch(/outsourcePriceRub:[\s\S]{0,120}: null,/);
    // Объём из снимка режется планом ВОССТАНОВЛЕННОГО варианта: снимок мог
    // быть снят с большего тиража, а машинная активация обязана пройти без
    // 400 — иначе вкладка просчёта переключается наполовину.
    expect(src).toMatch(/Math\.min\(\s*so\.outsourcedQty,/);
  });
});

// ---------------------------------------------------------------------------
// 5. План-факт документа
// ---------------------------------------------------------------------------

describe('Сторонние услуги — документ производства (план→факт)', () => {
  const docSrc = () =>
    readSrc('apps/api/src/modules/costs/order-production-document.service.ts');

  test('строка операции несёт метку и «в том числе размещение»', () => {
    const src = docSrc();
    expect(src).toMatch(/outsourced:\s*acc\.outsourced/);
    expect(src).toMatch(/outsourcePlanRub:/);
  });

  test('то же правило: деньги по остатку, время — по полному количеству', () => {
    const src = docSrc();
    expect(src).toMatch(/const ownQty = qty - outQty/);
    expect(src).toMatch(/step\.outsourcePriceRub\.mul\(outQty\)/);
    expect(src).toMatch(/stepTime \+= timeSec \* qty/);
    expect(src).not.toMatch(/stepTime \+= timeSec \* ownQty/);
  });
});

// ---------------------------------------------------------------------------
// 6. UI-поверхности
// ---------------------------------------------------------------------------

describe('Сторонние услуги — редактор расценок заказа', () => {
  test('чекбокс метки, цена размещения и поразмерный объём', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/order-route-overrides-editor.tsx',
    );
    expect(src).toMatch(/data-testid=\{`order-route-overrides-outsourced-\$\{step\.stepId\}`\}/);
    expect(src).toMatch(
      /data-testid=\{`order-route-overrides-outsource-price-\$\{step\.stepId\}`\}/,
    );
    expect(src).toMatch(/order-route-overrides-outsource-qty-/);
    // Потолок объёма берётся из общего контракта, а не переписан числом.
    expect(src).toMatch(/ROUTE_STEP_OUTSOURCED_QTY_MAX/);
    // Пустой набор объёмов = вся операция на стороне: подсказка обязана
    // это говорить, иначе менеджер прочтёт пустоту как «ничего не отдано».
    expect(src).toMatch(/пусто = вся операция на стороне/);
  });

  test('данные редактора несут qtyPlan размера и поля подряда', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/route-overrides-editor-data.ts',
    );
    expect(src).toMatch(/qtyPlan/);
    expect(src).toMatch(/outsourced:\s*step\.outsourced === true/);
    expect(src).toMatch(/outsourcedQty:\s*o\.outsourcedQty \?\? null/);
  });
});

describe('Сторонние услуги — таблица операций заказа', () => {
  test('строка считает подряд по тому же правилу', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/build-order-operation-rows.ts',
    );
    expect(src).toMatch(/resolveOutsourceSplit/);
    expect(src).toMatch(/outsourceCostRub/);
    expect(src).toMatch(/totalOutsourceCostRub/);
  });

  test('бейдж «на стороне» и строка «в т.ч. стороннее размещение»', () => {
    const src = readSrc(
      'apps/web/components/orders/operations/order-operations-unified-table.tsx',
    );
    expect(src).toMatch(/data-testid="order-operation-outsourced-badge"/);
    expect(src).toMatch(/data-testid="order-operations-summary-outsource"/);
    // Источник итога — расшифровка с заказа, web-сумма только fallback.
    expect(src).toMatch(/operationOutsourceCostPlanRub/);
  });
});

describe('Сторонние услуги — представление план→факт', () => {
  test('метка на строке и «в т.ч. на стороне» под планом', () => {
    const src = readSrc(
      'apps/web/app/admin/production-cost/order/[orderId]/production-document-view.tsx',
    );
    expect(src).toMatch(/на стороне/);
    expect(src).toMatch(/в т\.ч\. на стороне/);
    // Δ считается от СВОЕЙ части плана (бэкенд вычел размещение), поэтому
    // у ЧАСТИЧНОГО подряда это нормальный сигнал и гасить его нельзя.
    // Нейтральной строка становится, только когда своей части нет вовсе.
    expect(src).toMatch(/ownPlanRub == null \|\| ownPlanRub <= 0\.004/);
    expect(src).not.toMatch(/neutral=\{r\.outsourced\}/);
    // Итог документа объясняет, откуда в плане деньги без факта.
    expect(src).toMatch(/в т\.ч\. стороннее размещение/);
  });
});

// ---------------------------------------------------------------------------
// 7. ⛔ ГРАНИЦА: метка не протекла в ЗП, паспорта, гейты и смету
// ---------------------------------------------------------------------------

describe('Сторонние услуги — ⛔ контур ЗП, паспортов и гейтов не тронут', () => {
  // Правило владельца: часть тиража по той же операции цех делает сам.
  // Любая попытка «пропустить шаг» по метке остановила бы паспорта на
  // упаковке (она считает число шагов QC/IRONING в маршруте), потеряла бы
  // сдельные начисления и незакрытую работу в диагностике.
  const forbidden: Array<{ label: string; file: string }> = [
    { label: 'сдельная ЗП', file: 'apps/api/src/modules/earnings/earnings.service.ts' },
    { label: 'окладная ЗП', file: 'apps/api/src/modules/salary/salary.service.ts' },
    { label: 'паспорта', file: 'apps/api/src/modules/passports/passports.service.ts' },
    { label: 'упаковка', file: 'apps/api/src/modules/packing/packing.service.ts' },
    { label: 'ОТК', file: 'apps/api/src/modules/qc/qc.service.ts' },
    {
      label: 'ставки операций (resolveRate)',
      file: 'apps/api/src/modules/operations/operations.service.ts',
    },
    {
      label: 'доска производства',
      file: 'apps/api/src/modules/production-board/production-board.service.ts',
    },
    {
      label: 'долги маршрута',
      file: 'apps/api/src/modules/production-board/route-debt.ts',
    },
    {
      label: 'диагностика',
      file: 'apps/api/src/modules/diagnostics/diagnostics.service.ts',
    },
  ];

  for (const { label, file } of forbidden) {
    test(`${label}: ни одного упоминания outsourc*`, () => {
      expect(readSrc(file)).not.toMatch(/outsourc/i);
    });
  }

  test('узкое место (order-production-balance) считает по полному тиражу', () => {
    // Плановое время метка не меняет — значит и расчёту узкого места про
    // подряд знать нечего.
    const src = readSrc(
      'apps/api/src/modules/orders/order-production-balance.service.ts',
    );
    expect(src).not.toMatch(/outsourc/i);
  });

  test('смета заказа не знает о подряде (там труда нет вообще)', () => {
    const src = readSrc(
      'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    );
    expect(src).not.toMatch(/outsourc/i);
    // Историческая граница смет — на всякий случай рядом.
    expect(src).not.toMatch(/'LABOR'/);
  });

  test('очередь сдач в ERP не кладёт размещение в цеховую себестоимость', () => {
    // ERP добавляет свой компонент подряда сама (`production_receipt.py`,
    // `_cost_out`): сумма, положенная ещё и здесь, задвоилась бы невидимо
    // для разбивки.
    const src = readSrc(
      'apps/api/src/modules/integrations/erp-production.service.ts',
    );
    expect(src).not.toMatch(/outsourc/i);
  });
});
