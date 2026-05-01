/**
 * Smoke-тест health/ready endpoints (MVP 1.1).
 *
 * Скудный, но необходимый: эти endpoints — публичный контракт для
 * nginx/docker liveness/readiness, и любой регресс ломает прод.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import { startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb } from '../utils/db';

describeWithDb('health/ready — smoke (MVP 1.1)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  test('GET /api/health → 200 ok', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.time).toBe('string');
  });

  test('GET /api/ready → 200 ready (БД отвечает)', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});
