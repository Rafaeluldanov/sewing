/**
 * Smoke-тесты для устранения 500 на странице `/admin/tech-cards/new`
 * (и зеркального `/admin/tech-cards/[id]`).
 *
 * Контекст / причина 500:
 *   - `actions.ts` помечен `'use server'`, а такой модуль обязан
 *     экспортировать ТОЛЬКО async-функции. Если в нём появляется
 *     non-async value (`initialUploadMaterialImageState`) — Next.js
 *     подменяет его на server-reference; импорт со стороны
 *     `tech-card-form.tsx` ломает рендер `useFormState(action, ИНИТ)`
 *     и страница падает в production render.
 *   - В RSC-странице `listPatterns({ status: 'ACTIVE' })` может
 *     вернуть пустой массив, не-массив или бросить — но страница
 *     обязана открыться при любом из этих исходов.
 *   - В `TechCardForm` нельзя позволять `.map`/`.length` на
 *     potentially undefined `patternItems`/`materialLines`/
 *     `outsourceLines`.
 *   - Кнопка «Подтянуть из номенклатуры» обязана быть disabled или
 *     отрисовать понятное сообщение, если выбора номенклатуры нет
 *     (или активных номенклатур нет вообще).
 *   - Server action `pullMaterialLinesFromPatternAction` нельзя
 *     вызывать с пустым id.
 *   - Для несохранённой строки материала upload изображения
 *     запрещён, должна показываться подсказка
 *     «Сохраните техкарту, чтобы загрузить изображение».
 *
 * Все тесты — source-level (как остальные smoke-тесты в этой папке):
 * читаем файлы и assert-им паттерны, чтобы регрессия была заметна
 * сразу, без необходимости поднимать full Next.js dev server.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

const NEW_PAGE = 'apps/web/app/admin/tech-cards/new/page.tsx';
const DETAIL_PAGE = 'apps/web/app/admin/tech-cards/[id]/page.tsx';
const FORM = 'apps/web/app/admin/tech-cards/tech-card-form.tsx';
const ACTIONS = 'apps/web/app/admin/tech-cards/actions.ts';
const FORM_STATE = 'apps/web/app/admin/tech-cards/form-state.ts';

// ---------------------------------------------------------------------------
// 1. `'use server'` файл экспортирует только async-функции
// ---------------------------------------------------------------------------

describe('tech-cards actions — `use server` экспорт-гигиена', () => {
  const actionsSrc = read(ACTIONS);

  test('файл начинается с директивы `use server`', () => {
    // Без этого ниже-расположенные actions просто не были бы
    // server actions; держим инвариант явно.
    expect(actionsSrc.trim().startsWith("'use server';")).toBe(true);
  });

  test('файл НЕ экспортирует non-async value `initialUploadMaterialImageState`', () => {
    // Это была причина 500 на /admin/tech-cards/new — экспорт
    // обычного объекта из `'use server'` модуля заменялся на
    // server-reference, и `useFormState` крашился ещё на SSR.
    expect(actionsSrc).not.toMatch(/export\s+\{\s*initialUploadMaterialImageState/);
    expect(actionsSrc).not.toMatch(
      /export\s+const\s+initialUploadMaterialImageState/,
    );
  });

  test('файл НЕ экспортирует non-async value `initialTechCardFormState`', () => {
    // То же самое для соседнего state — он живёт в `form-state.ts`.
    expect(actionsSrc).not.toMatch(/export\s+\{\s*initialTechCardFormState/);
    expect(actionsSrc).not.toMatch(/export\s+const\s+initialTechCardFormState/);
  });

  test('все верхне-уровневые export-ы — только async-функции (или type/interface)', () => {
    // Простая проверка: каждая строка `export ...` в начале строки
    // обязана быть либо `export async function`, либо
    // `export interface`, либо `export type`. Регрессия на `export const`
    // / `export { name }` сразу всплывёт.
    const offenders = actionsSrc
      .split('\n')
      .filter((line) => /^export\s/.test(line))
      .filter(
        (line) =>
          !/^export\s+async\s+function\b/.test(line) &&
          !/^export\s+interface\b/.test(line) &&
          !/^export\s+type\b/.test(line),
      );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. State-объекты живут в `form-state.ts` (не-server файл)
// ---------------------------------------------------------------------------

describe('tech-cards form-state — single source of truth для useFormState', () => {
  const stateSrc = read(FORM_STATE);

  test('файл НЕ помечен `use server`', () => {
    // Это обычный module — можно экспортировать что угодно.
    expect(stateSrc.trim().startsWith("'use server'")).toBe(false);
  });

  test('экспортирует `initialTechCardFormState` и тип `TechCardFormState`', () => {
    expect(stateSrc).toMatch(
      /export\s+const\s+initialTechCardFormState:\s*TechCardFormState\s*=\s*\{\}/,
    );
    expect(stateSrc).toMatch(/export\s+interface\s+TechCardFormState\b/);
  });

  test('экспортирует `initialUploadMaterialImageState` и тип `UploadMaterialImageState`', () => {
    expect(stateSrc).toMatch(
      /export\s+const\s+initialUploadMaterialImageState:\s*UploadMaterialImageState\s*=\s*\{\}/,
    );
    expect(stateSrc).toMatch(/export\s+interface\s+UploadMaterialImageState\b/);
  });
});

// ---------------------------------------------------------------------------
// 3. Форма импортирует state из `form-state.ts`, а не из `actions.ts`
// ---------------------------------------------------------------------------

describe('tech-card-form — импорт state-объектов из правильного места', () => {
  const formSrc = read(FORM);

  /**
   * В реальном файле import-блоки выглядят так:
   *
   *   import {
   *     initialTechCardFormState,
   *     initialUploadMaterialImageState,
   *     type TechCardFormState,
   *     type UploadMaterialImageState,
   *   } from './form-state';
   *
   * — то есть имена идут ДО `from`. Регексп ниже ловит ровно такой
   * import-блок: `import { ... <name> ... } from '<source>'`.
   */
  function importsFromMatcher(name: string, source: string): RegExp {
    const escSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${escSource}['"]`,
    );
  }

  test('initialUploadMaterialImageState импортируется из `./form-state`', () => {
    expect(formSrc).toMatch(
      importsFromMatcher('initialUploadMaterialImageState', './form-state'),
    );
    // И обратное: НЕ из actions.
    expect(formSrc).not.toMatch(
      importsFromMatcher('initialUploadMaterialImageState', './actions'),
    );
  });

  test('UploadMaterialImageState импортируется как type из `./form-state`', () => {
    expect(formSrc).toMatch(
      importsFromMatcher('UploadMaterialImageState', './form-state'),
    );
    expect(formSrc).not.toMatch(
      importsFromMatcher('UploadMaterialImageState', './actions'),
    );
  });

  test('initialTechCardFormState по-прежнему импортируется из form-state', () => {
    expect(formSrc).toMatch(
      importsFromMatcher('initialTechCardFormState', './form-state'),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. RSC-страницы устойчивы к пустому/невалидному ответу `listPatterns`
// ---------------------------------------------------------------------------

describe('/admin/tech-cards/new — устойчивость к пустой/битой номенклатуре', () => {
  const newSrc = read(NEW_PAGE);

  test('listPatterns обёрнут в try/catch', () => {
    expect(newSrc).toMatch(/try\s*\{[\s\S]*?listPatterns\(/);
    expect(newSrc).toMatch(/catch[\s\S]*?patternItems\s*=\s*\[\]/);
  });

  test('результат listPatterns проверяется через Array.isArray (защита от не-массива)', () => {
    expect(newSrc).toMatch(/Array\.isArray\(list\)/);
  });

  test('patternItems инициализирован пустым массивом до try/catch', () => {
    // Гарантия, что какой бы ни был результат — переменная всегда
    // существует и она массив.
    expect(newSrc).toMatch(
      /let\s+patternItems:\s*\{\s*id:\s*string;\s*name:\s*string;\s*article:\s*string\s*\}\[\]\s*=\s*\[\]/,
    );
  });

  test('в client component передаются только plain (id/name/article строками)', () => {
    // Никаких Date/Decimal/BigInt/полного DTO — только три строковых
    // поля (см. ТЗ §«Если page.tsx передаёт данные в client component»).
    expect(newSrc).toMatch(/id:\s*String\(p\?\.id\s*\?\?\s*''\)/);
    expect(newSrc).toMatch(/name:\s*String\(p\?\.name\s*\?\?\s*''\)/);
    expect(newSrc).toMatch(/article:\s*String\(p\?\.article\s*\?\?\s*''\)/);
  });

  test('TechCardForm получает patternItems гарантированным массивом', () => {
    expect(newSrc).toMatch(/<TechCardForm[^>]*patternItems=\{patternItems\}/s);
  });
});

describe('/admin/tech-cards/[id] — та же устойчивость', () => {
  const detailSrc = read(DETAIL_PAGE);

  test('listPatterns обёрнут в try/catch + Array.isArray', () => {
    expect(detailSrc).toMatch(/try\s*\{[\s\S]*?listPatterns\(/);
    expect(detailSrc).toMatch(/Array\.isArray\(list\)/);
    expect(detailSrc).toMatch(/catch[\s\S]*?patternItems\s*=\s*\[\]/);
  });

  test('plain-поля передаются строками', () => {
    expect(detailSrc).toMatch(/id:\s*String\(p\?\.id\s*\?\?\s*''\)/);
    expect(detailSrc).toMatch(/name:\s*String\(p\?\.name\s*\?\?\s*''\)/);
    expect(detailSrc).toMatch(/article:\s*String\(p\?\.article\s*\?\?\s*''\)/);
  });
});

// ---------------------------------------------------------------------------
// 5. TechCardForm — никаких .map/.length по undefined
// ---------------------------------------------------------------------------

describe('TechCardForm — defensive против undefined в коллекциях', () => {
  const formSrc = read(FORM);

  test('patternItems нормализуется через Array.isArray (safePatternItems)', () => {
    expect(formSrc).toMatch(
      /const\s+safePatternItems:\s*PatternItemOption\[\]\s*=\s*Array\.isArray\(patternItems\)\s*\?\s*patternItems\s*:\s*\[\]/,
    );
  });

  test('JSX использует safePatternItems.map / safePatternItems.length, а не сырой patternItems', () => {
    // Регрессия `patternItems.map(...)` без нормализации сразу
    // упадёт в render, если prop окажется undefined.
    expect(formSrc).toMatch(/safePatternItems\.length\s*>\s*0/);
    expect(formSrc).toMatch(/safePatternItems\.map\(/);
    expect(formSrc).not.toMatch(/\bpatternItems\.length\b/);
    expect(formSrc).not.toMatch(/\bpatternItems\.map\(/);
  });

  test('template.materialLines защищён через Array.isArray в инициализации useState', () => {
    expect(formSrc).toMatch(
      /Array\.isArray\(template\.materialLines\)\s*\?\s*template\.materialLines\s*:\s*\[\]/,
    );
  });

  test('template.outsourceLines защищён через Array.isArray в инициализации useState', () => {
    expect(formSrc).toMatch(
      /Array\.isArray\(template\.outsourceLines\)\s*\?\s*template\.outsourceLines\s*:\s*\[\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Кнопка «Подтянуть из номенклатуры» — disabled/safe states
// ---------------------------------------------------------------------------

describe('TechCardForm — «Подтянуть из номенклатуры» безопасность', () => {
  const formSrc = read(FORM);
  const actionsSrc = read(ACTIONS);

  test('кнопка disabled, когда выбор номенклатуры пуст', () => {
    // Дополнительно к isPulling — обязательный гард на пустой id.
    expect(formSrc).toMatch(
      /disabled=\{isPulling\s*\|\|\s*pullPatternId\.trim\(\)\s*===\s*''\}/,
    );
  });

  test('handlePullFromNomenclature выходит, если pullPatternId пустой (даже после trim)', () => {
    expect(formSrc).toMatch(
      /const\s+trimmedId\s*=\s*pullPatternId\.trim\(\);\s*\n\s*if\s*\(\s*trimmedId\s*===\s*''\s*\)\s*\{[\s\S]*?setPullError\(\s*'Выберите номенклатуру'\s*\);\s*\n\s*return;/,
    );
  });

  test('server action вызывается ТОЛЬКО с trimmed (непустым) id', () => {
    expect(formSrc).toMatch(/pullMaterialLinesFromPatternAction\(trimmedId\)/);
    expect(formSrc).not.toMatch(
      /pullMaterialLinesFromPatternAction\(pullPatternId\)/,
    );
  });

  test('server action сам валидирует пустой id и не падает', () => {
    expect(actionsSrc).toMatch(
      /const\s+id\s*=\s*String\(patternItemId\s*\?\?\s*''\)\.trim\(\);[\s\S]*?if\s*\(\s*id\.length\s*===\s*0\s*\)/,
    );
  });

  test('если активных номенклатур нет — рендерится понятный текст вместо кнопки', () => {
    expect(formSrc).toMatch(/data-testid="tech-card-pull-empty"/);
    expect(formSrc).toMatch(/Активных номенклатур пока нет/);
  });

  test('title кнопки подсказывает, что нужно сначала выбрать номенклатуру', () => {
    expect(formSrc).toMatch(/Сначала выберите номенклатуру в списке слева/);
  });
});

// ---------------------------------------------------------------------------
// 7. Upload изображения — disabled для несохранённой строки
// ---------------------------------------------------------------------------

describe('TechCardForm — загрузка изображения материала', () => {
  const formSrc = read(FORM);

  test('canUpload требует одновременно techCardId и lineId', () => {
    expect(formSrc).toMatch(
      /const\s+canUpload\s*=\s*techCardId\s*!==\s*null\s*&&\s*lineId\s*!==\s*null/,
    );
  });

  test('для несохранённой строки рендерится disabled-кнопка с подсказкой', () => {
    // Подсказка обязана быть и в title, и видимым текстом — иначе
    // менеджер не поймёт, почему загрузка не работает.
    expect(formSrc).toMatch(
      /title="Сохраните техкарту, чтобы загрузить изображение"/,
    );
    expect(formSrc).toMatch(
      /Сохраните техкарту, чтобы загрузить изображение\./,
    );
    expect(formSrc).toMatch(/data-testid="material-image-upload-disabled"/);
    // Disabled-кнопка обязана быть type="button" — иначе сабмитит
    // основную форму техкарты.
    expect(formSrc).toMatch(
      /<button\s+type="button"[\s\S]{0,200}?disabled[\s\S]{0,200}?Загрузить изображение/,
    );
  });

  test('для existing строки (lineId !== null) upload остаётся доступен', () => {
    // Сама форма с file-input-ом отрисовывается ТОЛЬКО когда
    // canUpload === true (см. компонент MaterialImageUploader).
    expect(formSrc).toMatch(/data-testid="material-image-upload-form"/);
    expect(formSrc).toMatch(/data-testid="material-image-file-input"/);
  });

  test('для create-режима (techCardId === null) upload запрещён всегда', () => {
    // Идентификатор техкарты вычисляется ровно так:
    expect(formSrc).toMatch(
      /const\s+techCardId\s*=\s*mode\s*===\s*'edit'\s*&&\s*template\s*\?\s*template\.id\s*:\s*null/,
    );
  });

  test('useFormState получает stable noopUploadAction, когда upload запрещён', () => {
    // noopUploadAction должен быть объявлен в этом же файле как
    // обычная async-функция — это держит идентичность action между
    // рендерами для каждого MaterialImageUploader-а.
    expect(formSrc).toMatch(/async\s+function\s+noopUploadAction\b/);
    expect(formSrc).toMatch(/action\s*\?\?\s*noopUploadAction/);
  });
});
