/**
 * Smoke-щит для flow «Выпущенные паспорта» помощника раскройщика
 * (см. `apps/web/app/work/passports/*`,
 * `apps/api/src/modules/passports/passports.controller.ts`,
 * `packages/shared/src/passports.ts`).
 *
 * Покрывает структурно:
 *   - shared DTO `UpdatePassportDto` + `MyPassportListItem`,
 *   - backend: `GET /api/passports/my-recent`, `PATCH /api/passports/:id`,
 *     расширенный `DELETE /api/passports/:id` (CUTTER, CUTTER_ASSISTANT)
 *     с self-cancel веткой,
 *   - frontend lib: `listMyRecentPassports`, `updatePassport`,
 *     `loadPassportEditData`,
 *   - server actions: `updateMyPassportAction`, `deleteMyPassportAction`,
 *   - страницы: `/work/passports`, `/work/passports/[id]/edit`,
 *   - кнопка «Выпущенные паспорта» в `CutterAssistantWorkPanel`,
 *   - те же экраны в кабинете раскройщика: `/cutter/passports`,
 *     `/cutter/passports/[id]/edit` (переиспользуют строку списка,
 *     форму правки и server actions помощника — щит следит, чтобы вместо
 *     переиспользования не появилась копия).
 *
 * Реальный happy-path (PATCH меняет qtyCut, immediate-начисление
 * пересчитывается) покрывается integration-тестом на следующем шаге;
 * здесь мы ловим только структурные регрессы.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('shared/passports.ts — UpdatePassportSchema + MyPassportListItem', () => {
  const src = readSrc('packages/shared/src/passports.ts');

  test('UpdatePassportSchema объявлена как Zod-объект со всеми опциональными полями', () => {
    expect(src).toMatch(/export const UpdatePassportSchema\s*=\s*z\s*\n?\s*\.object/);
    // Фокусируем проверку на UpdatePassportSchema, иначе regex может
    // попасть на одноимённые поля в CreatePassportSchema выше.
    const updateBlockMatch = src.match(
      /export const UpdatePassportSchema[\s\S]*?export type UpdatePassportDto/,
    );
    expect(updateBlockMatch).not.toBeNull();
    const updateBlock = updateBlockMatch?.[0] ?? '';
    expect(updateBlock).toContain('sizeId:');
    expect(updateBlock).toContain('cutDate: DateStringSchema.optional()');
    expect(updateBlock).toContain('qtyCut:');
    expect(updateBlock).toContain('rollNumber:');
    expect(updateBlock).toContain('cutterId:');
    // Все поля Update — опциональны: блок должен использовать .optional() ≥5 раз.
    const optionalCount = (updateBlock.match(/\.optional\(\)/g) ?? []).length;
    expect(optionalCount).toBeGreaterThanOrEqual(5);
    // Refine: хотя бы одно поле обязано быть
    expect(src).toMatch(/Передайте хотя бы одно поле для изменения/);
    expect(src).toMatch(/export type UpdatePassportDto\s*=\s*z\.infer<typeof UpdatePassportSchema>/);
  });

  test('MyPassportListItem содержит editable + editableBlockReason', () => {
    expect(src).toMatch(/export interface MyPassportListItem/);
    expect(src).toMatch(/editable:\s*boolean/);
    expect(src).toMatch(
      /editableBlockReason:\s*PassportEditableBlock\s*\|\s*null/,
    );
    expect(src).toMatch(/STATUS_NOT_CREATED/);
    expect(src).toMatch(/PLACED_IN_CELL/);
    expect(src).toMatch(/HAS_EVENTS_BEYOND_CREATED/);
  });
});

describe('Backend — passports.controller.ts: my-recent + PATCH', () => {
  const src = readSrc('apps/api/src/modules/passports/passports.controller.ts');

  test('GET /passports/my-recent объявлен ДО @Get(":id") и доступен CUTTER+CUTTER_ASSISTANT', () => {
    expect(src).toMatch(/@Get\(['"]my-recent['"]\)/);
    expect(src).toMatch(
      /@Roles\(['"]CUTTER['"],\s*['"]CUTTER_ASSISTANT['"],\s*['"]SHOP_MANAGER['"],\s*['"]ADMIN['"]\)/,
    );
    // Маршрут `my-recent` должен идти раньше `:id`, иначе NestJS
    // разрешает его как id="my-recent" и отдаёт 404.
    // Сравниваем по позициям тел методов (`async listMineRecent` vs
    // `getOne(@Param`) — это надёжно отсекает упоминания в JSDoc.
    const myRecentIdx = src.search(/async listMineRecent\(/);
    const getOneIdx = src.search(/^\s*getOne\(@Param/m);
    expect(myRecentIdx).toBeGreaterThan(0);
    expect(getOneIdx).toBeGreaterThan(0);
    expect(myRecentIdx).toBeLessThan(getOneIdx);
    expect(src).toMatch(/this\.passports\.listMineRecent\(user\.employeeId\)/);
  });

  test('PATCH /passports/:id с расширенным RBAC и Zod-pipe', () => {
    expect(src).toMatch(/@Patch\(['"]:id['"]\)/);
    // PATCH — для creator-а (CUTTER_ASSISTANT/CUTTER) и менеджеров.
    expect(src).toMatch(
      /@Patch\(['"]:id['"]\)\s*\n\s*@Roles\(['"]CUTTER['"],\s*['"]CUTTER_ASSISTANT['"],\s*['"]SHOP_MANAGER['"],\s*['"]ADMIN['"]\)/,
    );
    expect(src).toMatch(/UpdatePassportSchema/);
    expect(src).toMatch(
      /this\.passports\.update\(\s*id,\s*dto,\s*\{\s*employeeId:\s*user\.employeeId,\s*role:\s*user\.role,?\s*\}\s*\)/,
    );
  });
});

describe('Backend — passports.service.ts: listMineRecent + update + editable helper', () => {
  const src = readSrc('apps/api/src/modules/passports/passports.service.ts');

  test('listMineRecent фильтрует по creatorId и считает editable через helper', () => {
    expect(src).toMatch(/async listMineRecent\(employeeId:\s*string\)/);
    expect(src).toMatch(/where:\s*\{\s*creatorId:\s*employeeId\s*\}/);
    expect(src).toMatch(/take:\s*100/);
    // События кроме CREATED считаются батчем groupBy, не N+1.
    expect(src).toMatch(/passportEvent\.groupBy/);
    expect(src).toMatch(/this\.editableBlockReason/);
  });

  test('update() пересоздаёт immediate earning раскройщика и пишет AuditLog', () => {
    expect(src).toMatch(
      // `role` — строка (`AppRole.code`), а не Prisma-enum: роли
      // заводятся из справочника `/admin/roles`.
      /async update\(\s*id:\s*string,\s*dto:\s*UpdatePassportDto,\s*actor:\s*\{[^}]*employeeId:\s*string;\s*role:\s*string;?\s*\}/,
    );
    // Чистим immediate-cutter entries (sourceEventType=PASSPORT_CREATED)
    // и пересоздаём через EarningsService — атомарно в одной транзакции.
    expect(src).toMatch(/operationEntry\.deleteMany/);
    expect(src).toMatch(/sourceEventType:\s*['"]PASSPORT_CREATED['"]/);
    expect(src).toMatch(/this\.earnings\.createImmediateForCutter/);
    expect(src).toMatch(/event:\s*['"]PASSPORT_UPDATED['"]/);
    // Блокер «не свой» / «не editable»
    expect(src).toMatch(/throw new PassportNotYoursToEditException/);
    expect(src).toMatch(/throw new PassportNotEditableException/);
  });

  test('editableBlockReason возвращает три кода: STATUS / PLACED / EVENTS', () => {
    expect(src).toMatch(/private editableBlockReason\(/);
    expect(src).toMatch(/STATUS_NOT_CREATED/);
    expect(src).toMatch(/PLACED_IN_CELL/);
    expect(src).toMatch(/HAS_EVENTS_BEYOND_CREATED/);
  });
});

describe('Backend — common/errors.ts: новые исключения', () => {
  const src = readSrc('apps/api/src/common/errors.ts');

  test('PassportNotYoursToEditException → 403 PASSPORT_NOT_YOURS_TO_EDIT', () => {
    expect(src).toMatch(
      /class PassportNotYoursToEditException extends BusinessException/,
    );
    expect(src).toMatch(/PASSPORT_NOT_YOURS_TO_EDIT/);
    expect(src).toMatch(
      /class PassportNotYoursToEditException[\s\S]*?HttpStatus\.FORBIDDEN/,
    );
  });

  test('PassportNotEditableException → 409 PASSPORT_NOT_EDITABLE', () => {
    expect(src).toMatch(
      /class PassportNotEditableException extends BusinessException/,
    );
    expect(src).toMatch(/PASSPORT_NOT_EDITABLE/);
    expect(src).toMatch(
      /class PassportNotEditableException[\s\S]*?HttpStatus\.CONFLICT/,
    );
  });
});

describe('Frontend lib — listMyRecentPassports / updatePassport', () => {
  const src = readSrc('apps/web/lib/passports-api.ts');

  test('listMyRecentPassports() зовёт GET /passports/my-recent с no-store', () => {
    expect(src).toMatch(/export function listMyRecentPassports/);
    expect(src).toMatch(/['"]\/passports\/my-recent['"]/);
    expect(src).toMatch(/cache:\s*['"]no-store['"]/);
  });

  test('updatePassport(id, body) шлёт PATCH /passports/:id', () => {
    expect(src).toMatch(/export function updatePassport/);
    expect(src).toMatch(/method:\s*['"]PATCH['"]/);
    expect(src).toMatch(/\/passports\/\$\{encodeURIComponent\(id\)\}/);
  });
});

describe('Frontend server actions — updateMyPassport / deleteMyPassport', () => {
  const src = readSrc('apps/web/app/work/passports/actions.ts');

  test("updateMyPassportAction делает PATCH и редиректит на /work/passports", () => {
    expect(src).toMatch(/'use server'/);
    expect(src).toMatch(/export async function updateMyPassportAction/);
    expect(src).toMatch(/UpdatePassportSchema\.safeParse/);
    expect(src).toMatch(/await updatePassport\(passportId,\s*parsed\.data\)/);
    expect(src).toMatch(/redirect\(['"]\/work\/passports['"]\)/);
    // Ревалидируем все срезы паспорта/заказа
    expect(src).toMatch(/revalidatePath\(['"]\/work\/passports['"]\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/passports\/\$\{passportId\}`\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/orders\/\$\{orderId\}`\)/);
  });

  test('deleteMyPassportAction зовёт deletePassport и ревалидирует список', () => {
    expect(src).toMatch(/export async function deleteMyPassportAction/);
    expect(src).toMatch(/await deletePassport\(passportId\)/);
    expect(src).toMatch(/revalidatePath\(['"]\/work\/passports['"]\)/);
    expect(src).toMatch(/revalidatePath\(`\/admin\/passports\/\$\{passportId\}`\)/);
  });
});

describe('UI — CutterAssistantWorkPanel: кнопка «Выпущенные паспорта»', () => {
  const src = readSrc('apps/web/app/work/active-shift-panel.tsx');

  test('кнопка стоит в одном scan-card блоке с «Выпустить паспорт» и ведёт на /work/passports', () => {
    expect(src).toMatch(/href=['"]\/work\/cut-orders['"]/);
    // Новая secondary-action кнопка ведёт на список — внутри той же
    // scan-card блока, что и primary «Выпустить паспорт».
    expect(src).toMatch(/href=['"]\/work\/passports['"]/);
    expect(src).toMatch(/Выпущенные паспорта/);
    // Порядок проверяем по фрагменту функции `CutterAssistantWorkPanel`
    // (без JSDoc выше): «Выпустить паспорт» → «Выпущенные паспорта»
    // → следующий блок «Разместить крой на стеллаж».
    const panelStart = src.indexOf('export function CutterAssistantWorkPanel');
    expect(panelStart).toBeGreaterThan(0);
    const panel = src.slice(panelStart);
    const issueIdx = panel.indexOf('Выпустить паспорт');
    const releasedIdx = panel.indexOf('Выпущенные паспорта');
    const placeIdx = panel.indexOf('Разместить крой на стеллаж');
    expect(issueIdx).toBeGreaterThan(0);
    expect(releasedIdx).toBeGreaterThan(0);
    expect(placeIdx).toBeGreaterThan(0);
    expect(issueIdx).toBeLessThan(releasedIdx);
    expect(releasedIdx).toBeLessThan(placeIdx);
  });
});

describe('UI — /work/passports (список) + /work/passports/[id]/edit', () => {
  test('list-страница SSR-загружает listMyRecentPassports и рендерит общую строку MyPassportRow', () => {
    const src = readSrc('apps/web/app/work/passports/page.tsx');
    expect(src).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
    expect(src).toMatch(/await listMyRecentPassports\(\)/);
    // Разметка строки вынесена в `./my-passport-row`, потому что тот же
    // компонент рендерит список раскройщика `/cutter/passports`.
    expect(src).toMatch(/import \{ MyPassportRow \} from '\.\/my-passport-row'/);
    expect(src).toMatch(/<MyPassportRow key=\{p\.id\} item=\{p\} \/>/);
    // «← На рабочее место» — стандартная back-стрелка под заголовком.
    expect(src).toMatch(/href=['"]\/work['"]/);
  });

  test('строка списка печатает/редактирует/удаляет и гасит кнопки на не-editable', () => {
    const src = readSrc('apps/web/app/work/passports/my-passport-row.tsx');
    expect(src).toMatch(/export function MyPassportRow/);
    // Печать доступна всегда, правка/удаление — только пока editable.
    expect(src).toMatch(/PrintButton/);
    expect(src).toMatch(/DeleteMyPassportButton/);
    expect(src).toMatch(/Редактировать/);
    expect(src).toMatch(/item\.editable/);
    expect(src).toMatch(/editableBlockReason/);
    // `basePath` — единственное различие двух кабинетов; дефолт =
    // маршрут помощника.
    expect(src).toMatch(/basePath = '\/work\/passports'/);
    expect(src).toMatch(/\$\{basePath\}\/\$\{item\.id\}\/edit/);
  });

  test('данные формы правки грузит общий loadPassportEditData (остаток без самого паспорта)', () => {
    const lib = readSrc('apps/web/lib/passport-edit-data.ts');
    expect(lib).toMatch(/export async function loadPassportEditData/);
    expect(lib).toMatch(/getPassport\(passportId\)/);
    expect(lib).toMatch(/listOrderPassports\(passport\.orderId\)/);
    expect(lib).toMatch(/listActiveCutters\(\)/);
    // Остаток по размеру считается БЕЗ редактируемого паспорта, иначе
    // сохранение того же qtyCut упирается в собственное прежнее значение.
    expect(lib).toMatch(/if \(p\.id === passport\.id\) continue;/);
    // Паспорт уже двинулся → форму не рисуем (страница редиректит).
    expect(lib).toMatch(/kind: 'not-editable'/);
  });

  test('edit-страница помощника переводит результат загрузчика в свою навигацию', () => {
    const src = readSrc('apps/web/app/work/passports/[id]/edit/page.tsx');
    expect(src).toMatch(/loadPassportEditData\(params\.id,\s*me\.user\.role\)/);
    expect(src).toMatch(/notFound\(\)/);
    // Если паспорт уже двинулся, отправляем обратно в список.
    expect(src).toMatch(/redirect\(['"]\/work\/passports['"]\)/);
  });

  test('edit-форма зовёт updateMyPassportAction.bind(null, passportId, orderId)', () => {
    const src = readSrc(
      'apps/web/app/work/passports/[id]/edit/edit-passport-form.tsx',
    );
    expect(src).toMatch(/updateMyPassportAction\.bind\(null,\s*passportId,\s*orderId\)/);
    // ТЗ: «после окончания редактирования выпустить паспорт» —
    // primary CTA называется «Выпустить паспорт» (а не «Сохранить»).
    expect(src).toMatch(/Выпустить паспорт/);
    // Навигация вокруг формы параметризована (`backHref`/`homeHref`),
    // дефолты сохраняют маршрут помощника: «Отмена» и «К списку
    // паспортов» ведут на /work/passports.
    expect(src).toMatch(/backHref = '\/work\/passports'/);
    expect(src).toMatch(/homeHref = '\/work'/);
    expect(src).toMatch(/href=\{backHref\}/);
    expect(src).toMatch(/href=\{homeHref\}/);
  });
});

describe('UI — те же экраны в кабинете раскройщика (/cutter/passports)', () => {
  test('список раскройщика переиспользует MyPassportRow с basePath=/cutter/passports', () => {
    const src = readSrc('apps/web/app/cutter/passports/page.tsx');
    expect(src).toMatch(/export const dynamic\s*=\s*['"]force-dynamic['"]/);
    expect(src).toMatch(/await listMyRecentPassports\(\)/);
    expect(src).toMatch(
      /import \{ MyPassportRow \} from '@\/app\/work\/passports\/my-passport-row'/,
    );
    expect(src).toMatch(/basePath="\/cutter\/passports"/);
    // Экран-ребёнок вкладки «Выпуск» → возврат в очередь выпуска.
    expect(src).toMatch(/href="\/cutter\/release"/);
    expect(src).toMatch(/Пока нет выпущенных паспортов/);
  });

  test('edit-страница раскройщика переиспользует EditPassportForm и общий загрузчик', () => {
    const src = readSrc('apps/web/app/cutter/passports/[id]/edit/page.tsx');
    expect(src).toMatch(
      /import \{ EditPassportForm \} from '@\/app\/work\/passports\/\[id\]\/edit\/edit-passport-form'/,
    );
    expect(src).toMatch(/loadPassportEditData\(params\.id,\s*me\.user\.role\)/);
    expect(src).toMatch(/backHref="\/cutter\/passports"/);
    expect(src).toMatch(/homeHref="\/cutter"/);
    expect(src).toMatch(/redirect\(['"]\/cutter\/passports['"]\)/);
  });

  test('server actions ревалидируют ОБА списка — помощника и раскройщика', () => {
    const src = readSrc('apps/web/app/work/passports/actions.ts');
    expect(src).toMatch(/revalidatePath\(['"]\/cutter\/passports['"]\)/);
    // В обоих экшенах: правка и удаление видны в обоих кабинетах.
    const hits = src.match(/revalidatePath\(['"]\/cutter\/passports['"]\)/g);
    expect(hits?.length).toBe(2);
  });

  test('GET /orders/:id открыт раскройщику — форме правки нужна размерная матрица', () => {
    const src = readSrc('apps/api/src/modules/orders/orders.controller.ts');
    expect(src).toMatch(
      /@Get\(['"]:id['"]\)\s*\n\s*@Roles\(['"]SHOP_MANAGER['"],\s*['"]CUTTER_ASSISTANT['"],\s*['"]CUTTER['"]\)/,
    );
  });
});
