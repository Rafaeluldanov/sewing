/**
 * Smoke-тесты для блока «Экономика операции» на карточке
 * `/admin/operations/[id]` и компактного бейджа «8ч: …» в списке
 * `/admin/operations`.
 *
 * Это **только presentation layer**: helper-расчёт + UI карточки и
 * списка. Backend / DTO / Prisma / payroll / SalaryEntry /
 * OperationEntry / Passport / Order не меняются — этот тест-файл
 * заодно фиксирует «не уехало ли вычисление в payroll».
 *
 * Что проверяем:
 *   1. Helper `apps/web/lib/operation-economics.ts` существует и
 *      содержит `WORKDAY_SECONDS = 28800`.
 *   2. Карточка операции содержит «Экономика операции», тексты
 *      «Ожидаемая выработка / заработок за 8 часов», ветку BY_SIZE
 *      (компактные группы по размерам) и SALARY_ONLY (без
 *      заработка).
 *   3. Карточка операции компактная: блок «Техническая информация»
 *      (`AdminTechInfo`) удалён из этой страницы, «Экономика операции»
 *      переехала в правую колонку `admin-grid-2`, и нет
 *      дублирующего блока экономики ниже основной сетки.
 *   4. Список операций содержит компактный бейдж «8ч».
 *   5. Pure-расчёт `calculateOperationDailyEconomics` соответствует
 *      формуле: 28800 / 100 = 288 шт; 288 * 18 = 5184 ₽.
 *   6. Helper `groupOperationEconomicsRows` корректно схлопывает
 *      одинаковые строки в одну группу и разносит разные.
 *   7. CSS-классы `.operation-economics-groups` /
 *      `.operation-economics-group__metrics` существуют в
 *      `apps/web/app/globals.css`, и BY_SIZE-блок больше не использует
 *      широкую `admin-table` (которая обрезалась в правой колонке).
 *   8. Payroll / OperationEntry / SalaryEntry / Passport / Order
 *      не упоминают `operation-economics` (т.е. helper не утёк в
 *      backend).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  WORKDAY_SECONDS,
  calculateOperationDailyEconomics,
  formatEarningsPerDay,
  formatSizeGroupLabel,
  formatUnitsPerDay,
  groupOperationEconomicsRows,
  type OperationEconomicsSizeRow,
} from '../../apps/web/lib/operation-economics';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Helper
// ---------------------------------------------------------------------------

describe('Helper operation-economics', () => {
  test('apps/web/lib/operation-economics.ts экспортирует WORKDAY_SECONDS = 28800', () => {
    const src = readSrc('apps/web/lib/operation-economics.ts');
    expect(src).toMatch(
      /export\s+const\s+WORKDAY_SECONDS\s*=\s*8\s*\*\s*60\s*\*\s*60/,
    );
    expect(WORKDAY_SECONDS).toBe(28800);
  });

  test('экспортирует calculateOperationDailyEconomics и форматтеры', () => {
    const src = readSrc('apps/web/lib/operation-economics.ts');
    expect(src).toMatch(/export\s+function\s+calculateOperationDailyEconomics/);
    expect(src).toMatch(/export\s+function\s+formatUnitsPerDay/);
    expect(src).toMatch(/export\s+function\s+formatEarningsPerDay/);
  });

  test('формула: rate=18₽, timeNorm=100с ⇒ 288 шт, 5184 ₽', () => {
    const econ = calculateOperationDailyEconomics({
      rateRub: 18,
      timeNormSec: 100,
    });
    expect(econ.unitsPerDay).toBe(288);
    expect(econ.earningsPerDayRub).toBe(5184);
    expect(formatUnitsPerDay(econ.unitsPerDay)).toBe('288');
    // formatEarningsPerDay использует `\u00A0` как разделитель тысяч
    // (ru-RU NBSP) — поэтому сравниваем «гибко».
    const formatted = formatEarningsPerDay(econ.earningsPerDayRub);
    expect(formatted).toMatch(/5\D?184\s\u20BD/);
  });

  test('нет нормы времени ⇒ unitsPerDay/earningsPerDayRub = null', () => {
    expect(
      calculateOperationDailyEconomics({ rateRub: 18, timeNormSec: null }),
    ).toEqual({ unitsPerDay: null, earningsPerDayRub: null });
    expect(
      calculateOperationDailyEconomics({ rateRub: 18, timeNormSec: 0 }),
    ).toEqual({ unitsPerDay: null, earningsPerDayRub: null });
  });

  test('нет ставки ⇒ unitsPerDay считается, earningsPerDayRub = null', () => {
    const econ = calculateOperationDailyEconomics({
      rateRub: null,
      timeNormSec: 100,
    });
    expect(econ.unitsPerDay).toBe(288);
    expect(econ.earningsPerDayRub).toBeNull();
  });

  test('кастомный workdaySeconds переопределяет 28800', () => {
    const econ = calculateOperationDailyEconomics({
      rateRub: 10,
      timeNormSec: 60,
      workdaySeconds: 3600,
    });
    expect(econ.unitsPerDay).toBe(60);
    expect(econ.earningsPerDayRub).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// 2. Operation detail UI
// ---------------------------------------------------------------------------

describe('Карточка операции — секция «Экономика операции»', () => {
  const detailSrc = readSrc('apps/web/app/admin/operations/[id]/page.tsx');

  test('содержит заголовок «Экономика операции»', () => {
    expect(detailSrc).toMatch(/Экономика операции/);
  });

  test('содержит текст «Ожидаемая выработка за 8 часов»', () => {
    expect(detailSrc).toMatch(/Ожидаемая выработка за 8 часов/);
  });

  test('содержит текст «Ожидаемый заработок за 8 часов»', () => {
    expect(detailSrc).toMatch(/Ожидаемый заработок за 8 часов/);
  });

  test('импортирует calculateOperationDailyEconomics и форматтеры', () => {
    expect(detailSrc).toMatch(/calculateOperationDailyEconomics/);
    expect(detailSrc).toMatch(/formatEarningsPerDay/);
    expect(detailSrc).toMatch(/formatUnitsPerDay/);
  });

  test('BY_SIZE-ветка рендерит компактные группы (а не широкую таблицу)', () => {
    // Helper-группировка вместо «строка на каждый размер».
    expect(detailSrc).toMatch(/groupOperationEconomicsRows\s*\(/);
    // Контейнер групп и сами группы — BEM-классы.
    expect(detailSrc).toMatch(/operation-economics-groups/);
    expect(detailSrc).toMatch(/operation-economics-group__sizes/);
    expect(detailSrc).toMatch(/operation-economics-group__metrics/);
    // Iterate по operation.sizes — сначала собираем строки, потом
    // отдаём в helper-группировку.
    expect(detailSrc).toMatch(/operation\.sizes\.map/);
    // BY_SIZE-блок больше НЕ рисует <th>Размер</th> / <th>Ставка</th>:
    // это была старая пятиколоночная таблица, она не помещалась
    // в правую колонку.
    expect(detailSrc).not.toMatch(/<th>Размер<\/th>/);
    expect(detailSrc).not.toMatch(/<th>Ставка<\/th>/);
    expect(detailSrc).not.toMatch(/<th>Норма времени<\/th>/);
  });

  test('SALARY_ONLY-ветка показывает плановую окладную стоимость', () => {
    // SALARY_ONLY больше не «заглушка» — теперь у окладных операций
    // есть плановая стоимость смены и расчёт «стоимость на изделие /
    // выработка за смену» (см. ТЗ «Плановая стоимость окладных
    // операций»). Проверяем, что enum обрабатывается явно и блок
    // содержит ключевые лейблы.
    expect(detailSrc).toMatch(/pricingMode\s*===\s*'SALARY_ONLY'/);
    expect(detailSrc).toMatch(/SalaryOnlyEconomicsBlock/);
    expect(detailSrc).toMatch(/Плановая стоимость смены/);
    expect(detailSrc).toMatch(/Стоимость на изделие/);
    expect(detailSrc).toMatch(/Выработка за смену/);
    // Если ставка не задана — корректное сообщение.
    expect(detailSrc).toMatch(/Плановая окладная ставка не задана/);
  });

  test('обрабатывает «ставка не задана» / «норма времени не задана»', () => {
    expect(detailSrc).toMatch(/Ставка не задана/);
    expect(detailSrc).toMatch(/Норма времени не задана/);
  });
});

// ---------------------------------------------------------------------------
// 2b. Layout — компактная страница операции (Admin UI 2.6 polish)
// ---------------------------------------------------------------------------
//
// Старый layout: слева форма «Параметры операции», справа
// `AdminTechInfo` (ID/code/enums), под grid'ом — широкая карточка
// «Экономика операции».
//
// Новый layout: блок «Техническая информация» с карточки операции
// убран (мало пользы), «Экономика операции» переехала на его место в
// правую колонку. Дублирующий блок экономики ниже сетки — удалён.
// Сам компонент `AdminTechInfo` остаётся в проекте и используется
// другими detail-страницами — это проверено в
// `tests/smoke/admin-ui-consistency.smoke.test.ts`.

describe('Карточка операции — компактный layout (Экономика в правой колонке)', () => {
  const detailSrc = readSrc('apps/web/app/admin/operations/[id]/page.tsx');

  test('блок «Техническая информация» / AdminTechInfo с этой страницы убран', () => {
    expect(detailSrc).not.toMatch(/Техническая информация/);
    expect(detailSrc).not.toMatch(/<AdminTechInfo\b/);
    expect(detailSrc).not.toMatch(/import\s*\{[^}]*AdminTechInfo[^}]*\}/);
  });

  test('страница использует двухколоночный admin-grid-2', () => {
    expect(detailSrc).toMatch(/admin-grid-2/);
  });

  test('«Экономика операции» — единственный JSX-блок (нет дубликата ниже сетки)', () => {
    // Считаем именно JSX-использование заголовка в `AdminSectionHeader`,
    // а не упоминания в комментариях/документации файла.
    const matches = detailSrc.match(/title="Экономика операции"/g) ?? [];
    expect(matches.length).toBe(1);
    // И никаких других вариантов (например, прямого `<h2>Экономика…`
    // или второй `AdminSectionHeader title=`) тоже быть не должно.
    expect(detailSrc).not.toMatch(/<h2[^>]*>\s*Экономика операции/);
    expect(detailSrc).not.toMatch(/<h3[^>]*>\s*Экономика операции/);
  });

  test('«Экономика операции» рендерится внутри admin-grid-2 (правая колонка)', () => {
    const gridStart = detailSrc.indexOf('admin-grid-2');
    expect(gridStart).toBeGreaterThan(-1);
    // JSX-локация заголовка карточки экономики (а не упоминание в
    // docstring'е в начале файла).
    const econTitle = detailSrc.indexOf('title="Экономика операции"');
    expect(econTitle).toBeGreaterThan(gridStart);
    // Между открытием `<div className="admin-grid-2">` и карточкой
    // экономики не должно быть закрытия `AdminPageShell` — иначе
    // карточка ушла бы из сетки в отдельный широкий блок ниже.
    const between = detailSrc.slice(gridStart, econTitle);
    expect(between).not.toMatch(/<\/AdminPageShell>/);
  });

  test('хинт карточки экономики — «Плановая оценка за 8-часовую смену»', () => {
    expect(detailSrc).toMatch(/Плановая оценка за 8-часовую смену/);
  });

  test('BY_SIZE-блок — компактные группы, без широкой admin-table-wrap', () => {
    // Старый layout оборачивал BY_SIZE-таблицу в `.admin-table-wrap`
    // (overflow-x: auto). Новый компактный layout — карточки-группы
    // внутри `.operation-economics-groups`, никаких `<table>` /
    // `admin-table` на этой странице больше нет.
    expect(detailSrc).toMatch(/operation-economics-groups/);
    expect(detailSrc).not.toMatch(/admin-table-wrap/);
    expect(detailSrc).not.toMatch(/className="admin-table"/);
    expect(detailSrc).not.toMatch(/<table\b/);
  });

  test('расчёт экономики делегирован helper-у calculateOperationDailyEconomics', () => {
    // Не дублируем формулу 28800 / WORKDAY_SECONDS внутри страницы —
    // только вызов helper-а.
    expect(detailSrc).toMatch(/calculateOperationDailyEconomics\s*\(/);
    expect(detailSrc).not.toMatch(/WORKDAY_SECONDS/);
    expect(detailSrc).not.toMatch(/\b28800\b/);
  });
});

// ---------------------------------------------------------------------------
// 2c. BY_SIZE grouping — helper + CSS
// ---------------------------------------------------------------------------
//
// Helper `groupOperationEconomicsRows` (presentation-only) схлопывает
// строки экономики операции по одинаковым (rate / timeNorm /
// unitsPerDay / earningsPerDayRub). Цель — не выводить 21 одинаковую
// строку в правой колонке `admin-grid-2`. Backend / DTO / payroll НЕ
// меняются — это раздел `apps/web/lib/operation-economics.ts` плюс
// CSS в `apps/web/app/globals.css`.

describe('Группировка BY_SIZE — helper groupOperationEconomicsRows', () => {
  function row(
    overrides: Partial<OperationEconomicsSizeRow> & { sizeCode: string },
  ): OperationEconomicsSizeRow {
    const base: OperationEconomicsSizeRow = {
      sizeId: `id-${overrides.sizeCode}`,
      sizeCode: overrides.sizeCode,
      sizeSortOrder: 0,
      rateRub: 50,
      timeNormSec: 120,
      unitsPerDay: 240,
      earningsPerDayRub: 12000,
    };
    return { ...base, ...overrides };
  }

  test('одинаковые строки схлопываются в одну группу «Все размеры»', () => {
    const rows = ['XS', 'S', 'M', 'L'].map((c, i) =>
      row({ sizeCode: c, sizeSortOrder: i }),
    );
    const groups = groupOperationEconomicsRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].sizes).toHaveLength(4);
    expect(groups[0].sizeLabel).toBe('Все размеры');
    expect(groups[0].rateRub).toBe(50);
    expect(groups[0].timeNormSec).toBe(120);
    expect(groups[0].unitsPerDay).toBe(240);
    expect(groups[0].earningsPerDayRub).toBe(12000);
  });

  test('разные нормы времени — разные группы (порядок по sortOrder)', () => {
    const rows = [
      row({ sizeCode: '104', sizeSortOrder: 1, timeNormSec: 120 }),
      row({ sizeCode: '110', sizeSortOrder: 2, timeNormSec: 120 }),
      row({
        sizeCode: 'XS',
        sizeSortOrder: 3,
        timeNormSec: 140,
        unitsPerDay: 205,
        earningsPerDayRub: 12300,
      }),
      row({
        sizeCode: 'S',
        sizeSortOrder: 4,
        timeNormSec: 140,
        unitsPerDay: 205,
        earningsPerDayRub: 12300,
      }),
    ];
    const groups = groupOperationEconomicsRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].sizes.map((s) => s.sizeCode)).toEqual(['104', '110']);
    expect(groups[0].timeNormSec).toBe(120);
    expect(groups[1].sizes.map((s) => s.sizeCode)).toEqual(['XS', 'S']);
    expect(groups[1].timeNormSec).toBe(140);
    // Ни одна группа не покрывает все размеры — никакой «Все размеры».
    expect(groups.every((g) => g.sizeLabel !== 'Все размеры')).toBe(true);
  });

  test('строки без ставки/нормы выделяются в отдельную группу', () => {
    const rows = [
      row({ sizeCode: '104', sizeSortOrder: 1 }),
      row({ sizeCode: '110', sizeSortOrder: 2 }),
      row({
        sizeCode: 'XL',
        sizeSortOrder: 3,
        rateRub: null,
        timeNormSec: null,
        unitsPerDay: null,
        earningsPerDayRub: null,
      }),
    ];
    const groups = groupOperationEconomicsRows(rows);
    expect(groups).toHaveLength(2);
    const missingGroup = groups.find((g) => g.timeNormSec === null);
    expect(missingGroup).toBeDefined();
    expect(missingGroup!.sizes.map((s) => s.sizeCode)).toEqual(['XL']);
    expect(missingGroup!.rateRub).toBeNull();
    expect(missingGroup!.unitsPerDay).toBeNull();
    expect(missingGroup!.earningsPerDayRub).toBeNull();
  });

  test('formatSizeGroupLabel: > 6 ⇒ первые 5 + «ещё N»', () => {
    const big = Array.from({ length: 17 }, (_, i) => ({
      sizeCode: `${100 + i * 6}`,
    }));
    const label = formatSizeGroupLabel(big, 21);
    expect(label).toBe('100, 106, 112, 118, 124 + ещё 12');
  });

  test('formatSizeGroupLabel: ≤ 6 ⇒ перечисление через запятую', () => {
    expect(
      formatSizeGroupLabel(
        [{ sizeCode: 'XS' }, { sizeCode: 'S' }, { sizeCode: 'M' }],
        20,
      ),
    ).toBe('XS, S, M');
  });

  test('formatSizeGroupLabel: groupSizes.length === totalSizes ⇒ «Все размеры»', () => {
    expect(
      formatSizeGroupLabel([{ sizeCode: 'XS' }, { sizeCode: 'S' }], 2),
    ).toBe('Все размеры');
  });
});

describe('Группировка BY_SIZE — CSS-классы в globals.css', () => {
  const cssSrc = readSrc('apps/web/app/globals.css');

  test('содержит .operation-economics-groups / .operation-economics-group', () => {
    expect(cssSrc).toMatch(/\.operation-economics-groups\b/);
    expect(cssSrc).toMatch(/\.operation-economics-group\b/);
  });

  test('содержит .operation-economics-group__sizes / __metrics / __label / __value', () => {
    expect(cssSrc).toMatch(/\.operation-economics-group__sizes\b/);
    expect(cssSrc).toMatch(/\.operation-economics-group__metrics\b/);
    expect(cssSrc).toMatch(/\.operation-economics-group__label\b/);
    expect(cssSrc).toMatch(/\.operation-economics-group__value\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. Operation list UI
// ---------------------------------------------------------------------------

describe('Список операций — компактный бейдж «8ч»', () => {
  const listSrc = readSrc('apps/web/app/admin/operations/page.tsx');

  test('импортирует calculateOperationDailyEconomics', () => {
    expect(listSrc).toMatch(/calculateOperationDailyEconomics/);
  });

  test('показывает «8ч:» в строке (FIXED), «8ч: по размерам» (BY_SIZE), «8ч: оклад» (SALARY_ONLY) и «8ч: —»', () => {
    expect(listSrc).toMatch(/8ч:/);
    expect(listSrc).toMatch(/8ч: по размерам/);
    expect(listSrc).toMatch(/8ч: оклад/);
    expect(listSrc).toMatch(/8ч: —/);
  });

  test('добавлена колонка «За 8 часов»', () => {
    // После compact-redesign колонки описаны не массивом
    // `AdminTableColumn` (`header: '…'`), а напрямую как `<th>` —
    // защищаем именно DOM-разметку и render-helper.
    expect(listSrc).toMatch(/<th>За 8 часов<\/th>/);
    expect(listSrc).toMatch(/formatDailyEarnings/);
  });
});

// ---------------------------------------------------------------------------
// 4. Что НЕ должно меняться (payroll / fact / passport / order)
// ---------------------------------------------------------------------------

describe('Helper не утекает в backend / payroll / passport / order', () => {
  const forbiddenInFiles = [
    'apps/api/src/modules/earnings/earnings.service.ts',
    'apps/api/src/modules/salary/salary.service.ts',
    'apps/api/src/modules/passports/passports.service.ts',
    'apps/api/src/modules/orders/orders.service.ts',
    'apps/api/src/modules/orders/order-cost-estimates.service.ts',
    'apps/api/src/modules/routes/routes.service.ts',
    'apps/api/src/modules/costs/costs.service.ts',
  ];

  for (const file of forbiddenInFiles) {
    test(`${file} не упоминает operation-economics / WORKDAY_SECONDS`, () => {
      const src = readSrc(file);
      expect(src).not.toMatch(/operation-economics/);
      expect(src).not.toMatch(/WORKDAY_SECONDS/);
      expect(src).not.toMatch(/calculateOperationDailyEconomics/);
    });
  }

  test('Prisma-схема не получала новых полей под daily-плановую экономику', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).not.toMatch(/calculateOperationDailyEconomics/);
    expect(src).not.toMatch(/WORKDAY_SECONDS/);
    // Никаких новых полей с именами вида «*PerDay*» в Operation.
    // (Existing неfield names are matched by the `model` block; мы
    // проверяем только отсутствие новых имён, которые ввёл бы этот
    // helper.)
    expect(src).not.toMatch(/unitsPerDay/);
    expect(src).not.toMatch(/earningsPerDayRub/);
  });

  test('AdminTechInfo компонент остаётся в проекте (только использование с этой страницы убрано)', () => {
    // Сам файл компонента не трогаем — он используется на других
    // detail-страницах (`/admin/employees/[id]`, `/admin/equipment/[id]`,
    // `/admin/printers/[id]`, …).
    const componentSrc = readSrc('apps/web/components/admin/admin-tech-info.tsx');
    expect(componentSrc).toMatch(/export\s+function\s+AdminTechInfo/);
    const indexSrc = readSrc('apps/web/components/admin/index.ts');
    expect(indexSrc).toMatch(/AdminTechInfo/);
  });
});
