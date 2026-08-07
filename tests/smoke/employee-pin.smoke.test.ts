/**
 * Smoke-тесты фичи «показать пароль сотрудника в карточке»
 * (`/admin/employees/[id]` + backend `POST /api/employees/:id/reveal-pin`
 * и `pin` в `PATCH /api/employees/:id`).
 *
 * Полноценного React-рендера в проекте нет (vitest + Node, без jsdom),
 * поэтому фиксируем контур на уровне исходников. Здесь это особенно
 * уместно: почти все проверки — про то, чего в коде быть НЕ должно
 * (PIN в списочном DTO, значение PIN в аудите, GET-ручка показа), а
 * такие регрессы тихие — фича продолжает «работать», просто течёт.
 *
 * Парный пример — `tests/smoke/display-screens-admin.smoke.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

/** Все `.ts`-файлы под указанными каталогами, путями от корня репо. */
function walk(roots: string[]): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const entry of readdirSync(path.join(repoRoot, rel), {
      withFileTypes: true,
    })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        visit(child);
      } else if (entry.name.endsWith('.ts')) {
        out.push(child);
      }
    }
  };
  roots.forEach(visit);
  return out;
}

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/**
 * Тело функции от её сигнатуры до закрывающей скобки того же уровня
 * отступа (`\n  }`) — все методы сервиса объявлены в классе, отступ
 * стабильный.
 *
 * Заведено вместо `slice(indexOf(A), indexOf(B))` по чужому маркеру
 * сознательно: если правый маркер переименуют, `indexOf` вернёт -1,
 * а `slice(start, -1)` отдаст ВЕСЬ остаток файла — и сторож начнёт
 * находить искомое в соседних методах, оставаясь зелёным при вырезанном
 * гейте. Здесь же отсутствие маркера — это провал теста, а не тихое
 * расширение области поиска.
 */
function sliceFn(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `сигнатура «${signature}» не найдена`).toBeGreaterThan(-1);
  const end = src.indexOf('\n  }', start);
  expect(end, `не найден конец «${signature}»`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Employee.pinEnc — обратимая копия PIN рядом с bcrypt-хешем', () => {
  test('в схеме есть nullable pinEnc, а pinHash остался обязательным', () => {
    const src = readSrc('prisma/schema.prisma');
    expect(src).toMatch(/pinEnc\s+String\?/);
    // Вход проверяется ТОЛЬКО по bcrypt: если pinHash когда-нибудь
    // станет nullable — значит логин переехал на обратимую колонку,
    // и это надо заметить.
    expect(src).toMatch(/pinHash\s+String\b(?!\?)/);
  });

  test('миграция добавляет колонку и не пытается сделать бэкфилл', () => {
    const src = readSrc(
      'prisma/migrations/20261010100000_employee_pin_enc/migration.sql',
    );
    expect(src).toMatch(/ALTER TABLE "Employee" ADD COLUMN "pinEnc" TEXT;/);
    // Бэкфилла быть не может — открытого PIN'а старых карточек не
    // существует. UPDATE здесь означал бы, что кто-то придумал значение.
    expect(src).not.toMatch(/UPDATE\s+"Employee"/i);
  });
});

