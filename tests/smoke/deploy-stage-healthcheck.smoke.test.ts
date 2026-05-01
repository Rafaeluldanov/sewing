/**
 * deploy-stage healthcheck — source-level smoke.
 *
 * Источник: bug-fix «после `systemctl start sewing-web` deploy-скрипт
 * мгновенно делал `curl -I http://127.0.0.1:3000` и валился с
 * `Failed to connect to 127.0.0.1 port 3000`, потому что Next.js успевал
 * перейти в `active (running)` за ~20ms, но TCP-listener поднимался
 * заметно позже». Подробности — `scripts/deploy-stage.sh §step 7/9`.
 *
 * Реальный full-flow деплоя на CI запускать нельзя (нужен systemd, sudo,
 * postgres, билд репо целиком), поэтому регресс закрепляем source-level:
 *
 *   1. Скрипт включает `set -euo pipefail` (без него ошибка wait-loop
 *      молча игнорируется и оператор видит «DEPLOY OK» при упавшем web).
 *   2. Объявлены оба helper-а: `wait_for_http_200` и
 *      `wait_for_http_head_any_status` (разные семантики — см. комментарий
 *      в скрипте).
 *   3. Helper-ы реально ВЫЗЫВАЮТСЯ:
 *        - для api на http://127.0.0.1:3001/api/health (200 обязателен);
 *        - для web на http://127.0.0.1:3000 (любой HTTP-ответ).
 *   4. Каждый `wait_for_*` стоит ПОСЛЕ соответствующего `systemctl start`
 *      и ДО следующего шага. Между `systemctl start sewing-web` и любым
 *      `curl ... 3000` обязан быть `wait_for_http_head_any_status` —
 *      именно эта последовательность была сломана.
 *   5. В случае ошибки wait-loop печатается диагностика: systemctl status,
 *      journalctl -u <unit>, ss listeners по 3000/3001.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = 'scripts/deploy-stage.sh';

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const script = readSrc(SCRIPT_PATH);

/**
 * Версия скрипта без shell-комментариев — нужна для позиционных проверок
 * «команда A идёт раньше команды B». Без этой нормализации регекс
 * `systemctl start sewing-web` радостно матчится на упоминание этой же
 * команды в объяснительном комментарии (там он встречается раньше, чем
 * реальный вызов), и порядок-проверки начинают врать.
 *
 * Достаточно убрать только цельно-комментные строки (начинаются с `#`
 * после опциональных пробелов): inline-комментарии в этом скрипте не
 * содержат интересующих нас токенов, а удаление inline-`#` могло бы
 * случайно зацепить `#` внутри строк (например, regex'ов).
 */
const scriptCode = script
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

// ---------------------------------------------------------------------------
// 1. Bash safety: set -euo pipefail
// ---------------------------------------------------------------------------

describe('deploy-stage.sh — bash safety', () => {
  test('включает set -euo pipefail (иначе ошибка wait-loop молча проглатывается)', () => {
    expect(script).toMatch(/^\s*set\s+-euo\s+pipefail\b/m);
  });
});

// ---------------------------------------------------------------------------
// 2. Helpers объявлены
// ---------------------------------------------------------------------------

