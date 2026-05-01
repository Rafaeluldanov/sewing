/**
 * Uploads static routing — source-level smoke.
 *
 * Источник: bug-fix «превью лекала на /admin/patterns и в форме заказа
 * не открывается (404 на /uploads/...)». Подробнее — почему проблема
 * именно в static routing — см. `docs/deploy-uploads-static-routing.md`.
 *
 * Запускать full HTTP-проверку (nginx → API → файл) на CI смысла нет
 * (нужен nginx, наполненный uploads-каталог и реальный домен), поэтому
 * закрепляем регрессы прямо в исходниках:
 *
 *   1. `apps/api/src/main.ts` действительно поднимает static-mount
 *      под префиксом `/uploads` и берёт корень из `PATTERNS_UPLOADS_DIR`.
 *   2. `PatternsStorageService` использует тот же env и тот же
 *      `publicPrefix = '/uploads'` — иначе URL в БД и каталог на диске
 *      «разъедутся».
 *   3. `.env.example` документирует `PATTERNS_UPLOADS_DIR`, иначе
 *      оператор stage его не выставит и uploads съест каждый релиз.
 *   4. nginx-снипеты в `docs/deploy-stage.md` и `README.md` содержат
 *      блок `location ^~ /uploads/` с `proxy_pass` на API:3001 и
 *      объявлены ДО общего `location /` — иначе longest-prefix
 *      отправит `/uploads/...` в Next.js.
 *   5. Дедикейтед-документ `docs/deploy-uploads-static-routing.md`
 *      существует, ссылается на API-порт 3001 и содержит команды
 *      ручной проверки через curl.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1. Backend: useStaticAssets для /uploads
// ---------------------------------------------------------------------------

describe('Uploads static routing — apps/api/src/main.ts', () => {
  const main = readSrc('apps/api/src/main.ts');

  test('app.useStaticAssets вызывается с prefix "/uploads"', () => {
    expect(main).toMatch(/app\.useStaticAssets\(/);
    expect(main).toMatch(/prefix:\s*['"]\/uploads['"]/);
  });

  test('uploadsRoot читается из PATTERNS_UPLOADS_DIR с дефолтом apps/api/uploads', () => {
    expect(main).toMatch(/process\.env\.PATTERNS_UPLOADS_DIR/);
    expect(main).toMatch(/apps\/api\/uploads/);
  });

  test('uploadsRoot нормализуется через resolve() (защита от относительных путей)', () => {
    expect(main).toMatch(/\bresolve\(/);
  });
});

// ---------------------------------------------------------------------------
// 2. Backend: PatternsStorageService использует тот же prefix и env
// ---------------------------------------------------------------------------

describe('Uploads static routing — PatternsStorageService', () => {
  const storage = readSrc(
    'apps/api/src/modules/patterns/patterns-storage.service.ts',
  );

  test('использует тот же env PATTERNS_UPLOADS_DIR с тем же дефолтом', () => {
    expect(storage).toMatch(/process\.env\.PATTERNS_UPLOADS_DIR/);
    expect(storage).toMatch(/apps\/api\/uploads/);
  });

  test('publicPrefix = "/uploads" — URL в БД совпадает с static-mount-ом', () => {
    expect(storage).toMatch(/publicPrefix\s*=\s*['"]\/uploads['"]/);
  });
});

// ---------------------------------------------------------------------------
// 3. .env.example документирует PATTERNS_UPLOADS_DIR
// ---------------------------------------------------------------------------

describe('Uploads static routing — .env.example', () => {
  const env = readSrc('.env.example');

  test('содержит упоминание PATTERNS_UPLOADS_DIR (даже если закомментировано)', () => {
    expect(env).toMatch(/PATTERNS_UPLOADS_DIR/);
  });

  test('даёт оператору пример пути для stage/prod', () => {
    expect(env).toMatch(/PATTERNS_UPLOADS_DIR=.*uploads/);
  });
});

// ---------------------------------------------------------------------------
// 4. nginx config snippets — обязан быть блок /uploads/ → API
// ---------------------------------------------------------------------------

const NGINX_SOURCES = [
  'docs/deploy-stage.md',
  'README.md',
];

describe('Uploads static routing — nginx snippets in repo', () => {
  test.each(NGINX_SOURCES)(
    '%s содержит location ^~ /uploads/ с proxy_pass на API:3001',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(/location\s+\^~\s+\/uploads\//);
      expect(src).toMatch(
        /location\s+\^~\s+\/uploads\/[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3001/,
      );
    },
  );

  test.each(NGINX_SOURCES)(
    '%s объявляет location /uploads/ ДО общего location /',
    (file) => {
      const src = readSrc(file);
      // Берём первое вхождение каждого блока в этом конфиг-снипете.
      const uploadsIdx = src.search(/location\s+\^~\s+\/uploads\//);
      // Общий `location /` — но НЕ `location /api/`, `location /_next/`,
      // `location /uploads/` и т.п. (требуем ровно `/` + whitespace).
      const rootIdx = src.search(/location\s+\/\s*\{/);
      expect(uploadsIdx).toBeGreaterThan(-1);
      expect(rootIdx).toBeGreaterThan(-1);
      expect(uploadsIdx).toBeLessThan(rootIdx);
    },
  );

  test.each(NGINX_SOURCES)(
    '%s сохраняет существующий блок location /api/ → API:3001',
    (file) => {
      const src = readSrc(file);
      expect(src).toMatch(
        /location\s+\/api\/[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:3001/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Дедикейтед-документ docs/deploy-uploads-static-routing.md
// ---------------------------------------------------------------------------

describe('Uploads static routing — deploy doc', () => {
  const docPath = 'docs/deploy-uploads-static-routing.md';
  const doc = readSrc(docPath);

  test('документ содержит nginx-снипет location ^~ /uploads/', () => {
    expect(doc).toMatch(/location\s+\^~\s+\/uploads\//);
  });

  test('документ содержит proxy_pass на http://127.0.0.1:3001', () => {
    expect(doc).toMatch(/proxy_pass\s+http:\/\/127\.0\.0\.1:3001/);
  });

  test('документ содержит команды ручной проверки через curl', () => {
    expect(doc).toMatch(/curl\s+-I\s+["']?http:\/\/127\.0\.0\.1:3001/);
    expect(doc).toMatch(/curl\s+-I\s+["']?https?:\/\/stage\.teeon\.ru/);
  });

  test('документ предупреждает о persistance uploads (не удалять при деплое)', () => {
    expect(doc).toMatch(/Не\s+удалять|persisted|persisted-том|PATTERNS_UPLOADS_DIR/);
  });

  test('документ упоминается из docs/deploy-stage.md и README.md', () => {
    expect(readSrc('docs/deploy-stage.md')).toMatch(
      /deploy-uploads-static-routing\.md/,
    );
    expect(readSrc('README.md')).toMatch(/deploy-uploads-static-routing\.md/);
  });
});
