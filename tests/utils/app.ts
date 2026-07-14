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
import type { PrismaService } from '@sewing/api/prisma/prisma.service';
import { API_PREFIX } from '@sewing/shared/config';
import { SESSION_COOKIE_NAME, serializeCookie } from '@sewing/api/modules/auth/cookie';
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';

export interface TestApp {
  app: INestApplication;
  module: TestingModule;
  prisma: PrismaService;
  auth: AuthService;
  /**
   * Готовая cookie для admin-сессии — кладём в заголовок `Cookie:`.
   *
   * Поле перезаписывается `refreshAdminCookie(t)` после `resetDatabase`,
   * потому что TRUNCATE ON Employee стирает и системного admin'а, и
   * старая cookie начинает возвращать 401 в `AuthGuard.resolvePrincipal`
   * (он тянет Employee из БД). См. `tests/utils/db.ts`.
   */
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

  // ВАЖНО: НЕ берём `PrismaService` из контейнера.
  //
  // После перехода на мультитенантность `PrismaService` — это Proxy, который на
  // каждом обращении требует `TenantContext` и уже подготовленный клиент
  // тенанта (их ставит `TenantResolverMiddleware`). Для HTTP-запросов это
  // работает: supertest идёт через middleware, тенант резолвится (в
  // single-tenant режиме — `default`). Но утилиты тестов (`seedMinimal`,
  // `resetDatabase`, `ensureSystemAdmin`) дёргают Prisma НАПРЯМУЮ, вне запроса —
  // и падали с «TenantContext не установлен».
  //
  // Поэтому тестам даём ПРЯМОЙ клиент к той же БД (`DATABASE_URL` выставлен из
  // `TEST_DATABASE_URL` в `tests/utils/db.ts`). Приложение ходит своим клиентом,
  // тесты — своим; база одна, данные общие.
  const prisma = new PrismaClient() as unknown as PrismaService;
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
  // Прямой клиент тестов — наш, приложение его не закроет.
  await (t.prisma as unknown as PrismaClient).$disconnect().catch(() => undefined);
  await t.app.close();
}

/**
 * Пересоздаёт системного admin'а в БД и обновляет `t.adminCookie` /
 * `t.adminEmployeeId` под новый `Employee.id`.
 *
 * Зачем: `resetDatabase` (см. `tests/utils/db.ts`) делает TRUNCATE
 * по Employee, и admin, выпущенный в `startTestApp`, исчезает. Старая
 * `t.adminCookie` после этого возвращает 401, потому что
 * `AuthGuard.resolvePrincipal` достаёт `Employee` из БД и не находит
 * id из JWT-payload'а. Помощник делает оба шага атомарно: создаёт
 * admin'а заново и переиздаёт cookie. Идемпотентно — можно вызывать
 * в каждом `beforeEach` сразу после `resetDatabase` + `seedMinimal`.
 */
export async function refreshAdminCookie(t: TestApp): Promise<void> {
  const admin = await ensureSystemAdmin(t.prisma);
  const { cookie } = t.auth.issueSession({
    id: admin.id,
    role: admin.role,
    login: admin.login,
    fullName: admin.fullName,
  });
  t.adminCookie = serializeCookie(cookie.name, cookie.value, cookie.attrs);
  t.adminEmployeeId = admin.id;
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
