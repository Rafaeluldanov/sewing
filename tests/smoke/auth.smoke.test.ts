/**
 * Smoke-тесты модуля Auth (MVP 1.1).
 *
 * Проверяем минимально-критичный путь:
 *   - login через корректный пароль выдаёт session-cookie;
 *   - неверный пароль → 401 INVALID_CREDENTIALS;
 *   - cookie реально работает на защищённом endpoint (`/auth/me`);
 *   - logout стирает cookie на стороне API.
 *
 * Тесты автоматически skip-аются без `TEST_DATABASE_URL` (см.
 * `tests/utils/db.ts`), поэтому `npm test` на чистой машине успешен.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, TEST_PASSWORD } from '../utils/seed';

describeWithDb('auth — smoke (MVP 1.1)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedMinimal(t.prisma);
  });

  test('POST /auth/login → 200 + Set-Cookie sewing_session', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'shop-chief', password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.login).toBe('shop-chief');
    expect(res.body.user.role).toBe('SHOP_MANAGER');
    const setCookie = res.headers['set-cookie'];
    expect(Array.isArray(setCookie) ? setCookie[0] : setCookie).toMatch(
      /^sewing_session=.+/,
    );
  });

  test('POST /auth/login с неверным паролем → 401 INVALID_CREDENTIALS', async () => {
    const res = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'shop-chief', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('GET /auth/me без cookie → 401 UNAUTHENTICATED', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('GET /auth/me с валидной cookie → 200 user', async () => {
    const login = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'qc', password: TEST_PASSWORD });
    const cookie = (login.headers['set-cookie'] as string[])[0];

    const res = await request(t.app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('QC');
  });

  test('POST /auth/logout — идемпотентно очищает cookie', async () => {
    const res = await request(t.app.getHttpServer()).post('/api/auth/logout');
    expect(res.status).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    // Cookie очищается либо `Max-Age=0`, либо `Expires=` в прошлом
    // (RFC 6265 §3.1, оба варианта валидны и поддерживаются всеми
    // браузерами). Не привязываемся к одному формату.
    expect(header).toMatch(/^sewing_session=;/);
    expect(header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
  });
});
