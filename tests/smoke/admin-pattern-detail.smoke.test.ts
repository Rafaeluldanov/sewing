/**
 * Smoke-тесты карточки номенклатуры (`/admin/patterns/[id]`) после
 * редизайна «активные размеры».
 *
 * До редизайна страница рендерила всю системную размерную сетку
 * (104, 110, 116, …, XS, S, M, L, XL) и в DXF-блоке, и в «Площадях
 * материалов». Это «простыня» — менеджеру тяжело увидеть, какие
 * размеры реально доведены до production. После редизайна:
 *
 *   - источник истины «активного размера» — `PatternSizeFile` со
 *     `status = 'ACTIVE'` (Prisma не меняли, отдельной модели
 *     `PatternSize` не вводили);
 *   - блок «Размеры номенклатуры» показывает только активные
 *     размеры (счётчик + чипсы) и кнопку «Добавить размер»;
 *   - кнопка «Добавить размер» открывает модалку с select-ом
 *     размера + file input для DXF; в select остаются только
 *     размеры, которых ещё нет среди активных;
 *   - блок «DXF по размерам» показывает только активные размеры
 *     (включая историю архивных версий тех же `sizeId`);
 *   - блок «Площади материалов» рендерит строки **только** по
 *     активным размерам; системная размерная сетка не показывается.
 *
 * Все проверки — source-level: запускать настоящий браузер ради
 * smoke-сценария дорого, а статика покрывает acceptance-чеклист
 * (см. ТЗ «Карточка номенклатуры — активные размеры»). Backend и
 * Prisma в этой итерации не менялись — мы поверх существующего
 * `uploadPatternSizeFile` / `archivePatternSizeFile` /
 * `replacePatternMaterialAreas` поменяли только UX.
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

const PAGE = 'apps/web/app/admin/patterns/[id]/page.tsx';
const MANAGER = 'apps/web/app/admin/patterns/[id]/pattern-sizes-manager.tsx';
const MODAL = 'apps/web/app/admin/patterns/[id]/add-pattern-size-modal.tsx';
const REPLACE_FORM =
  'apps/web/app/admin/patterns/[id]/replace-pattern-size-file-form.tsx';
const AREAS_FORM = 'apps/web/app/admin/patterns/[id]/material-areas-form.tsx';
const ACTIONS = 'apps/web/app/admin/patterns/actions.ts';
const PATTERNS_API = 'apps/web/lib/patterns-api.ts';

// ---------------------------------------------------------------------------
// 1. Файлы менеджера / модалки на месте, страница их подключила
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — менеджер активных размеров: файлы', () => {
  test('страница существует и подключает PatternSizesManager', () => {
    expect(exists(PAGE)).toBe(true);
    const src = read(PAGE);
    expect(src).toMatch(/from '\.\/pattern-sizes-manager'/);
    expect(src).toMatch(/<PatternSizesManager\b/);
    // sizeFiles и materialAreas пробрасываются в менеджер из RSC —
    // активные размеры считаются на клиенте.
    expect(src).toMatch(/sizeFiles=\{pattern\.sizeFiles\}/);
    expect(src).toMatch(/materialAreas=\{pattern\.materialAreas\}/);
    // Системная размерная сетка для select модалки берётся из
    // существующего `/api/sizes` — никаких новых endpoint-ов.
    expect(src).toMatch(/listSizes/);
  });

  test('PatternSizesManager и AddPatternSizeModal — клиентские компоненты', () => {
    expect(exists(MANAGER)).toBe(true);
    expect(exists(MODAL)).toBe(true);
    expect(read(MANAGER).startsWith("'use client'")).toBe(true);
    expect(read(MODAL).startsWith("'use client'")).toBe(true);
  });

  test('страница больше НЕ рендерит старую инлайновую DXF-форму и таблицу всех размеров', () => {
    const src = read(PAGE);
    // Старая «sizes по справочнику» форма удалена — modal в менеджере
    // — единственный путь добавить размер.
    expect(src).not.toMatch(/PatternSizeFileUploadForm/);
    expect(src).not.toMatch(/Загрузить DXF/);
    expect(src).not.toMatch(/PatternMaterialAreasForm/);
    expect(src).not.toMatch(/SizeFilesTable/);
    expect(
      exists('apps/web/app/admin/patterns/[id]/size-file-upload-form.tsx'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Активные размеры считаются из PatternSizeFile (status=ACTIVE)
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — определение активных размеров', () => {
  const src = read(MANAGER);

  test('активный размер = PatternSizeFile со status === ACTIVE', () => {
    expect(src).toMatch(/computeActiveSizes\b/);
    // В цикле фильтруем по статусу 'ACTIVE'. Допускаем оба написания
    // (одинарные и двойные кавычки), но проверяем именно эту строку.
    expect(src).toMatch(/f\.status\s*!==\s*['"]ACTIVE['"]/);
    // Группировка по sizeId, tiebreak по version → createdAt.
    expect(src).toMatch(/map\.get\(f\.sizeId\)/);
    expect(src).toMatch(/f\.version\s*>\s*prev\.version/);
    expect(src).toMatch(/createdAt/);
    // Сортируем по sortOrder справочника `Size`.
    expect(src).toMatch(/a\.size\.sortOrder\s*-\s*b\.size\.sortOrder/);
  });

  test('менеджер передаёт в material-areas-form именно активные размеры', () => {
    // sizes={activeSizes} (не allSizes / не sizesAll). activeSizes —
    // результат computeActiveSizes(sizeFiles).
    expect(src).toMatch(/<PatternMaterialAreasForm[\s\S]*?sizes=\{activeSizes\}/);
    expect(src).not.toMatch(/sizes=\{allSizes\}/);
  });

  test('availableForAdd для модалки = allSizes минус активные размеры', () => {
    expect(src).toMatch(/availableForAdd/);
    expect(src).toMatch(/!activeSizeIds\.has\(s\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 3. Блок «Размеры номенклатуры» + кнопка «Добавить размер»
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — блок «Размеры номенклатуры»', () => {
  const src = read(MANAGER);

  test('заголовки блоков и подсказки на странице', () => {
    expect(src).toMatch(/Размеры номенклатуры/);
    expect(src).toMatch(/DXF по размерам/);
    expect(src).toMatch(/Площади материалов/);
    // Подсказка про м² — по ТЗ.
    expect(src).toMatch(/Площади указываются в м²/);
    // Счётчик активных размеров.
    expect(src).toMatch(/Активных размеров:/);
  });

  test('кнопка «Добавить размер» открывает модалку (aria-haspopup="dialog")', () => {
    expect(src).toMatch(/Добавить размер/);
    expect(src).toMatch(/aria-haspopup="dialog"/);
    expect(src).toMatch(/onClick=\{openModal\}/);
    // Модалка рендерится, когда modalOpen === true.
    expect(src).toMatch(/modalOpen\s*&&/);
    expect(src).toMatch(/<AddPatternSizeModal\b/);
  });

  test('empty-state, если активных размеров нет', () => {
    // ТЗ-копи: «Размеры не добавлены» / «Добавьте размер и загрузите
    // DXF, чтобы использовать его в заказах.»
    expect(src).toMatch(/Размеры не добавлены/);
    expect(src).toMatch(/Добавьте размер и загрузите DXF/);
    // Empty-state для «Площади материалов».
    expect(src).toMatch(/Сначала добавьте размеры и загрузите DXF/);
    // Empty-state для «DXF по размерам».
    expect(src).toMatch(/DXF по размерам ещё не загружены/);
  });

  test('активные размеры рендерятся как чипсы (admin-size-plan__chip)', () => {
    expect(src).toMatch(/admin-size-plan__chips/);
    expect(src).toMatch(/admin-size-plan__chip\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Модалка «Добавить размер» — контракт UI и server action
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — модалка «Добавить размер»', () => {
  const src = read(MODAL);

  test('role="dialog" + aria-modal="true"', () => {
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
  });

  test('select показывает только размеры, которых ещё нет в активных', () => {
    // Ключевая проверка: select мапится по `availableSizes` (которые
    // прокидывает менеджер уже отфильтрованными). Никаких полных
    // sizesAll / 104/110/116 в модалке быть не должно. Допускаем
    // переименование локальной переменной (например, `effectiveSizes`),
    // если она строится из `availableSizes` (UX-bridge с CreateSizeModal,
    // оптимистичное добавление только что созданного размера).
    expect(src).toMatch(/(availableSizes|effectiveSizes)\.map\(/);
    // Если используется `effectiveSizes` — он должен быть собран
    // из `availableSizes` (опционально + initialSelected), а не
    // придумываться отдельно.
    if (/effectiveSizes/.test(src)) {
      expect(src).toMatch(/effectiveSizes[\s\S]{0,200}availableSizes/);
    }
    expect(src).toMatch(/<select[\s\S]*?name="sizeId"/);
    // Файл DXF обязателен.
    expect(src).toMatch(/type="file"/);
    expect(src).toMatch(/required/);
    // Принимаем только .dxf — accept собирается из
    // PATTERN_DXF_EXTENSIONS, но ключевой контракт расширения
    // совпадает с константой shared.
    expect(src).toMatch(/PATTERN_DXF_EXTENSIONS/);
  });

  test('копи-кнопок: «Отмена» и «Добавить»', () => {
    expect(src).toMatch(/Отмена/);
    // SubmitButton рендерит «Добавить» внутри <button>; контракт —
    // кнопка с этим текстом точно есть в модалке.
    expect(src).toMatch(/['"]Добавить['"]|>Добавить</);
    // Двойная страховка: сабмит с типом submit (один на форму).
    expect(src).toMatch(/type="submit"/);
  });

  test('пустое состояние «Все размеры уже добавлены»', () => {
    expect(src).toMatch(/Все размеры уже добавлены/);
    // SubmitButton дизейблится, когда добавлять нечего.
    expect(src).toMatch(/disabled=\{allAdded\}/);
  });

  test('используется существующий uploadPatternSizeFileAction (новых endpoints нет)', () => {
    expect(src).toMatch(
      /uploadPatternSizeFileAction\.bind\(null,\s*patternId\)/,
    );
    // Esc / клик по backdrop закрывают модалку.
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/handleBackdropClick/);
    // После успеха модалка закрывается + router.refresh().
    expect(src).toMatch(/state\.ok/);
    expect(src).toMatch(/router\.refresh\(\)/);
    expect(src).toMatch(/onClose\(\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. «Площади материалов» — только activeSizes, никакой полной сетки
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — «Площади материалов» строится по активным размерам', () => {
  const formSrc = read(AREAS_FORM);

  test('строки таблицы — итерация по prop sizes (=activeSizes у родителя)', () => {
    // Форма принимает `sizes: PatternSizeRefDto[]` и итерирует
    // только их. Полная системная сетка sizesAll/listSizes сюда не
    // попадает — это гарантирует менеджер.
    expect(formSrc).toMatch(/sizes\.map\(/);
    expect(formSrc).toMatch(/__sizeIds/);
    // server action ходит ровно по тем sizeId, что прислала форма.
    const actionsSrc = read(ACTIONS);
    expect(actionsSrc).toMatch(/__sizeIds/);
    // Action парсит CSV с sizeId и итерирует **только** по ним —
    // именно это даёт «не сохранять площади по неактивным размерам».
    expect(actionsSrc).toMatch(/sizeIdsCsv\.split\(['"],['"]\)/);
  });

  test('форма не упоминает «весь справочник» / sizesAll / listSizes', () => {
    expect(formSrc).not.toMatch(/sizesAll/);
    expect(formSrc).not.toMatch(/listSizes/);
    // Никаких прямых вшитых «104/110/116/XS/S/M/L/XL» в форме.
    expect(formSrc).not.toMatch(/['"]104['"]/);
    expect(formSrc).not.toMatch(/['"]XS['"]/);
  });

  test('inputs м² с placeholder, кнопка «Сохранить площади»', () => {
    expect(formSrc).toMatch(/placeholder="м²"/);
    expect(formSrc).toMatch(/Сохранить площади/);
  });
});

// ---------------------------------------------------------------------------
// 6. «DXF по размерам» — таблица только по активным размерам
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — «DXF по размерам» по активным размерам', () => {
  const src = read(MANAGER);

  test('таблица DXF фильтруется по activeSizeIds', () => {
    // filesForActiveSizes = sizeFiles.filter(f => activeSizeIds.has(f.sizeId)).
    expect(src).toMatch(/filesForActiveSizes/);
    expect(src).toMatch(/activeSizeIds\.has\(f\.sizeId\)/);
  });

  test('per-row «Заменить» и «Архивировать» подключены', () => {
    expect(exists(REPLACE_FORM)).toBe(true);
    expect(src).toMatch(/<ReplacePatternSizeFileForm\b/);
    expect(src).toMatch(/<ArchivePatternSizeFileForm\b/);
    const replaceSrc = read(REPLACE_FORM);
    // «Заменить» вызывает тот же action, что и модалка, — backend
    // сам поднимет version + 1 для существующего sizeId.
    expect(replaceSrc).toMatch(/uploadPatternSizeFileAction/);
    expect(replaceSrc).toMatch(/Заменить/);
    expect(replaceSrc).toMatch(/accept=\{accept\}/);
  });

  test('таблица содержит обязательные колонки: Размер / Файл / Версия / Загружен / Статус', () => {
    expect(src).toMatch(/header:\s*'Размер'/);
    expect(src).toMatch(/header:\s*'Версия'/);
    expect(src).toMatch(/header:\s*'Файл'/);
    expect(src).toMatch(/header:\s*'Загружен'/);
    expect(src).toMatch(/header:\s*'Статус'/);
  });
});

// ---------------------------------------------------------------------------
// 7. Backend / Prisma не менялись — используем существующие API
// ---------------------------------------------------------------------------

describe('admin/patterns/[id] — Backend / Prisma не менялись', () => {
  test('менеджер ходит только в существующие server actions', () => {
    const managerSrc = read(MANAGER);
    const modalSrc = read(MODAL);
    const replaceSrc = read(REPLACE_FORM);
    // Никаких новых action-имён.
    const allowed = [
      'uploadPatternSizeFileAction',
      'archivePatternSizeFileAction',
      'replacePatternMaterialAreasAction',
      'updatePatternAction',
      'createPatternAction',
      'uploadPatternPreviewAction',
    ];
    // Ловим только идентификаторы вида `<lowercase>...Action(` или
    // `<lowercase>...Action.bind`, то есть реально вызываемые server
    // actions. Это исключает ложные срабатывания на ключи объектов
    // типа `isAction: true` в `AdminTableColumn`.
    const callRe = /\b([a-z][a-zA-Z0-9_]*Action)(?=\s*[(.])/g;
    for (const src of [managerSrc, modalSrc, replaceSrc]) {
      const matches = src.match(callRe) ?? [];
      for (const m of matches) {
        expect(allowed).toContain(m);
      }
    }
  });

  test('patterns-api.ts не получил новых эндпоинтов', () => {
    const src = read(PATTERNS_API);
    // Список «правильных» функций (без новых).
    const expected = [
      'listPatterns',
      'getPattern',
      'createPattern',
      'updatePattern',
      'uploadPatternPreview',
      'uploadPatternSizeFile',
      'archivePatternSizeFile',
      'replacePatternMaterialAreas',
    ];
    for (const fn of expected) {
      expect(src).toMatch(new RegExp(`export function ${fn}\\b`));
    }
    // На всякий случай: в этой итерации не должно появиться
    // отдельного «addPatternSize» / «removePatternSize».
    expect(src).not.toMatch(/export function addPatternSize\b/);
    expect(src).not.toMatch(/export function removePatternSize\b/);
  });

  test('Prisma schema не содержит модели PatternSize (мы её не вводили)', () => {
    const schemaPath = 'prisma/schema.prisma';
    if (!exists(schemaPath)) return; // некоторые сборки не тащат prisma — тогда просто скип
    const src = read(schemaPath);
    expect(src).not.toMatch(/^model PatternSize\s*\{/m);
    // Существующие модели на месте.
    expect(src).toMatch(/model PatternItem\s*\{/);
    expect(src).toMatch(/model PatternSizeFile\s*\{/);
    expect(src).toMatch(/model PatternMaterialArea\s*\{/);
  });
});
