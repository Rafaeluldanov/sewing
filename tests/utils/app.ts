/**
 * Запуск NestJS-приложения в integration-тестах.
 *
 * Поднимаем тот же `AppModule`, что и продовый API: это даёт нам
 * полный pipeline (валидация, AuthGuard, GlobalExceptionFilter), но
 * без HTTP-сервера — обращаемся к нему через `supertest(app.getHttpServer())`.
 *
 * Дополнительно создаём «системного» admin-сотрудника и возвращаем
 * cookie его сессии — это снимает с тестов рутину «пройти login по
 * каждому сценарию». Под отдельные RBAC-проверки можно создавать
 * других пользователей вручную.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { AppModule } from '@sewing/api/app.module';
import { GlobalExceptionFilter } from '@sewing/api/common/global-exception.filter';
import { requestIdMiddleware } from '@sewing/api/common/request-id.middleware';
import { AuthService } from '@sewing/api/modules/auth/auth.service';
import { PrismaService } from '@sewing/api/prisma/prisma.service';
import { API_PREFIX } from '@sewing/shared/config';
import { SESSION_COOKIE_NAME, serializeCookie } from '@sewing/api/modules/auth/cookie';
import bcrypt from 'bcryptjs';
import type { Role } from '@prisma/client';

export interface TestApp {
  app: INestApplication;
  module: TestingModule;
  prisma: PrismaService;
  auth: AuthService;
  /** Готовая cookie для admin-сессии — кладём в заголовок `Cookie:`. */
  adminCookie: string;
  adminEmployeeId: string;
}

export async function startTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({
    logger: false,
  });
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.use(requestIdMiddleware);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();

  const prisma = app.get(PrismaService);
  const auth = app.get(AuthService);

  const admin = await ensureSystemAdmin(prisma);
  const { cookie } = auth.issueSession({
    id: admin.id,
    role: admin.role,
    login: admin.login,
    fullName: admin.fullName,
  });
  const adminCookie = serializeCookie(cookie.name, cookie.value, cookie.attrs);

  return { app, module: moduleRef, prisma, auth, adminCookie, adminEmployeeId: admin.id };
}

export async function stopTestApp(t: TestApp): Promise<void> {
  await t.app.close();
}

/**
 * Создаёт session-cookie для произвольного сотрудника. Используется в
 * RBAC-сценариях («может ли QC-роль вызвать /orders POST?»).
 */
export function loginAs(t: TestApp, employee: { id: string; role: Role; login: string; fullName: string }): string {
  const { cookie } = t.auth.issueSession(employee);
  return serializeCookie(cookie.name, cookie.value, cookie.attrs);
}

export { SESSION_COOKIE_NAME };

async function ensureSystemAdmin(prisma: PrismaService): Promise<{
  id: string;
  role: Role;
  login: string;
  fullName: string;
}> {
  const login = 'test-admin';
  const fullName = 'Test Admin';
  const pinHash = await bcrypt.hash('test-pass', 4);
  const upserted = await prisma.employee.upsert({
    where: { login },
    create: {
      login,
      pinHash,
      fullName,
      role: 'ADMIN',
      paymentType: 'SALARY',
      active: true,
    },
    update: { active: true, role: 'ADMIN', fullName, pinHash },
  });
  return {
    id: upserted.id,
    role: upserted.role,
    login: upserted.login,
    fullName: upserted.fullName,
  };
}
