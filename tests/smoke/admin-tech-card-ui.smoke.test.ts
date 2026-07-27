/**
 * Smoke-тесты UI-рефакторинга «Техкарта = материальные требования»
 * (`/admin/tech-cards/new` и `/admin/tech-cards/[id]`).
 *
 * Контекст (см. ТЗ §«Очистить UI техкарты»):
 *   - Техкарта теперь хранит ровно материальные требования: роль
 *     материала, характеристику полотна, плотность, плановую ширину
 *     рулона, правило цвета.
 *   - Нанесение задаётся в заказе через `OrderApplication`, упаковка —
 *     операциями маршрута, нормa расхода по площади — в
 *     `PatternMaterialArea`.
 *   - Старые поля строки техкарты (`name` / `unit` / `qtyPerUnit` /
 *     `note`) и Prisma-модель `TechCardOutsourceLine` сохраняются в
 *     БД как legacy — UI больше не предлагает их редактировать
 *     явно, action генерирует безопасный fallback при submit.
 *
 * Покрываем (source-level, как остальные smoke-тесты в этой папке —
 * полноценный React-рендерер в vitest у нас не настроен):
 *
 *   1. Блок переименован в «Материальные требования» + есть
 *      пояснительная подсказка про OrderApplication / маршрут.
 *   2. В строке материала видимыми остаются ровно 6 полей: роль,
 *      характеристика полотна, плотность, ширина рулона, правило
 *      цвета, фиксированный цвет.
 *   3. Visible labels «Название» / «Ед.» / «Норма / шт» / «Примечание»
 *      из строки материала убраны.
 *   4. Legacy поля передаются `<input type="hidden">`, а не видимыми
 *      input-ами.
 *   5. В select «Роль материала» нет PACKAGING / APPLICATION среди
 *      доступных опций (только legacy-fallback для уже сохранённых
 *      строк остаётся).
 *   6. `actions.ts::buildMaterialLines` подменяет пустые
 *      `name`/`unit`/`qtyPerUnit` на fallback (fabricType / role
 *      label / 'Материал', 'кг', '1') и не теряет legacy значения.
 *   7. Prisma не менялась: `TechCardMaterialLine` сохраняет
 *      `name` / `unit` / `qtyPerUnit` / `note`; модель
 *      `TechCardOutsourceLine` присутствует.
 *   8. Shared schema `TechCardMaterialLineInputSchema` сохраняет
 *      `name` / `unit` / `qtyPerUnit` как required.
 *   9. UI-блок «Внешние потребности» больше не предлагает кнопку
 *      «Добавить»; рендерится только при наличии legacy-строк
 *      и помечен как `(legacy)` с поясняющей подсказкой.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}
function exists(rel: string): boolean {
  return existsSync(path.join(repoRoot, rel));
}

const FORM = 'apps/web/app/admin/tech-cards/tech-card-form.tsx';
const ACTIONS = 'apps/web/app/admin/tech-cards/actions.ts';
const NEW_PAGE = 'apps/web/app/admin/tech-cards/new/page.tsx';
const DETAIL_PAGE = 'apps/web/app/admin/tech-cards/[id]/page.tsx';
const SHARED = 'packages/shared/src/tech-cards.ts';
const PRISMA = 'prisma/schema.prisma';
const CSS = 'apps/web/app/globals.css';

// ---------------------------------------------------------------------------
// 1. Заголовок и подсказка блока «Материальные требования»
// ---------------------------------------------------------------------------

describe('tech-card UI — блок «Материальные требования»', () => {
  test('форма содержит заголовок «Материальные требования»', () => {
    const src = read(FORM);
    expect(src).toMatch(/Материальные требования/);
    // Старый заголовок «Материалы» в качестве отдельного <strong>
    // больше не используется в этой форме.
    expect(src).not.toMatch(/<strong>Материалы<\/strong>/);
  });

  test('подсказка про OrderApplication и операции маршрута присутствует', () => {
    const src = read(FORM);
    expect(src).toMatch(
      /Техкарта определяет требования к материалам\. Нанесение задаётся в заказе, упаковка — в операциях маршрута\./,
    );
  });

  test('подсказка отрисовывается в JSX как видимый <p>', () => {
    const src = read(FORM);
    expect(src).toMatch(
      /<p[^>]*admin-material-requirements__hint[^>]*>\s*\{MATERIAL_REQUIREMENTS_HINT\}/,
    );
  });

  test('обе страницы (new и [id]) собирают форму TechCardForm', () => {
    expect(exists(NEW_PAGE)).toBe(true);
    expect(exists(DETAIL_PAGE)).toBe(true);
    expect(read(NEW_PAGE)).toMatch(/<TechCardForm\b[^>]*mode="create"/);
    expect(read(DETAIL_PAGE)).toMatch(/<TechCardForm\b[^>]*mode="edit"/);
  });
});

// ---------------------------------------------------------------------------
// 2. Видимые поля в строке материала
// ---------------------------------------------------------------------------

describe('tech-card UI — видимые поля строки материала', () => {
  const src = read(FORM);

  test('строка содержит видимый label «Роль материала»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Роль материала\s*<\/label>/);
  });

  test('строка содержит видимый label «Характеристика полотна»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Характеристика полотна\s*<\/label>/);
  });

  test('строка содержит видимый label «Плотность, г/м²»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Плотность, г\/м²\s*<\/label>/);
  });

  test('строка содержит видимый label «Ширина рулона, см»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Ширина рулона, см\s*<\/label>/);
  });

  test('строка содержит видимый label «Правило цвета»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Правило цвета\s*<\/label>/);
  });

  test('строка содержит видимый label «Фиксированный цвет»', () => {
    expect(src).toMatch(/<label[^>]*>\s*Фиксированный цвет\s*<\/label>/);
  });
});

// ---------------------------------------------------------------------------
// 3. Видимые legacy-поля удалены
// ---------------------------------------------------------------------------

describe('tech-card UI — legacy поля скрыты от пользователя', () => {
  const src = read(FORM);

  test('из MaterialRowCard убран видимый <label> «Название»', () => {
    // В админ-форме теперь два упоминания «Название»: верхнего
    // уровня — это название самой техкарты (`<label htmlFor="tc-name">`),
    // оно остаётся. Внутри MaterialRowCard видимого label
    // «Название» больше нет.
    const idx = src.indexOf('function MaterialRowCard');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx);
    expect(block).not.toMatch(/<label[^>]*>\s*Название\s*<\/label>/);
  });

  test('из MaterialRowCard убран видимый <label> «Ед.»', () => {
    const idx = src.indexOf('function MaterialRowCard');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx);
    expect(block).not.toMatch(/<label[^>]*>\s*Ед\.\s*<\/label>/);
  });

  test('из MaterialRowCard убран видимый <label> «Норма / шт»', () => {
    const idx = src.indexOf('function MaterialRowCard');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx);
    expect(block).not.toMatch(/<label[^>]*>\s*Норма \/ шт\s*<\/label>/);
  });

  test('из MaterialRowCard убран видимый <label> «Примечание»', () => {
    const idx = src.indexOf('function MaterialRowCard');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx);
    expect(block).not.toMatch(/<label[^>]*>\s*Примечание\s*<\/label>/);
  });

  test('legacy поля приходят через hidden inputs', () => {
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[name\]`\}\s+value=\{row\.name\}\s*\/>/,
    );
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[unit\]`\}\s+value=\{row\.unit\}\s*\/>/,
    );
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[qtyPerUnit\]`\}\s+value=\{row\.qtyPerUnit\}\s*\/>/,
    );
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[note\]`\}\s+value=\{row\.note\}\s*\/>/,
    );
  });

  test('секция «Параметры для потребности» (старый <details>) удалена', () => {
    expect(src).not.toMatch(/Параметры для потребности/);
  });
});

// ---------------------------------------------------------------------------
// 4. Роли материала: PACKAGING/APPLICATION недоступны как новые опции
// ---------------------------------------------------------------------------

describe('tech-card UI — роли строки материала из категорий номенклатуры', () => {
  const src = read(FORM);

  test('форма использует TECH_CARD_MATERIAL_ROLE_KEYS (источник — PATTERN_CATEGORY_PARAMETER_GROUPS)', () => {
    expect(src).toMatch(/TECH_CARD_MATERIAL_ROLE_KEYS/);
    expect(src).toMatch(/getTechCardMaterialRoleLabel\(/);
    // Старый узкий список MATERIAL_ROLES в самом select больше не
    // используется (label-функция знает PACKAGING → «Фурнитура»).
    expect(src).not.toMatch(/MATERIAL_ROLES\.filter\(/);
  });

  test('PACKAGING остаётся в whitelist (UI-метка «Фурнитура»)', () => {
    // PACKAGING не должен фильтроваться — это технический roleKey
    // фурнитуры, и select обязан его предлагать.
    expect(src).not.toMatch(/role !== 'PACKAGING'/);
    // Должна использоваться функция, которая для PACKAGING возвращает
    // «Фурнитура», но НЕ «Упаковка» (см. ТЗ §1).
    expect(src).toMatch(/getTechCardMaterialRoleLabel/);
  });

  test('legacy-fallback (например APPLICATION) показывается с пометкой «(legacy)»', () => {
    // Один универсальный fallback вместо двух статических <option>:
    // показываем именно текущее legacy-значение из `row.materialRole`,
    // если его нет в `TECH_CARD_MATERIAL_ROLE_KEYS`.
    expect(src).toMatch(/isKnownTechCardMaterialRoleKey/);
    expect(src).toMatch(/\(legacy\)/);
  });

  test('UI не содержит слова «Упаковка»', () => {
    // Cм. ТЗ §«Не возвращать слово Упаковка». Лейбл «Фурнитура»
    // приходит из `PATTERN_CATEGORY_PARAMETER_GROUPS`.
    expect(src).not.toMatch(/Упаковка/);
  });
});

// ---------------------------------------------------------------------------
// 4b. Кнопка «Подтянуть из номенклатуры» (этап «Подтянуть из номенклатуры
// + погонные метры», см. ТЗ §1, §2, §3, §4)
//
// ВАЖНО (см. ТЗ §1): источник — конкретная номенклатура (PatternItem),
// НЕ категория. Источников теперь два:
//   A) `PatternItemParameterNorm` (qtyPerItem > 0) — «Фурнитура и нормы»;
//   B) `PatternItemSizeParameterValue` LINEAR_M_BY_SIZE с хотя бы одним
//      value > 0 — «Погонные метры».
// Дедупликация по `materialRole + fabricType`; пустые fabricType в
// существующих строках апдейтятся, дубль не создаётся (см. ТЗ §3).
// ---------------------------------------------------------------------------

describe('tech-card UI — «Подтянуть из номенклатуры»', () => {
  const src = read(FORM);
  const actions = read(ACTIONS);

  test('форма принимает prop patternItems (конкретные номенклатуры)', () => {
    expect(src).toMatch(/patternItems\??:\s*PatternItemOption/);
  });

  test('форма содержит кнопку «Подтянуть из номенклатуры»', () => {
    expect(src).toMatch(/Подтянуть из номенклатуры/);
    expect(src).toMatch(/handlePullFromNomenclature/);
  });

  test('форма вызывает server action pullMaterialLinesFromPatternAction', () => {
    expect(src).toMatch(/pullMaterialLinesFromPatternAction/);
    // Старого action-а больше нет — UI не должен ссылаться на него.
    expect(src).not.toMatch(/pullMaterialRolesFromCategoryAction/);
  });

  test('handlePullFromNomenclature НЕ удаляет существующие строки и работает над копией массива', () => {
    // Должны добавлять/апдейтить только недостающие/частичные шаблоны,
    // полностью существующие строки не трогать (см. ТЗ §3 «Не
    // дублировать строки при подтягивании»). Реализация работает
    // через `next` — копию prev, в которую мы пушим/апдейтим, не
    // мутируя исходный массив.
    expect(src).toMatch(/dedupeKey\(/);
    expect(src).toMatch(/const next:\s*MaterialRow\[\]\s*=\s*prev\.map/);
    // Хотя бы одна явная ветка `next.push(emptyMaterialRow(`
    // (добавление новой строки).
    expect(src).toMatch(/next\.push\(\s*emptyMaterialRow\(/);
  });

  test('подтягивание dedupe по materialRole + fabricType (PACKAGING разрешает несколько строк)', () => {
    // ТЗ §3: ключ = materialRole + normalized fabricType. Для
    // PACKAGING это разные ключи (Молния / Кнопки / Люверсы) —
    // их можно иметь несколько в одной техкарте.
    expect(src).toMatch(/function dedupeKey\b/);
    expect(src).toMatch(/normalizeDedupeFabric/);
    expect(src).toMatch(/\$\{roleKey\}::\$\{normalizeDedupeFabric/);
  });

  test('пустой fabricType существующей строки апдейтится, дубль не создаётся (ТЗ §3)', () => {
    // Логика: если в форме уже есть строка с тем же materialRole, но
    // пустым fabricType, мы НЕ добавляем новую, а заполняем
    // существующую из шаблона.
    expect(src).toMatch(/normalizeDedupeFabric\(r\.fabricType\)\s*===\s*''/);
    expect(src).toMatch(/updatedCount/);
  });

  test('action подтягивает PatternItemParameterNorm с qtyPerItem > 0', () => {
    expect(actions).toMatch(/pullMaterialLinesFromPatternAction/);
    expect(actions).toMatch(/getPattern\(/);
    expect(actions).toMatch(/parameterNorms/);
    // Фильтр по фактической норме > 0 (см. ТЗ §1).
    expect(actions).toMatch(/qtyPerItem/);
    // Старая логика «тянем роли из категории» удалена.
    expect(actions).not.toMatch(/pullMaterialRolesFromCategoryAction/);
    expect(actions).not.toMatch(/getPatternCategory\(/);
  });

  test('action также подтягивает PatternItemSizeParameterValue (LINEAR_M_BY_SIZE, value > 0)', () => {
    // ТЗ §1, §2: второй источник — погонные метры по размерам.
    // Фильтр по `inputTypeSnapshot === 'LINEAR_M_BY_SIZE'` и
    // группировка по `categoryParameterId` (одна строка-шаблон на
    // параметр, не строка на каждый размер).
    expect(actions).toMatch(/sizeParameterValues/);
    expect(actions).toMatch(/'LINEAR_M_BY_SIZE'/);
    expect(actions).toMatch(/categoryParameterId/);
    // Источник типизирован: добавили sourceType = SIZE_PARAMETER_VALUE.
    expect(actions).toMatch(/'SIZE_PARAMETER_VALUE'/);
    expect(actions).toMatch(/'PARAMETER_NORM'/);
  });

  test('action не тянет AREA_M2_BY_SIZE (ТЗ §6)', () => {
    // На этом этапе площади из PatternMaterialArea не подтягиваются.
    // В коде action-а не должно быть фильтра/чтения по этому
    // inputType. Сам токен `AREA_M2_BY_SIZE` может встречаться в
    // doc-комментариях («не тянем»), но не в коде логики — поэтому
    // проверяем не сам токен, а отсутствие чтения `materialAreas`
    // и отсутствие сравнений `=== 'AREA_M2_BY_SIZE'`.
    expect(actions).not.toMatch(/pattern\.materialAreas/);
    expect(actions).not.toMatch(/=== 'AREA_M2_BY_SIZE'/);
  });

  test('action группирует sizeParameterValues по categoryParameterId с проверкой value > 0', () => {
    // Группа создаётся один раз на categoryParameterId; критерий
    // прохождения — наличие хотя бы одного value > 0 по любому
    // активному размеру. Раньше признак назывался `hasNonZero`; теперь
    // группа копит сами значения (`values`) — из них считается норма,
    // а пустой массив и означает «тянуть нечего».
    expect(actions).toMatch(/linearGroups/);
    expect(actions).toMatch(/values\.length === 0/);
  });

  test('ЧИСЛА ПЕРЕНОСЯТСЯ: шаблон строки несёт норму (иначе в заказ уедет «1»)', () => {
    // Раньше pull приносил только структуру, а норму ставил заглушкой
    // `qtyPerUnit: '1'` — эта единица доезжала до заказа, где менеджер
    // видел «норму 1» при том, что закупка считалась по номенклатуре.
    expect(actions).toMatch(/qtyPerUnit:\s*string \| null/);
    expect(actions).toMatch(/qtyPerUnit:\s*String\(numeric\)/);
    // Погонные метры: в шаблон едет среднее по заполненным размерам.
    expect(actions).toMatch(/qtyPerUnit:\s*String\(Math\.round\(avg/);
    // Форма больше не ставит жёсткую единицу, а читает норму источника.
    expect(src).not.toMatch(/qtyPerUnit:\s*'1',/);
    expect(src).toMatch(/line\.qtyPerUnit/);
  });

  test('action возвращает шаблон с roleKey / labelSnapshot / unit / sourceType / sourceId', () => {
    // Контракт PulledMaterialLineTemplate (см. ТЗ §2 «Тип template line»).
    expect(actions).toMatch(/PulledMaterialLineTemplate/);
    expect(actions).toMatch(/roleKey:\s*norm\.roleKey/);
    expect(actions).toMatch(/labelSnapshot:\s*norm\.labelSnapshot/);
    expect(actions).toMatch(/sourceType:\s*'PARAMETER_NORM'/);
    expect(actions).toMatch(/sourceType:\s*'SIZE_PARAMETER_VALUE'/);
  });

  test('обе RSC-страницы (new и [id]) подгружают номенклатуры и пробрасывают в форму', () => {
    const newPage = read(NEW_PAGE);
    const detailPage = read(DETAIL_PAGE);
    expect(newPage).toMatch(/listPatterns/);
    expect(newPage).toMatch(/patternItems=\{patternItems\}/);
    expect(detailPage).toMatch(/listPatterns/);
    expect(detailPage).toMatch(/patternItems=\{patternItems\}/);
    // Старая загрузка категорий больше не нужна на этих страницах.
    expect(newPage).not.toMatch(/listPatternCategories/);
    expect(detailPage).not.toMatch(/listPatternCategories/);
  });

  test('UI содержит подсказку рядом с кнопкой про оба источника (нормы фурнитуры + погонные метры)', () => {
    // ТЗ §4: «Подтягивает из выбранной номенклатуры заполненные нормы
    // фурнитуры и заполненные параметры погонных метров. Пустые
    // параметры не добавляются.»
    expect(src).toMatch(
      /заполненные нормы фурнитуры и заполненные параметры погонных метров/,
    );
    expect(src).toMatch(/data-testid="tech-card-pull-hint"/);
  });

  test('UI показывает сообщение, если в номенклатуре нет норм/погонных метров', () => {
    // ТЗ §4: «В номенклатуре нет заполненных норм или погонных метров.
    // Нечего подтягивать.»
    expect(src).toMatch(
      /нет заполненных норм или погонных метров/,
    );
    // Старое сообщение «нет заполненных норм на изделие» удалено —
    // оно покрывало только источник A и вводило в заблуждение, когда
    // у номенклатуры пустые погонные метры.
    expect(src).not.toMatch(/нет заполненных норм на изделие/);
  });

  test('UI summary содержит «Добавлено строк» / «Обновлено строк» / «Пропущено дублей»', () => {
    // ТЗ §4: формат сообщения после успешного подтягивания.
    expect(src).toMatch(/Добавлено строк:/);
    expect(src).toMatch(/Обновлено строк:/);
    expect(src).toMatch(/Пропущено дублей:/);
  });

  test('PACKAGING подтянутая строка получает colorRule = ORDER_SELECTED_COLOR, тканевые — ORDER_COLOR', () => {
    // Безопасные дефолты по ролям (см. ТЗ §1 «Источник A» —
    // PACKAGING / ORDER_SELECTED_COLOR; «Источник B» — ORDER_COLOR
    // или существующий safe default для тканевых ролей).
    // Реализация — тернарник `isPackaging ? '...' : '...'`, поэтому
    // оба литерала ищем независимо.
    expect(src).toMatch(/'ORDER_SELECTED_COLOR'/);
    expect(src).toMatch(/'ORDER_COLOR'/);
    expect(src).toMatch(/isPackaging[\s\S]{0,80}'ORDER_SELECTED_COLOR'/);
  });

  test('UI «Подтянуть» НЕ возвращает слово «Упаковка» и не вводит roleKey HARDWARE', () => {
    // ТЗ §«Не делать»: PACKAGING в UI = «Фурнитура»; HARDWARE как
    // отдельный roleKey не вводим. В doc-комментариях упоминание
    // допустимо («HARDWARE как отдельный roleKey не вводим»), но в
    // самом коде/литералах его быть не должно.
    expect(src).not.toMatch(/Упаковка/);
    // Никаких литералов 'HARDWARE' / "HARDWARE" — только в комментах.
    expect(src).not.toMatch(/'HARDWARE'/);
    expect(src).not.toMatch(/"HARDWARE"/);
  });
});

// ---------------------------------------------------------------------------
// 4c. Фурнитура (PACKAGING): доп. поля в строке материала (этап §3)
// ---------------------------------------------------------------------------

describe('tech-card UI — Фурнитура (PACKAGING)', () => {
  const src = read(FORM);

  test('доп. поля показываются только при materialRole === PACKAGING', () => {
    expect(src).toMatch(/isHardware\s*=\s*row\.materialRole === 'PACKAGING'/);
    expect(src).toMatch(/\{isHardware \?/);
  });

  test('label «Размер / характеристика» присутствует', () => {
    expect(src).toMatch(/Размер \/ характеристика/);
  });

  test('label «Материал» присутствует (для фурнитуры)', () => {
    expect(src).toMatch(/<label[^>]*>\s*Материал\s*<\/label>/);
  });

  test('hidden inputs hardwareSizeText/hardwareMaterialText присутствуют для не-PACKAGING', () => {
    // Чтобы при переключении роли значения не пропадали из state-а.
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[hardwareSizeText\]`\}/,
    );
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[hardwareMaterialText\]`\}/,
    );
  });

  test('для PACKAGING поля «Плотность» и «Ширина рулона» скрыты (см. ТЗ §7)', () => {
    // Видимые input-ы плотности/ширины должны быть только в ветке
    // НЕ-PACKAGING. В ветке PACKAGING остаются только hidden inputs
    // с пустым value (backend всё равно зачистит densityGsm /
    // plannedWidthCm в null).
    const idx = src.indexOf('isHardware ? (');
    expect(idx).toBeGreaterThan(-1);
    // В блоке isHardware ? (...) в первой ветке (PACKAGING) не
    // должно быть видимых label «Плотность, г/м²» или «Ширина рулона, см».
    // Найдём конец ветки PACKAGING — это `) : (` после первого `?`.
    // Простое правило: кода есть hidden-инпут [densityGsm] с value=""
    // и hidden-инпут [plannedWidthCm] с value="".
    expect(src).toMatch(
      /<input[\s\S]{0,120}name=\{`material\[\$\{row\.key\}\]\[densityGsm\]`\}[\s\S]{0,60}value=""/,
    );
    expect(src).toMatch(
      /<input[\s\S]{0,120}name=\{`material\[\$\{row\.key\}\]\[plannedWidthCm\]`\}[\s\S]{0,60}value=""/,
    );
  });

  test('для PACKAGING отображается select правил цвета и кнопка изображения', () => {
    // ORDER_SELECTED_COLOR — безопасный дефолт при подтягивании из
    // номенклатуры (см. ТЗ §10). С появлением второго источника
    // (LINEAR_M_BY_SIZE) дефолт стал тернарным `isPackaging
    // ? 'ORDER_SELECTED_COLOR' : 'ORDER_COLOR'`, поэтому проверяем
    // оба литерала независимо.
    expect(src).toMatch(/'ORDER_SELECTED_COLOR'/);
    expect(src).toMatch(/'ORDER_COLOR'/);
  });
});

// ---------------------------------------------------------------------------
// 4c-bis. Backend: для PACKAGING зачищаем densityGsm / plannedWidthCm
// ---------------------------------------------------------------------------

describe('tech-cards backend — densityGsm/plannedWidthCm зачищены для PACKAGING', () => {
  const SERVICE = 'apps/api/src/modules/tech-cards/tech-cards.service.ts';
  const src = read(SERVICE);

  test('materialLineCreateData выставляет densityGsm/plannedWidthCm в null для PACKAGING', () => {
    // ТЗ §7: «При сохранении PACKAGING строки densityGsm = null,
    // plannedWidthCm = null. Иначе старые значения могут случайно
    // остаться в БД». Проверяем по тексту реализации, чтобы не
    // зависеть от рантайма.
    expect(src).toMatch(/isHardwareRole \? null : line\.densityGsm/);
    expect(src).toMatch(/isHardwareRole\s*\n?\s*\?\s*null\s*\n?\s*:\s*line\.plannedWidthCm/);
  });

  test('uploadMaterialImage не меняет другие поля строки', () => {
    // ТЗ §5 «не меняет другие поля строки». Ищем только нужные
    // ключи в data-объекте update().
    expect(src).toMatch(/uploadMaterialImage\(/);
    expect(src).toMatch(/materialImageUrl:\s*saved\.publicUrl/);
    expect(src).toMatch(/materialImageOriginalFileName:\s*saved\.originalFileName/);
  });
});

// ---------------------------------------------------------------------------
// 4c-ter. Backend: upload-эндпоинт изображения строки материала
// ---------------------------------------------------------------------------

describe('tech-cards backend — image upload endpoint', () => {
  const CONTROLLER = 'apps/api/src/modules/tech-cards/tech-cards.controller.ts';
  const STORAGE = 'apps/api/src/modules/tech-cards/tech-cards-storage.service.ts';

  test('контроллер регистрирует POST /:id/material-lines/:lineId/image', () => {
    expect(exists(CONTROLLER)).toBe(true);
    const src = read(CONTROLLER);
    expect(src).toMatch(/@Post\(':id\/material-lines\/:lineId\/image'\)/);
    expect(src).toMatch(/uploadMaterialLineImage\(/);
    expect(src).toMatch(/FileInterceptor\('file'/);
  });

  test('storage-сервис принимает только JPG/JPEG/PNG и проверяет лимит размера', () => {
    expect(exists(STORAGE)).toBe(true);
    const src = read(STORAGE);
    expect(src).toMatch(/TECH_CARD_LINE_IMAGE_EXTENSIONS/);
    expect(src).toMatch(/TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES/);
    expect(src).toMatch(/saveMaterialImage\(/);
    // posix.join разбит на multi-line для читаемости в реализации
    // — ищем `'tech-cards'` как первый аргумент в близком соседстве.
    expect(src).toMatch(/posix\.join[\s\S]{0,40}'tech-cards'/);
  });

  test('shared экспортирует whitelist расширений и лимит размера', () => {
    const sharedSrc = read(SHARED);
    expect(sharedSrc).toMatch(
      /TECH_CARD_LINE_IMAGE_EXTENSIONS\s*=\s*\['jpg',\s*'jpeg',\s*'png'\]/,
    );
    expect(sharedSrc).toMatch(/TECH_CARD_LINE_IMAGE_MAX_SIZE_BYTES/);
  });
});

// ---------------------------------------------------------------------------
// 4d. Изображение материала (этап §5, §9)
//
// ВАЖНО (см. ТЗ §9, §15): URL руками вводить нельзя; основной upload
// UX — file input JPG/PNG. Для несохранённой строки показываем
// disabled-кнопку и подсказку «Сохраните техкарту, чтобы загрузить».
// ---------------------------------------------------------------------------

describe('tech-card UI — Изображение материала (file upload JPG/PNG)', () => {
  const src = read(FORM);

  test('label «Изображение материала» присутствует', () => {
    expect(src).toMatch(/<label[^>]*>\s*Изображение материала\s*<\/label>/);
  });

  test('текстовое URL-поле materialImageUrl уехало в hidden (его больше не редактируют)', () => {
    // hidden input ради сохранения текущего URL при submit. Видимого
    // <input type="url"> с этим именем быть не должно.
    expect(src).toMatch(
      /<input\s+type="hidden"\s+name=\{`material\[\$\{row\.key\}\]\[materialImageUrl\]`\}/,
    );
    // Видимый URL-input удалён — UX через файл.
    expect(src).not.toMatch(
      /<input[^>]*type="url"[^>]*name=\{`material\[\$\{row\.key\}\]\[materialImageUrl\]`/,
    );
  });

  test('форма содержит file input с accept JPG/PNG', () => {
    expect(src).toMatch(/MaterialImageUploader/);
    expect(src).toMatch(/accept="\.jpg,\.jpeg,\.png,image\/jpeg,image\/png"/);
    expect(src).toMatch(/data-testid="material-image-file-input"/);
  });

  test('для новой несохранённой строки показывается подсказка', () => {
    expect(src).toMatch(/Сохраните техкарту, чтобы загрузить изображение/);
    expect(src).toMatch(/data-testid="material-image-upload-disabled"/);
  });

  test('upload идёт через server action uploadMaterialImageAction (по lineId)', () => {
    expect(src).toMatch(/uploadMaterialImageAction/);
    expect(src).toMatch(/uploadMaterialImageAction\.bind/);
  });

  test('форма передаёт techCardId / lineId в MaterialRowCard', () => {
    expect(src).toMatch(/techCardId=\{techCardId\}/);
    expect(src).toMatch(/existingLineId/);
  });

  test('превью отрисовывается, если materialImageUrl уже есть', () => {
    expect(src).toMatch(/превью появится после загрузки JPG\/PNG/);
  });
});

// ---------------------------------------------------------------------------
// 4e. Color rule «Указать в заказе» (этап §4)
// ---------------------------------------------------------------------------

describe('tech-card UI — color rule «Указать в заказе»', () => {
  const sharedSrc = read(SHARED);
  const formSrc = read(FORM);

  test('shared schema содержит ORDER_SELECTED_COLOR', () => {
    expect(sharedSrc).toMatch(/'ORDER_SELECTED_COLOR'/);
    expect(sharedSrc).toMatch(/ORDER_SELECTED_COLOR:\s*'Указать в заказе'/);
  });

  test('select правил цвета рендерит все TECH_CARD_MATERIAL_COLOR_RULES', () => {
    expect(formSrc).toMatch(/TECH_CARD_MATERIAL_COLOR_RULES\.map/);
  });
});

// ---------------------------------------------------------------------------
// 5. Server actions — fallback для legacy полей
// ---------------------------------------------------------------------------

describe('tech-card actions — fallback для legacy полей', () => {
  const src = read(ACTIONS);

  test('action импортирует getTechCardMaterialRoleLabel для генерации name', () => {
    // Этап «Доработка контракта» (см. ТЗ §1): label-функция знает
    // и whitelist категорий (`PATTERN_CATEGORY_PARAMETER_GROUPS`),
    // и legacy roleKey-и; для PACKAGING возвращает «Фурнитура»,
    // не «Упаковка».
    expect(src).toMatch(/getTechCardMaterialRoleLabel/);
  });

  test('fallback name берётся из fabricType или label роли', () => {
    expect(src).toMatch(/function fallbackMaterialName\b/);
    expect(src).toMatch(/opts\.fabricType/);
    expect(src).toMatch(/getTechCardMaterialRoleLabel\(/);
    expect(src).toMatch(/'Материал'/);
  });

  test('fallback unit = «кг»', () => {
    expect(src).toMatch(/UNIT_FALLBACK\s*=\s*'кг'/);
  });

  test('fallback qtyPerUnit = «1» (положительное значение для shared schema)', () => {
    expect(src).toMatch(/QTY_PER_UNIT_FALLBACK\s*=\s*'1'/);
  });

  test('buildMaterialLines пропускает строки без contents', () => {
    expect(src).toMatch(/hasAnyContent/);
    expect(src).toMatch(/if \(!hasAnyContent\) return null/);
  });

  test('buildMaterialLines применяет fallback к пустым name/unit/qty', () => {
    expect(src).toMatch(
      /rawName\.length > 0\s*\?\s*rawName\s*:\s*fallbackMaterialName/,
    );
    expect(src).toMatch(
      /rawUnit\.length > 0 \? rawUnit : UNIT_FALLBACK/,
    );
    expect(src).toMatch(
      /rawQty\.length > 0 && rawQty !== '0' \? rawQty : QTY_PER_UNIT_FALLBACK/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Outsource block: legacy read-only, без кнопки «Добавить»
// ---------------------------------------------------------------------------

describe('tech-card UI — legacy блок «Внешние потребности»', () => {
  const src = read(FORM);

  test('заголовок секции — «Внешние потребности (legacy)»', () => {
    expect(src).toMatch(/Внешние потребности \(legacy\)/);
  });

  test('секция рендерится только при наличии outsource-строк', () => {
    expect(src).toMatch(/\{outsource\.length > 0 && \(/);
  });

  test('подсказка legacy-блока присутствует', () => {
    expect(src).toMatch(
      /Старые внешние услуги сохранены как legacy\. Новые нанесения задаются в заказе покупателя\./,
    );
  });

  test('кнопка «Добавить» для outsource убрана из секции', () => {
    // Проверяем, что внутри секции outsource нет кнопки добавления
    // (anchor — `Внешние потребности (legacy)`). Может быть кнопка
    // «Добавить» только в секции «Материальные требования» выше.
    const idx = src.indexOf('admin-tech-card-outsource-legacy');
    expect(idx).toBeGreaterThan(-1);
    // Между началом этой секции и concluding `</section>` не должно
    // быть `setOutsource((p) => [...p, emptyOutsourceRow()])`.
    const sectionEnd = src.indexOf('</section>', idx);
    expect(sectionEnd).toBeGreaterThan(idx);
    const block = src.slice(idx, sectionEnd);
    expect(block).not.toMatch(/setOutsource\(\(p\) => \[\.\.\.p, emptyOutsourceRow\(\)\]\)/);
  });

  test('emptyOutsourceRow больше не вызывается из формы (нет создания новых строк)', () => {
    // Helper вообще не нужен — но если он остался в файле, проверим,
    // что он не используется.
    const callMatches = src.match(/emptyOutsourceRow\(\)/g) ?? [];
    expect(callMatches.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Prisma не менялась: legacy поля и `TechCardOutsourceLine` живы
// ---------------------------------------------------------------------------

describe('tech-card — Prisma legacy сохранён (refactor не трогал БД)', () => {
  const schema = read(PRISMA);

  test('TechCardMaterialLine содержит name / unit / qtyPerUnit / note', () => {
    const idx = schema.indexOf('model TechCardMaterialLine');
    expect(idx).toBeGreaterThan(-1);
    const end = schema.indexOf('\n}', idx);
    expect(end).toBeGreaterThan(idx);
    const block = schema.slice(idx, end);
    expect(block).toMatch(/\bname\s+String\b/);
    expect(block).toMatch(/\bunit\s+String\b/);
    expect(block).toMatch(/\bqtyPerUnit\s+Decimal\b/);
    // `note` остаётся опциональным.
    expect(block).toMatch(/\bnote\s+String\?/);
  });

  test('TechCardOutsourceLine не удалён', () => {
    expect(schema).toMatch(/model TechCardOutsourceLine\b/);
  });

  test('TechCardMaterialLine содержит hardwareSizeText / hardwareMaterialText / materialImageUrl', () => {
    const idx = schema.indexOf('model TechCardMaterialLine');
    const end = schema.indexOf('\n}', idx);
    const block = schema.slice(idx, end);
    // Все additive-поля nullable (String?), без default.
    expect(block).toMatch(/\bhardwareSizeText\s+String\?/);
    expect(block).toMatch(/\bhardwareMaterialText\s+String\?/);
    expect(block).toMatch(/\bmaterialImageUrl\s+String\?/);
    expect(block).toMatch(/\bmaterialImageOriginalFileName\s+String\?/);
  });

  test('OrderMaterialRequirement содержит requiresColorSelection / selectedColorText', () => {
    const idx = schema.indexOf('model OrderMaterialRequirement');
    const end = schema.indexOf('\n}', idx);
    const block = schema.slice(idx, end);
    // Boolean default false (UNIQUE — не используем) + nullable string.
    expect(block).toMatch(/\brequiresColorSelection\s+Boolean\s+@default\(false\)/);
    expect(block).toMatch(/\bselectedColorText\s+String\?/);
    // snapshot-копии новых полей TechCardMaterialLine.
    expect(block).toMatch(/\bhardwareSizeText\s+String\?/);
    expect(block).toMatch(/\bhardwareMaterialText\s+String\?/);
    expect(block).toMatch(/\bmaterialImageUrl\s+String\?/);
    expect(block).toMatch(/\bmaterialImageOriginalFileName\s+String\?/);
  });
});

// ---------------------------------------------------------------------------
// 8. Shared schema не менялась: name/unit/qtyPerUnit — required
// ---------------------------------------------------------------------------

describe('tech-card shared schema — name/unit/qtyPerUnit остаются required', () => {
  const src = read(SHARED);

  test('TechCardMaterialLineInputSchema содержит name/unit/qtyPerUnit', () => {
    expect(src).toMatch(/name:\s*LineNameField/);
    expect(src).toMatch(/unit:\s*LineUnitRequiredField/);
    expect(src).toMatch(/qtyPerUnit:\s*makeQtyField\(\{ required: true \}\)/);
    expect(src).toMatch(/note:\s*LineNoteField/);
  });

  test('TECH_CARD_MATERIAL_COLOR_RULES содержит ORDER_SELECTED_COLOR', () => {
    expect(src).toMatch(/TECH_CARD_MATERIAL_COLOR_RULES/);
    expect(src).toMatch(/'ORDER_COLOR'/);
    expect(src).toMatch(/'FIXED_COLOR'/);
    expect(src).toMatch(/'NO_COLOR'/);
    expect(src).toMatch(/'ORDER_SELECTED_COLOR'/);
    expect(src).toMatch(/ORDER_SELECTED_COLOR:\s*'Указать в заказе'/);
  });

  test('TechCardMaterialLineInputSchema содержит hardware* / materialImage*', () => {
    expect(src).toMatch(/hardwareSizeText:\s*HardwareSizeTextField/);
    expect(src).toMatch(/hardwareMaterialText:\s*HardwareMaterialTextField/);
    expect(src).toMatch(/materialImageUrl:\s*MaterialImageUrlField/);
    expect(src).toMatch(
      /materialImageOriginalFileName:\s*MaterialImageOriginalFileNameField/,
    );
  });

  test('TECH_CARD_MATERIAL_ROLE_KEYS — re-export PATTERN_CATEGORY_PARAMETER_GROUPS', () => {
    expect(src).toMatch(/TECH_CARD_MATERIAL_ROLE_KEYS/);
    expect(src).toMatch(/PATTERN_CATEGORY_PARAMETER_GROUPS/);
    expect(src).toMatch(/getTechCardMaterialRoleLabel/);
    expect(src).toMatch(/isKnownTechCardMaterialRoleKey/);
  });
});

describe('orders shared schema — requiresColorSelection / selectedColorText', () => {
  const src = readFileSync(
    path.join(repoRoot, 'packages/shared/src/orders.ts'),
    'utf8',
  );

  test('OrderMaterialRequirementDto содержит requiresColorSelection и selectedColorText', () => {
    expect(src).toMatch(/requiresColorSelection\?:\s*boolean/);
    expect(src).toMatch(/selectedColorText\?:\s*string \| null/);
  });

  test('UpdateOrderMaterialRequirementColorSchema экспортируется', () => {
    expect(src).toMatch(/UpdateOrderMaterialRequirementColorSchema/);
    expect(src).toMatch(/UpdateOrderMaterialRequirementColorDto/);
  });

  test('OrderMaterialRequirementDto содержит hardware* / materialImage*', () => {
    expect(src).toMatch(/hardwareSizeText\?:\s*string \| null/);
    expect(src).toMatch(/hardwareMaterialText\?:\s*string \| null/);
    expect(src).toMatch(/materialImageUrl\?:\s*string \| null/);
    expect(src).toMatch(
      /materialImageOriginalFileName\?:\s*string \| null/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. CSS-классы layout материальных требований
// ---------------------------------------------------------------------------

describe('tech-card UI — CSS классы admin-material-row', () => {
  const css = read(CSS);

  test('CSS определяет .admin-material-row__grid с auto-fit сеткой', () => {
    expect(css).toMatch(/\.admin-material-row__grid\s*\{/);
    expect(css).toMatch(
      /\.admin-material-row__grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(180px,\s*1fr\)\)/,
    );
  });

  test('CSS определяет responsive-обвал на 1 колонку при узком экране', () => {
    expect(css).toMatch(
      /@media \(max-width: 700px\)\s*\{[\s\S]*?\.admin-material-row__grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/,
    );
  });

  test('CSS определяет .admin-material-requirements__hint и legacy-hint', () => {
    expect(css).toMatch(/\.admin-material-requirements__hint\s*\{/);
    expect(css).toMatch(/\.admin-tech-card-outsource-legacy__hint\s*\{/);
  });
});