describe('deploy-stage.sh — wait_for_http helpers объявлены', () => {
  test('объявлен wait_for_http_200 (для /api/health, проверяет 200)', () => {
    expect(script).toMatch(/wait_for_http_200\s*\(\)\s*\{/);
  });

  test('объявлен wait_for_http_head_any_status (для web, любой HTTP-ответ)', () => {
    expect(script).toMatch(/wait_for_http_head_any_status\s*\(\)\s*\{/);
  });

  test('wait_for_http_200 использует curl -fsS (-f, чтобы 4xx/5xx считались провалом)', () => {
    const body = script.match(
      /wait_for_http_200\s*\(\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(body, 'wait_for_http_200 body должен быть найден').toBeTruthy();
    expect(body!).toMatch(/curl\s+-fsS/);
  });

  test('wait_for_http_head_any_status использует curl без -f (3xx/4xx — это уже HTTP-ответ)', () => {
    const body = script.match(
      /wait_for_http_head_any_status\s*\(\)\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(
      body,
      'wait_for_http_head_any_status body должен быть найден',
    ).toBeTruthy();
    expect(body!).toMatch(/curl\s+-sS\s+-I/);
    expect(body!).not.toMatch(/curl\s+-fsS/);
  });

  test('оба helper-а имеют retry-loop через for ... seq и sleep (а не один curl)', () => {
    const helpers = ['wait_for_http_200', 'wait_for_http_head_any_status'];
    for (const helper of helpers) {
      const re = new RegExp(`${helper}\\s*\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`);
      const body = script.match(re)?.[0] ?? '';
      expect(body, `${helper} должен иметь тело`).toBeTruthy();
      expect(body).toMatch(/for\s+\w+\s+in\s+\$\(seq\s+1/);
      expect(body).toMatch(/\bsleep\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Helpers реально вызываются на нужные URL-ы
// ---------------------------------------------------------------------------

describe('deploy-stage.sh — wait_for_http helpers реально вызываются', () => {
  test('есть вызов wait_for_http_200 на /api/health (api 3001)', () => {
    // допускаем как литерал, так и переменную ${API_HEALTH_URL},
    // лишь бы где-то рядом был соответствующий URL.
    expect(script).toMatch(
      /wait_for_http_200\s+["']?api["']?\s+["']?(\$\{?API_HEALTH_URL\}?|http:\/\/127\.0\.0\.1:3001\/api\/health)/,
    );
    // и сам URL для api всё-таки прописан в скрипте — чтобы дефолт не уехал.
    expect(script).toMatch(
      /API_HEALTH_URL[^\n]*http:\/\/127\.0\.0\.1:3001\/api\/health/,
    );
  });

  test('есть вызов wait_for_http_head_any_status на web :3000', () => {
    expect(script).toMatch(
      /wait_for_http_head_any_status\s+["']?web["']?\s+["']?(\$\{?WEB_HEALTH_URL\}?|http:\/\/127\.0\.0\.1:3000)/,
    );
    expect(script).toMatch(/WEB_HEALTH_URL[^\n]*http:\/\/127\.0\.0\.1:3000/);
  });
});

// ---------------------------------------------------------------------------
// 4. Порядок: systemctl start <unit> → wait_for_* для этого юнита
//
// Главное, что мы тут защищаем — именно регресс «curl сразу после start».
// Между `systemctl start sewing-web` и любым обращением к :3000 обязан
// быть wait_for_http_head_any_status.
// ---------------------------------------------------------------------------

describe('deploy-stage.sh — порядок start → wait', () => {
  test('после systemctl start sewing-api идёт wait_for_http_200 (api) до старта web', () => {
    const apiStart = scriptCode.search(
      /systemctl\s+start\s+(?:["']?\$?\{?API_UNIT\}?["']?|sewing-api)/,
    );
    const apiWait = scriptCode.search(/wait_for_http_200\s+["']?api["']?/);
    const webStart = scriptCode.search(
      /systemctl\s+start\s+(?:["']?\$?\{?WEB_UNIT\}?["']?|sewing-web)/,
    );

    expect(
      apiStart,
      'systemctl start sewing-api должен присутствовать',
    ).toBeGreaterThan(-1);
    expect(
      apiWait,
      'вызов wait_for_http_200 api должен присутствовать',
    ).toBeGreaterThan(-1);
    expect(
      webStart,
      'systemctl start sewing-web должен присутствовать',
    ).toBeGreaterThan(-1);

    expect(apiStart).toBeLessThan(apiWait);
    expect(apiWait).toBeLessThan(webStart);
  });

  test('после systemctl start sewing-web идёт wait_for_http_head_any_status (web)', () => {
    const webStart = scriptCode.search(
      /systemctl\s+start\s+(?:["']?\$?\{?WEB_UNIT\}?["']?|sewing-web)/,
    );
    const webWait = scriptCode.search(
      /wait_for_http_head_any_status\s+["']?web["']?/,
    );

    expect(webStart).toBeGreaterThan(-1);
    expect(webWait).toBeGreaterThan(-1);
    expect(webStart).toBeLessThan(webWait);
  });

  test('между systemctl start sewing-web и любым curl на :3000 обязан стоять wait_for_http_head_any_status', () => {
    const webStart = scriptCode.search(
      /systemctl\s+start\s+(?:["']?\$?\{?WEB_UNIT\}?["']?|sewing-web)/,
    );
    const webWait = scriptCode.search(
      /wait_for_http_head_any_status\s+["']?web["']?/,
    );
    expect(webStart).toBeGreaterThan(-1);
    expect(webWait).toBeGreaterThan(-1);

    // Любые curl-вызовы на :3000 (как литерал, так и через ${WEB_HEALTH_URL}),
    // которые встречаются после `systemctl start sewing-web`, обязаны идти
    // ПОСЛЕ wait_for_http_head_any_status. Curl внутри тел helper-функций
    // (определённых в начале скрипта) к моменту systemctl start sewing-web
    // ещё не выполняется — фильтр по `idx > webStart` сам по себе их
    // отсекает.
    const curlPattern =
      /curl[^\n]*(?:http:\/\/127\.0\.0\.1:3000|\$\{?WEB_HEALTH_URL\}?)/g;

    let match: RegExpExecArray | null;
    while ((match = curlPattern.exec(scriptCode)) !== null) {
      const idx = match.index;
      if (idx <= webStart) continue;
      expect(
        idx,
        `curl на :3000 в позиции ${idx} стоит до wait_for_http_head_any_status (${webWait}) — это и есть починенный регресс`,
      ).toBeGreaterThan(webWait);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Диагностика на провал wait-loop
// ---------------------------------------------------------------------------

describe('deploy-stage.sh — диагностика на провал wait-loop', () => {
  test('на failure печатается systemctl status для упавшего юнита', () => {
    expect(script).toMatch(/systemctl\s+status[^\n]*--no-pager/);
  });

  test('на failure печатается journalctl -u sewing-api / sewing-web (через ${API_UNIT}/${WEB_UNIT})', () => {
    // допускаем как литерал, так и через переменную ${API_UNIT}/${WEB_UNIT}.
    expect(script).toMatch(
      /journalctl\s+-u\s+["']?(\$\{?API_UNIT\}?|sewing-api)["']?[^\n]*-n\s+\d+/,
    );
    expect(script).toMatch(
      /journalctl\s+-u\s+["']?(\$\{?WEB_UNIT\}?|sewing-web)["']?[^\n]*-n\s+\d+/,
    );
  });

  test('на failure печатается ss listeners по портам 3000/3001', () => {
    expect(script).toMatch(/ss\s+-ltnp[\s\S]*3000\|3001/);
  });

  test('после провала wait-loop скрипт делает exit 1 (deploy не считается успешным)', () => {
    // Ищем хотя бы один блок «if ! wait_for_*; then ... exit 1; fi».
    expect(script).toMatch(
      /if\s+!\s+wait_for_http_200[\s\S]*?\bexit\s+1\s*\n\s*fi/,
    );
    expect(script).toMatch(
      /if\s+!\s+wait_for_http_head_any_status[\s\S]*?\bexit\s+1\s*\n\s*fi/,
    );
  });

  test('диагностические команды защищены ` || true` — не маскируют первичную ошибку', () => {
    // systemctl status / journalctl / ss в diagnostics-блоке не должны
    // ронять скрипт сами по себе при `set -e`. Достаточно, чтобы хотя бы
    // одна из них была с `|| true` — это сигнал, что автор это учёл.
    expect(script).toMatch(/(systemctl\s+status[^\n]*\|\|\s*true|journalctl[^\n]*\|\|\s*true|ss\s+-ltnp[^\n]*\|\|\s*true)/);
  });
});
