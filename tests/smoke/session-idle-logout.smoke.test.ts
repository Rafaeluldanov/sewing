/**
 * Smoke-тесты автовыхода по бездействию.
 *
 * Проблема, ради которой фича появилась: терминал в цехе один на
 * несколько человек, кнопку «Выйти» после смены почти никто не жмёт, и
 * следующий работает под чужой учёткой — выработка уходит не тому.
 * Сессия при этом stateless и живёт `JWT_EXPIRES_IN` (12 часов) от
 * входа, то есть до утра.
 *
 * Договорённости фичи, которые здесь и закреплены:
 *   - настройка живёт в `CompanySettings` (одна на организацию), `0` —
 *     выключено, то есть после деплоя поведение не меняется;
 *   - TTL cookie = окно бездействия, а продлевает его только ЯВНОЕ
 *     действие человека через `POST /auth/refresh`. Если бы сессию
 *     продлевал любой запрос, забытая открытая вкладка держала бы её
 *     вечно и настройка не значила бы ничего;
 *   - учётка монитора цеха (`DISPLAY`) исключена всегда: за экраном на
 *     стене нет человека, который «проявит активность»;
 *   - «Завершить все сеансы» — отдельная ручка-действие, а не поле
 *     PATCH, и работает сравнением `SessionPayload.iat` с отсечкой.
 *
 * Проверки source-level (как и у остальных smoke-тестов проекта) плюс
 * чистые функции политики, импортированные напрямую.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  sessionIdleTimeoutLabel,
  SESSION_IDLE_TIMEOUT_PRESETS,
} from '@sewing/shared/company-settings';

const repoRoot = path.resolve(__dirname, '..', '..');

function read(p: string): string {
  return readFileSync(path.join(repoRoot, p), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Хранение настройки
// ---------------------------------------------------------------------------

describe('схема — настройка живёт в CompanySettings и по умолчанию выключена', () => {
  const schema = read('prisma/schema.prisma');

  test('поле окна бездействия с дефолтом 0', () => {
    expect(schema).toMatch(/sessionIdleTimeoutMinutes\s+Int\s+@default\(0\)/);
  });

  test('отсечка «завершить все сеансы» — nullable', () => {
    expect(schema).toMatch(/sessionsValidFrom\s+DateTime\?/);
  });
});

describe('shared — пресеты окна бездействия', () => {
  test('первый пресет — «не выходить», и это ноль', () => {
    expect(SESSION_IDLE_TIMEOUT_PRESETS[0]).toBe(0);
    expect(sessionIdleTimeoutLabel(0)).toBe('Не выходить');
  });

  test('минуты и часы подписаны по-русски', () => {
    expect(sessionIdleTimeoutLabel(30)).toBe('30 минут бездействия');
    expect(sessionIdleTimeoutLabel(60)).toBe('1 час бездействия');
    expect(sessionIdleTimeoutLabel(120)).toBe('2 часа бездействия');
    expect(sessionIdleTimeoutLabel(480)).toBe('8 часов бездействия');
  });

  test('PATCH настроек принимает поле', () => {
    const src = read('packages/shared/src/company-settings.ts');
    expect(src).toMatch(
      /sessionIdleTimeoutMinutes:\s*SessionIdleTimeoutMinutesField/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Backend — TTL, исключения, отсечка
// ---------------------------------------------------------------------------

describe('api — окно бездействия задаёт срок жизни cookie', () => {
  const policy = read('apps/api/src/modules/auth/session-policy.ts');
  const service = read('apps/api/src/modules/auth/auth.service.ts');

  test('монитор цеха под автовыход не попадает', () => {
    expect(policy).toMatch(/SESSION_IDLE_EXEMPT_ROLES = \['DISPLAY'\]/);
  });

  test('вход выпускает cookie на окно бездействия', () => {
    expect(service).toMatch(/resolveIdleTtlSeconds\(assigned\)/);
    expect(service).toMatch(/issueSession\(employee, workspace, ttlOverride\)/);
  });

  test('окно не может быть длиннее обычного TTL сессии', () => {
    expect(service).toMatch(/Math\.min\(minutes \* 60, this\.ttlSeconds\)/);
  });

  test('политика кэшируется по тенантам, а не глобально', () => {
    expect(service).toMatch(/policyCache = new Map</);
    expect(service).toMatch(/tenantContext\.getStore\(\)\?\.tenantId \?\? 'default'/);
  });

  test('отсечка «завершить все сеансы» проверяется в resolvePrincipal', () => {
    expect(service).toMatch(
      /isSessionRevoked\(payload\.iat, policy\.sessionsValidFrom\)/,
    );
  });
});

describe('api — продление сессии', () => {
  const controller = read('apps/api/src/modules/auth/auth.controller.ts');

  test('ручка продления есть и требует живую сессию', () => {
    expect(controller).toMatch(/@Post\('refresh'\)/);
    // Не `@Public()`: протухшую сессию продлевать нечем.
    expect(controller).not.toMatch(/@Public\(\)\s*@Post\('refresh'\)/);
  });

  test('/auth/me отдаёт эффективное окно для этой учётки', () => {
    expect(controller).toMatch(
      /sessionIdleTimeoutMinutes: await this\.auth\.getIdleTimeoutMinutes\(/,
    );
  });
});

describe('api — «Завершить все сеансы» — отдельное действие', () => {
  const controller = read(
    'apps/api/src/modules/company-settings/company-settings.controller.ts',
  );
  const service = read(
    'apps/api/src/modules/company-settings/company-settings.service.ts',
  );

  test('ручка POST, а не поле PATCH', () => {
    expect(controller).toMatch(/@Post\('terminate-sessions'\)/);
  });

  test('сдвигает отсечку и пишет audit', () => {
    expect(service).toMatch(/data: \{ sessionsValidFrom \}/);
    expect(service).toMatch(/event: 'COMPANY_SESSIONS_TERMINATED'/);
  });
});

// ---------------------------------------------------------------------------
// 3. Web — сторож бездействия
// ---------------------------------------------------------------------------

describe('web — сторож бездействия', () => {
  const watcher = read('apps/web/components/session/idle-logout-watcher.tsx');
  const layout = read('apps/web/app/layout.tsx');

  test('активность — действия человека, а не фоновые опросы', () => {
    expect(watcher).toMatch(/'pointerdown'/);
    expect(watcher).toMatch(/'keydown'/);
    expect(watcher).toMatch(/visibilitychange/);
  });

  test('сессия на сервере продлевается не чаще раза в минуту', () => {
    expect(watcher).toMatch(/REFRESH_MIN_INTERVAL_MS = 60_000/);
  });

  test('вкладки синхронизируются через localStorage', () => {
    expect(watcher).toMatch(/ACTIVITY_STORAGE_KEY = 'sewing:last-activity'/);
    expect(watcher).toMatch(/addEventListener\('storage'/);
  });

  test('перед выходом предупреждаем, а не выкидываем молча', () => {
    expect(watcher).toMatch(/WARN_SECONDS = 60/);
    expect(watcher).toMatch(/Вы ещё работаете\?/);
  });

  test('layout включает сторож только когда настройка включена', () => {
    expect(layout).toMatch(/idleTimeoutMinutes > 0 \?/);
    expect(layout).toMatch(/<IdleLogoutWatcher timeoutMinutes=\{idleTimeoutMinutes\}/);
  });

  test('после выхода форма входа объясняет причину', () => {
    const login = read('apps/web/app/login/page.tsx');
    expect(login).toMatch(/reason === 'idle'/);
    const actions = read('apps/web/app/(auth)/session-actions.ts');
    expect(actions).toMatch(/redirect\('\/login\?reason=idle'\)/);
  });
});

describe('web — настройка в админке', () => {
  const page = read('apps/web/app/admin/company-settings/page.tsx');
  const section = read(
    'apps/web/app/admin/company-settings/session-policy-section.tsx',
  );

  test('вкладка «Вход и сессии» на странице настроек компании', () => {
    expect(page).toMatch(/tab=security/);
    expect(page).toMatch(/<SessionPolicySection settings=\{settings\} \/>/);
  });

  test('опасное действие требует подтверждения в два шага', () => {
    expect(section).toMatch(/confirming/);
    expect(section).toMatch(/Завершить сеансы у всех сотрудников\?/);
  });
});