describe('Обе колонки PIN пишутся парой — во ВСЕХ путях записи', () => {
  const helper = readSrc('apps/api/src/common/pin-columns.ts');
  const employees = readSrc(
    'apps/api/src/modules/employees/employees.service.ts',
  );

  test('единая точка вычисления пары живёт в common/pin-columns.ts', () => {
    expect(helper).toMatch(/export async function buildPinColumns/);
    expect(helper).toMatch(/bcrypt\.hash\(/);
    expect(helper).toMatch(/encryptSecret\(pin\)/);
  });

  test('bcrypt для PIN зовётся ТОЛЬКО из общего хелпера', () => {
    // Это и есть сам инвариант фичи. Любой второй вызов bcrypt.hash над
    // PIN'ом = второй путь записи, где легко забыть pinEnc, и тогда
    // карточка покажет менеджеру прежний, уже недействительный код.
    //
    // Сканируем СПЛОШНЯКОМ, а не закрытым списком файлов: закрытый
    // список ловит регресс в известных четырёх писателях и пропускает
    // ровно тот случай, ради которого хелпер и заведён, — ПЯТОГО
    // писателя `Employee`, о котором тест не знает.
    const hashers = walk(['apps/api/src', 'prisma', 'scripts']).filter((f) =>
      /bcrypt\.hash(Sync)?\(/.test(readSrc(f)),
    );
    // `packages/` не сканируем: там только докстринги, дающие ложное
    // срабатывание. `tests/` — фикстуры, они PIN не показывают.
    expect(hashers.sort()).toEqual(['apps/api/src/common/pin-columns.ts']);
  });

  test('EmployeesService: create и update пишут pinEnc, а не только хеш', () => {
    expect(employees).toMatch(/pinHash,\s*\n\s*pinEnc,/);
    expect(employees).toMatch(/data\.pinEnc = pinColumns\.pinEnc;/);
  });

  test('DisplayScreensService: смена PIN монитора затирает и pinEnc', () => {
    // DISPLAY-учётка — обычная строка Employee и видна в карточке
    // сотрудника. Если тут писать только pinHash, показ соврёт.
    const ds = readSrc(
      'apps/api/src/modules/display-screens/display-screens.service.ts',
    );
    expect(ds).toMatch(/employeeData\.pinEnc = pinColumns\.pinEnc;/);
    expect(ds).toMatch(/pinHash,\s*\n\s*pinEnc,/);
  });

  test('seed и провижининг тенанта тоже пишут пару', () => {
    expect(readSrc('prisma/seed.ts')).toMatch(/pinHash,\s*pinEnc/);
    expect(readSrc('scripts/tenants/create-tenant.ts')).toMatch(
      /update: \{ pinHash, pinEnc,/,
    );
  });

  test('отсутствие ключа шифрования не роняет сохранение PIN', () => {
    expect(helper).toMatch(/isSecretKeyConfigured\(\)/);
    expect(helper).toMatch(/pinEnc: null/);
    // Именно return, а не throw: без ключа сотрудник всё равно заводится.
    expect(helper).not.toMatch(/throw new .*SecretKeyMissing/);
  });
});

describe('Показ PIN — RBAC и аудит', () => {
  const service = readSrc(
    'apps/api/src/modules/employees/employees.service.ts',
  );
  const controller = readSrc(
    'apps/api/src/modules/employees/employees.controller.ts',
  );

  test('ручка показа — POST (GET кэшируется и префетчится, засоряя аудит)', () => {
    expect(controller).toMatch(/@Post\(':id\/reveal-pin'\)/);
    expect(controller).not.toMatch(/@Get\(':id\/reveal-pin'\)/);
  });

  test('не-админ не может ни посмотреть, ни сменить, ни ЗАВЕСТИ привилегированную учётку', () => {
    // Три независимых guard'а одного корня. Забыть любой легко:
    // «задать админу PIN и войти под ним» и «завести себе админа» в
    // коде выглядят как обычная работа с карточкой.
    expect(sliceFn(service, 'async revealPin(')).toMatch(
      /isPrivilegedTarget[\s\S]{0,200}?EmployeeAdminTargetForbiddenException/,
    );
    expect(sliceFn(service, 'async update(')).toMatch(
      /dto\.pin !== undefined &&[\s\S]{0,300}?EmployeeAdminTargetForbiddenException/,
    );
    expect(sliceFn(service, 'async create(')).toMatch(
      /isPrivilegedTarget[\s\S]{0,200}?EmployeeAdminTargetForbiddenException/,
    );
    // Контроллер обязан передать viewer — иначе гейт в create нечем
    // питать, а сигнатура молча примет undefined только на JS-уровне.
    expect(controller).toMatch(
      /create\([\s\S]{0,200}?@CurrentUser\(\) viewer: AuthPrincipal/,
    );
  });

  test('SUPERADMIN считается привилегированным (grantsAdmin его НЕ ловит)', () => {
    // `grantsAdmin(['SUPERADMIN'])` = false: код есть в SYSTEM_ROLE_CODES,
    // и метод выходит по ветке areAllSystemRoles. Поэтому RBAC-гейты
    // ходят через отдельный предикат.
    expect(service).toMatch(
      /isPrivilegedTarget[\s\S]{0,400}?codes\.includes\(Role\.SUPERADMIN\)/,
    );
    // И этот предикат НЕ должен подменять grantsAdmin: тот же метод
    // считает последнего активного админа, и SUPERADMIN в этом счёте
    // администратором не является.
    expect(sliceFn(service, 'private async grantsAdmin(')).not.toMatch(
      /SUPERADMIN/,
    );
    expect(service).toMatch(
      /assertNotLastActiveAdmin[\s\S]{0,4000}?grantsAdmin/,
    );
  });

  test('в аудит уходит факт, но не значение PIN', () => {
    expect(service).toMatch(/EMPLOYEE_PIN_VIEWED/);
    expect(service).toMatch(/EMPLOYEE_PIN_CHANGED/);
    // Ни открытый PIN, ни хеш, ни шифротекст в payload журнала.
    expect(service).not.toMatch(/payload: \{[^}]*\bpin\b\s*[,:]/);
    expect(service).not.toMatch(/pinHash: pinColumns/);
  });
});

describe('DTO — наружу уходит флаг, а не пароль', () => {
  test('EmployeeDetailDto отдаёт hasStoredPin и не отдаёт pin', () => {
    const shared = readSrc('packages/shared/src/employees.ts');
    expect(shared).toMatch(/hasStoredPin\?: boolean/);
    expect(shared).toMatch(/EmployeePinRevealDto/);
    // `pin` допустим ровно как ВХОДНОЕ поле create/update DTO, а вот
    // объявления колонок хранения в ответных интерфейсах быть не должно
    // (в докстрингах они упоминаются — отсюда якорь на начало строки).
    expect(shared).not.toMatch(/^\s*pin(Hash|Enc)\??:/m);
  });

  test('маппер списка не проецирует PIN, а detail — только флаг', () => {
    const service = readSrc(
      'apps/api/src/modules/employees/employees.service.ts',
    );
    expect(service).toMatch(/hasStoredPin: e\.pinEnc !== null/);
    // Флаг живёт в toDetailDto; в toListDto (список сотрудников) его
    // быть не должно — лишний повод отдавать колонку широкой ручкой.
    const start = service.indexOf('function toListDto');
    const end = service.indexOf('function toDetailDto');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const listDto = service.slice(start, end);
    // Позитивная проверка подпирает негативную: без неё пустой срез
    // (потеря левого маркера) проходил бы `not.toMatch` вакуумно.
    expect(listDto).toMatch(/return \{/);
    expect(listDto).not.toMatch(/pinEnc/);
  });
});

describe('Карточка сотрудника — кнопка «Показать» и отдельная форма смены', () => {
  test('блок «Доступ» больше не пишет «скрыт», а рендерит EmployeePinReveal', () => {
    const src = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    expect(src).toMatch(/<EmployeePinReveal employee=\{employee\} \/>/);
    expect(src).not.toMatch(/<dd className="admin-muted">скрыт<\/dd>/);
    expect(src).toMatch(/<EmployeePinForm employee=\{employee\} \/>/);
  });

  test('смена PIN — своя форма, а не поле в форме зарплаты', () => {
    const editForm = readSrc('apps/web/app/admin/employees/[id]/edit-form.tsx');
    // Если в форме ставки появится name="pin" — сохранение зарплаты
    // начнёт сбрасывать код входа.
    expect(editForm).not.toMatch(/name="pin"/);

    const pinCard = readSrc('apps/web/app/admin/employees/[id]/pin-card.tsx');
    expect(pinCard).toMatch(/name="pin"/);
    expect(pinCard).toMatch(/name="pinRepeat"/);
  });

  test('PIN не подтягивается при рендере страницы — только по нажатию', () => {
    const page = readSrc('apps/web/app/admin/employees/[id]/page.tsx');
    // RSC не должен звать показ: каждый вызов пишется в аудит.
    expect(page).not.toMatch(/revealEmployeePin/);
    const pinCard = readSrc('apps/web/app/admin/employees/[id]/pin-card.tsx');
    expect(pinCard).toMatch(/onClick=/);
    expect(pinCard).toMatch(/revealEmployeePinAction/);
  });

  test('server action проверяет повтор PIN до похода в API', () => {
    const actions = readSrc('apps/web/app/admin/employees/actions.ts');
    expect(actions).toMatch(/pin !== pinRepeat/);
    expect(actions).toMatch(/updateEmployeePinAction/);
  });
});
