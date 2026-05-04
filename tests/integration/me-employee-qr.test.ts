/**
 * Integration-тест модуля «Мой QR-код сотрудника» (MVP).
 *
 * Проверяем два слоя:
 *
 *   A. HTTP-контур `GET /api/me/employee-qr` через `supertest` —
 *      happy-path, что endpoint реально смонтирован в AppModule,
 *      защищён AuthGuard'ом и отдаёт DTO, валидный по
 *      `EmployeeQrResponseDto` + `EmployeeQrTokenPayloadSchema`.
 *
 *   B. Прямые unit-тесты `MeService.buildEmployeeQr` — для кодов
 *      403 `EMPLOYEE_INACTIVE` и 404 `EMPLOYEE_PROFILE_NOT_FOUND`.
 *      HTTP-уровнем их сложно стрельнуть в чистом виде, потому что
 *      штатный `AuthGuard.resolvePrincipal` уже режет подобные
 *      случаи 401'ым (см. `apps/api/src/modules/auth/auth.service.ts`).
 *      Сервис всё равно обязан иметь явную 403/404-ветку на случай
 *      защиты «изнутри» (другой сервис, cron, интеграция) — что и
 *      проверяется здесь.
 *
 * Контракт — `apps/api/src/modules/me/me.controller.ts`,
 * `apps/api/src/modules/me/me.service.ts`,
 * `apps/api/src/modules/auth/employee-qr-token.ts`,
 * `packages/shared/src/employee-qr.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  EMPLOYEE_QR_PAYLOAD_PREFIX,
  EmployeeQrTokenPayloadSchema,
} from '@sewing/shared/employee-qr';
import { MeService } from '@sewing/api/modules/me/me.service';
import {
  EmployeeInactiveForbiddenException,
  EmployeeProfileNotFoundException,
} from '@sewing/api/common/errors';
import type { AuthPrincipal } from '@sewing/api/modules/auth/auth.types';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — /api/me/employee-qr', () => {
  let t: TestApp;
  let seed: SeedResult;

  beforeAll(async () => {
    t = await startTestApp();
  });

  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
  });

  test('HTTP: авторизованный сотрудник получает корректный DTO', async () => {
    const cookie = loginAs(t, seed.employees['seamstress']!);
    const res = await request(t.app.getHttpServer())
      .get('/api/me/employee-qr')
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.employee.id).toBe(seed.employees['seamstress']!.id);
    expect(res.body.employee.name).toBe('Test Seamstress');
    expect(res.body.employee.role).toBe('SEAMSTRESS');
    expect(res.body.qrPayload.startsWith(EMPLOYEE_QR_PAYLOAD_PREFIX)).toBe(
      true,
    );
    expect(typeof res.body.expiresAt).toBe('string');
    expect(new Date(res.body.expiresAt).getTime() > Date.now()).toBe(true);

    // Payload токена проходит zod-схему (в т.ч. `type: 'EMPLOYEE_QR'`).
    const token = res.body.qrPayload.slice(EMPLOYEE_QR_PAYLOAD_PREFIX.length);
    const body = token.slice(0, token.indexOf('.'));
    const padded = body + '==='.slice((body.length + 3) % 4);
    const json = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const parsed = EmployeeQrTokenPayloadSchema.parse(JSON.parse(json));
    expect(parsed.employeeId).toBe(seed.employees['seamstress']!.id);
    expect(parsed.userId).toBe(seed.employees['seamstress']!.id);

    // Sanity: `MeService.verifyEmployeeQrToken` успешно валидирует тот
    // же токен (подпись + срок + тип).
    const svc = t.app.get(MeService);
    const verified = svc.verifyEmployeeQrToken(token);
    expect(verified).not.toBeNull();
    expect(verified!.employeeId).toBe(seed.employees['seamstress']!.id);
  });

  test('HTTP: 401 UNAUTHENTICATED без cookie', async () => {
    const res = await request(t.app.getHttpServer()).get(
      '/api/me/employee-qr',
    );
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('Service: 403 EMPLOYEE_INACTIVE для деактивированной карточки', async () => {
    const svc = t.app.get(MeService);
    const emp = seed.employees['packer']!;
    await t.prisma.employee.update({
      where: { id: emp.id },
      data: { active: false },
    });
    const principal: AuthPrincipal = {
      employeeId: emp.id,
      role: emp.role,
      login: emp.login,
      fullName: emp.fullName,
    };
    await expect(svc.buildEmployeeQr(principal)).rejects.toBeInstanceOf(
      EmployeeInactiveForbiddenException,
    );
    try {
      await svc.buildEmployeeQr(principal);
    } catch (e) {
      const err = e as EmployeeInactiveForbiddenException;
      expect(err.getStatus()).toBe(403);
      expect((err.getResponse() as { code: string }).code).toBe(
        'EMPLOYEE_INACTIVE',
      );
    }
  });

  test('Service: 404 EMPLOYEE_PROFILE_NOT_FOUND если карточка не существует', async () => {
    const svc = t.app.get(MeService);
    const principal: AuthPrincipal = {
      employeeId: 'non-existent-employee-id',
      role: 'SEAMSTRESS',
      login: 'ghost',
      fullName: 'Ghost',
    };
    await expect(svc.buildEmployeeQr(principal)).rejects.toBeInstanceOf(
      EmployeeProfileNotFoundException,
    );
    try {
      await svc.buildEmployeeQr(principal);
    } catch (e) {
      const err = e as EmployeeProfileNotFoundException;
      expect(err.getStatus()).toBe(404);
      expect((err.getResponse() as { code: string }).code).toBe(
        'EMPLOYEE_PROFILE_NOT_FOUND',
      );
    }
  });

  test('Service: QR-токен не содержит password/session/private data', async () => {
    const svc = t.app.get(MeService);
    const emp = seed.employees['qc']!;
    const principal: AuthPrincipal = {
      employeeId: emp.id,
      role: emp.role,
      login: emp.login,
      fullName: emp.fullName,
    };
    const res = await svc.buildEmployeeQr(principal);
    const token = res.qrPayload.slice(EMPLOYEE_QR_PAYLOAD_PREFIX.length);
    const body = token.slice(0, token.indexOf('.'));
    const padded = body + '==='.slice((body.length + 3) % 4);
    const payloadJson = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const keys = Object.keys(JSON.parse(payloadJson));
    for (const forbidden of [
      'pinHash',
      'passwordHash',
      'password',
      'pin',
      'cookie',
      'session',
      'sessionId',
      'phone',
      'passport',
      'salary',
      'login',
      'fullName',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
