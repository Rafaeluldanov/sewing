/**
 * Smoke-тесты diagnostic consistency report (read-only инвариант).
 *
 * Здесь мы НЕ дёргаем БД. Задача — зафиксировать «не должно быть»:
 *
 *   1. controller имеет `@Roles('ADMIN', 'SHOP_MANAGER')` и
 *      объявляет ровно один GET endpoint;
 *   2. service не делает write-операций (`update`/`delete`/`create`/
 *      `upsert`/raw write) — это сознательный инвариант
 *      «отчёт ничего не чинит автоматически» (см. `docs/ops.md
 *      §«Diagnostics»`);
 *   3. UI-страница существует, рендерит summary/таблицу и не
 *      содержит auto-fix кнопок/форм.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('diagnostics — smoke (read-only invariant)', () => {
  test('controller: @Roles(ADMIN, SHOP_MANAGER) и один GET consistency', () => {
    const src = read('apps/api/src/modules/diagnostics/diagnostics.controller.ts');
    expect(src).toMatch(/@Roles\(['"]ADMIN['"],\s*['"]SHOP_MANAGER['"]\)/);
    expect(src).toMatch(/@Controller\(['"]admin\/diagnostics['"]\)/);
    expect(src).toMatch(/@Get\(['"]consistency['"]\)/);
    // Никаких других глаголов в этом контроллере быть не должно.
    expect(src).not.toMatch(/@(Post|Put|Patch|Delete)\(/);
  });

  test('service: только read-операции Prisma', () => {
    const src = read('apps/api/src/modules/diagnostics/diagnostics.service.ts');
    // На каждый запрещённый метод ловим именно вызов prisma.* — иначе
    // подсветим даже названия в комментариях. Допустимы: findMany,
    // findFirst, findUnique, count, groupBy, aggregate, $queryRaw.
    const forbidden = [
      'prisma.passport.update',
      'prisma.passport.create',
      'prisma.passport.delete',
      'prisma.passport.upsert',
      'prisma.order.update',
      'prisma.order.create',
      'prisma.order.delete',
      'prisma.order.upsert',
      'prisma.shiftSession.update',
      'prisma.shiftSession.create',
      'prisma.shiftSession.delete',
      'prisma.cellContent.update',
      'prisma.cellContent.create',
      'prisma.cellContent.delete',
      'prisma.box.update',
      'prisma.box.create',
      'prisma.box.delete',
      'prisma.boxItem.update',
      'prisma.boxItem.create',
      'prisma.boxItem.delete',
      '$executeRaw',
      '$executeRawUnsafe',
      '$transaction',
    ];
    for (const f of forbidden) {
      expect(src.includes(f), `forbidden write op found: ${f}`).toBe(false);
    }
    // Sanity: read-операции присутствуют, иначе сервис деградировал
    // и тест надо бы пересобрать.
    expect(src).toMatch(/findMany\(/);
    expect(src).toMatch(/groupBy\(/);
  });

  test('UI: страница есть, рендерит summary/таблицу и без auto-fix', () => {
    const src = read('apps/web/app/admin/diagnostics/page.tsx');
    expect(src).toMatch(/summary\.total/);
    expect(src).toMatch(/summary\.critical/);
    expect(src).toMatch(/summary\.warning/);
    // В таблице есть колонки severity/code/message/context.
    expect(src).toMatch(/Severity/);
    expect(src).toMatch(/Code/);
    expect(src).toMatch(/Сообщение/);
    expect(src).toMatch(/Context/);
    // «Проблем не найдено» — обязательный empty state, нужный для UX.
    expect(src).toMatch(/Проблем не найдено/);
    // Никаких форм с действиями: read-only страница не должна делать
    // ни action-ов, ни submit-ов на mutating endpoints.
    expect(src).not.toMatch(/action=['"]\/api\//);
    expect(src).not.toMatch(/method=['"]post['"]/i);
    // Никаких слов «исправить»/«fix»/«auto».
    expect(src).not.toMatch(/[Ии]справить/);
    expect(src).not.toMatch(/auto[- ]?fix/i);
  });

  test('shared DTO: есть severity и summary', () => {
    const src = read('packages/shared/src/diagnostics.ts');
    expect(src).toMatch(/DiagnosticSeverity/);
    expect(src).toMatch(/'CRITICAL'/);
    expect(src).toMatch(/'WARNING'/);
    expect(src).toMatch(/DiagnosticConsistencyReportDto/);
    expect(src).toMatch(/summary/);
    expect(src).toMatch(/issues/);
  });
});
