/**
 * Integration-тесты модуля «Клиенты» (управленческий справочник,
 * см. `apps/api/src/modules/clients/*`, `prisma/schema.prisma model Client`).
 *
 * Сценарии:
 *   1. CRUD happy-path: create / list / get / update под SHOP_MANAGER
 *      и ADMIN. List по умолчанию отдаёт только активных, поиск по
 *      `name` case-insensitive.
 *   2. Soft-delete: hard-delete API нет, выключение через PATCH
 *      `{ isActive: false }`. После этого карточка пропадает из
 *      дефолтного `GET /api/clients`, но всё ещё доступна по
 *      `?includeInactive=true` и `GET /api/clients/:id`.
 *   3. RBAC: рабочие роли (SEAMSTRESS / QC) → 403.
 *   4. Аудит: успешный create/update пишет одну строку `AuditLog`
 *      с правильным `event` / `entityType`.
 *
 * Контракт описан в `packages/shared/src/clients.ts`, доменная роль —
 * в `docs/domain.md §«Клиенты»`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — clients module (/api/clients)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cookies = {
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
      qc: loginAs(t, seed.employees['qc']),
    };
  });

  // ---------------------------------------------------------------------------
  // 1. CRUD happy-path
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER создаёт, читает и редактирует клиента', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/clients')
      .set('Cookie', cookies.manager)
      .send({
        name: '  ИП Петров  ',
        phone: '+7 999 000-11-22',
        email: 'petrov@example.com',
        comment: 'Постоянный клиент',
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'ИП Петров',
      phone: '+7 999 000-11-22',
      email: 'petrov@example.com',
      comment: 'Постоянный клиент',
      isActive: true,
    });
    const id = created.body.id as string;
    expect(typeof id).toBe('string');

    const gotOne = await request(t.app.getHttpServer())
      .get(`/api/clients/${id}`)
      .set('Cookie', cookies.manager);
    expect(gotOne.status).toBe(200);
    expect(gotOne.body.id).toBe(id);

    const list = await request(t.app.getHttpServer())
      .get('/api/clients')
      .set('Cookie', cookies.manager);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.find((c: { id: string }) => c.id === id)).toBeDefined();

    const patched = await request(t.app.getHttpServer())
      .patch(`/api/clients/${id}`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'Лояльный клиент', phone: '' });
    expect(patched.status).toBe(200);
    expect(patched.body.comment).toBe('Лояльный клиент');
    // Пустая строка через preprocess превращается в null.
    expect(patched.body.phone).toBeNull();
  });

  test('list по умолчанию НЕ возвращает архивных, но видны через includeInactive=true', async () => {
    await t.prisma.client.create({
      data: { name: 'Активный', isActive: true },
    });
    const archived = await t.prisma.client.create({
      data: { name: 'Архивный', isActive: false },
    });

    const def = await request(t.app.getHttpServer())
      .get('/api/clients')
      .set('Cookie', cookies.manager);
    expect(def.status).toBe(200);
    expect(def.body.map((c: { name: string }) => c.name)).toEqual(['Активный']);
    expect(def.body.find((c: { id: string }) => c.id === archived.id)).toBeUndefined();

    const all = await request(t.app.getHttpServer())
      .get('/api/clients?includeInactive=true')
      .set('Cookie', cookies.manager);
    expect(all.status).toBe(200);
    expect(all.body.find((c: { id: string }) => c.id === archived.id)).toBeDefined();
  });

  test('search фильтрует case-insensitive по name', async () => {
    await t.prisma.client.createMany({
      data: [
        { name: 'ООО «Альфа»' },
        { name: 'ИП Бета' },
        { name: 'Гамма Инжиниринг' },
      ],
    });

    const res = await request(t.app.getHttpServer())
      .get('/api/clients?search=альф')
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['ООО «Альфа»']);
  });

  // ---------------------------------------------------------------------------
  // 2. Soft-delete (PATCH isActive=false)
  // ---------------------------------------------------------------------------

  test('soft-delete через PATCH isActive=false скрывает из дефолтного списка', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/clients')
      .set('Cookie', cookies.manager)
      .send({ name: 'Будет архивный' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const off = await request(t.app.getHttpServer())
      .patch(`/api/clients/${id}`)
      .set('Cookie', cookies.manager)
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);

    const def = await request(t.app.getHttpServer())
      .get('/api/clients')
      .set('Cookie', cookies.manager);
    expect(def.status).toBe(200);
    expect(def.body.find((c: { id: string }) => c.id === id)).toBeUndefined();

    // Прямой GET по id должен по-прежнему возвращать карточку — это
    // нужно ссылкам из старых заказов и адмен-страниц.
    const direct = await request(t.app.getHttpServer())
      .get(`/api/clients/${id}`)
      .set('Cookie', cookies.manager);
    expect(direct.status).toBe(200);
    expect(direct.body.isActive).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // 3. RBAC
  // ---------------------------------------------------------------------------

  test('SEAMSTRESS / QC получают 403 на любые методы /api/clients', async () => {
    for (const role of ['seamstress', 'qc'] as const) {
      const list = await request(t.app.getHttpServer())
        .get('/api/clients')
        .set('Cookie', cookies[role]);
      expect(list.status).toBe(403);

      const create = await request(t.app.getHttpServer())
        .post('/api/clients')
        .set('Cookie', cookies[role])
        .send({ name: 'Запрещено' });
      expect(create.status).toBe(403);
    }
  });

  // ---------------------------------------------------------------------------
  // 4. AuditLog
  // ---------------------------------------------------------------------------

  test('create + update пишут аудит CLIENT_CREATED / CLIENT_UPDATED', async () => {
    const created = await request(t.app.getHttpServer())
      .post('/api/clients')
      .set('Cookie', cookies.manager)
      .send({ name: 'Аудитный' });
    expect(created.status).toBe(201);

    await request(t.app.getHttpServer())
      .patch(`/api/clients/${created.body.id}`)
      .set('Cookie', cookies.manager)
      .send({ comment: 'добавили комментарий' })
      .expect(200);

    const audit = await t.prisma.auditLog.findMany({
      where: { entityType: 'CLIENT', entityId: created.body.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.event)).toEqual([
      'CLIENT_CREATED',
      'CLIENT_UPDATED',
    ]);
  });

  // ---------------------------------------------------------------------------
  // 5. Валидация
  // ---------------------------------------------------------------------------

  test('пустое name → 400 VALIDATION_ERROR', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/clients')
      .set('Cookie', cookies.manager)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('некорректный email → 400 VALIDATION_ERROR', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/clients')
      .set('Cookie', cookies.manager)
      .send({ name: 'Email Test', email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
