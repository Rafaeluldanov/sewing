/**
 * Integration-тест фичи «показать пароль сотрудника»
 * (`POST /api/employees/:id/reveal-pin` + поле `pin` в
 * `PATCH /api/employees/:id`, см. `docs/api.md §3b`,
 * `docs/screens.md §10d`, дополнение к ADR-0014).
 *
 * Почему именно integration, а не smoke: фича криптографическая, и
 * source-grep не отвечает на единственный вопрос, который важен —
 * СОВПАДАЕТ ли показанный код с тем, которым реально пускает вход.
 * Здесь это проверяется сквозняком: задали PIN → показали → вошли им.
 *
 * Сценарии:
 *   1. Happy-path: создали сотрудника → reveal отдаёт ровно тот PIN,
 *      что задавали; в БД лежит шифротекст, а не открытый текст.
 *   2. Смена PIN: reveal отдаёт НОВЫЙ код, новым можно войти, старым — нет.
 *   3. Старая карточка (pinEnc = NULL, как у всех, кто заведён до фичи):
 *      `hasStoredPin = false`, reveal отдаёт `pin: null` + NOT_STORED.
 *   4. RBAC: SHOP_MANAGER не может ни посмотреть, ни сменить PIN
 *      ADMIN-учётки (403), но свободно делает это с обычным сотрудником.
 *   5. Утечки: ни `pinHash`, ни `pinEnc` не уезжают в DTO карточки и
 *      списка; в аудит пишется факт без значения.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

// `INTEGRATION_SECRET_KEY` выставляет `tests/utils/db.ts` рядом с
// `JWT_SECRET` — иначе `buildPinColumns` уходит в ветку `NO_KEY`, `pinEnc`
// всегда `null`, и весь сценарий проходит вхолостую, оставаясь зелёным.

describeWithDb('integration — показ пароля сотрудника (reveal-pin)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cookies: Record<string, string>;
  let adminId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);

    const admin = await t.prisma.employee.upsert({
      where: { login: 'pin-admin' },
      create: {
        login: 'pin-admin',
        fullName: 'PIN Admin',
        role: 'ADMIN',
        roles: ['ADMIN'],
        active: true,
        pinHash: await bcrypt.hash('pin-admin-pass', 4),
      },
      update: { active: true, role: 'ADMIN', roles: ['ADMIN'] },
    });
    adminId = admin.id;

    cookies = {
      admin: loginAs(t, {
        id: admin.id,
        login: admin.login,
        role: admin.role,
        fullName: admin.fullName,
      }),
      manager: loginAs(t, seed.employees['shop-chief']),
      seamstress: loginAs(t, seed.employees['seamstress']),
    };
  });

  /** Создаёт сотрудника через API и возвращает его id. */
  async function createEmployee(login: string, pin: string): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.admin)
      .send({
        fullName: `Сотрудник ${login}`,
        login,
        pin,
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  // ---------------------------------------------------------------------------
  // 1. Happy-path
  // ---------------------------------------------------------------------------

  test('показанный PIN совпадает с заданным, а в БД лежит шифротекст', async () => {
    const id = await createEmployee('reveal-1', 'pin-4455');

    const res = await request(t.app.getHttpServer())
      .post(`/api/employees/${id}/reveal-pin`)
      .set('Cookie', cookies.admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ employeeId: id, pin: 'pin-4455' });
    expect(res.body.reason).toBeUndefined();

    // Главное свойство хранения: открытого PIN'а в колонке нет.
    const inDb = await t.prisma.employee.findUnique({ where: { id } });
    expect(inDb!.pinEnc).not.toBeNull();
    expect(inDb!.pinEnc!.startsWith('v1.')).toBe(true);
    expect(inDb!.pinEnc).not.toContain('pin-4455');
    // И вход по-прежнему проверяется bcrypt-хешем, а не этой колонкой.
    expect(inDb!.pinHash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('pin-4455', inDb!.pinHash)).toBe(true);
  });

  test('карточка отдаёт флаг hasStoredPin, но никогда — сам PIN или колонки', async () => {
    const id = await createEmployee('reveal-2', 'pin-4455');

    const card = await request(t.app.getHttpServer())
      .get(`/api/employees/${id}`)
      .set('Cookie', cookies.admin);
    expect(card.status).toBe(200);
    expect(card.body.hasStoredPin).toBe(true);
    expect(card.body.pin).toBeUndefined();
    expect(card.body.pinEnc).toBeUndefined();
    expect(card.body.pinHash).toBeUndefined();

    const list = await request(t.app.getHttpServer())
      .get('/api/employees')
      .set('Cookie', cookies.admin);
    expect(list.status).toBe(200);
    for (const row of list.body) {
      expect(row.pin).toBeUndefined();
      expect(row.pinEnc).toBeUndefined();
      expect(row.pinHash).toBeUndefined();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Смена PIN
  // ---------------------------------------------------------------------------

  test('после смены показывается НОВЫЙ код, и именно он пускает вход', async () => {
    const id = await createEmployee('reveal-3', 'pin-old-1');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/employees/${id}`)
      .set('Cookie', cookies.admin)
      .send({ pin: 'pin-new-2' });
    expect(patch.status).toBe(200);

    // Тот самый баг, ради которого обе колонки пишутся одной функцией:
    // если бы обновился только pinHash, здесь вернулся бы 'pin-old-1'.
    const res = await request(t.app.getHttpServer())
      .post(`/api/employees/${id}/reveal-pin`)
      .set('Cookie', cookies.admin);
    expect(res.body.pin).toBe('pin-new-2');

    const ok = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'reveal-3', password: 'pin-new-2' });
    expect(ok.status).toBe(200);

    const stale = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'reveal-3', password: 'pin-old-1' });
    expect(stale.status).toBe(401);
  });

  test('смена PIN монитора через display-screens тоже не оставляет старый код', async () => {
    // DISPLAY-учётка — обычная строка Employee, видна в карточке
    // сотрудника. У неё свой контроллер, и он тоже обязан писать пару.
    const division = await t.prisma.companyDivision.findFirst();
    const created = await request(t.app.getHttpServer())
      .post('/api/display-screens')
      .set('Cookie', cookies.admin)
      .send({
        name: 'Монитор PIN',
        login: 'ds-pin',
        pin: 'ds-old-1',
        companyDivisionId: division!.id,
        isActive: true,
      });
    expect(created.status).toBe(201);
    const employeeId = created.body.employeeId as string;

    const before = await request(t.app.getHttpServer())
      .post(`/api/employees/${employeeId}/reveal-pin`)
      .set('Cookie', cookies.admin);
    expect(before.body.pin).toBe('ds-old-1');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/display-screens/${created.body.id}`)
      .set('Cookie', cookies.admin)
      .send({ pin: 'ds-new-2' });
    expect(patch.status).toBe(200);

    const after = await request(t.app.getHttpServer())
      .post(`/api/employees/${employeeId}/reveal-pin`)
      .set('Cookie', cookies.admin);
    expect(after.body.pin).toBe('ds-new-2');
  });

  // ---------------------------------------------------------------------------
  // 3. Карточка старше фичи
  // ---------------------------------------------------------------------------

  test('у карточки без обратимой копии показ отвечает NOT_STORED, а не ошибкой', async () => {
    // Ровно то состояние, в котором сейчас все существующие сотрудники:
    // bcrypt-хеш есть, pinEnc пуст, восстановить нечего.
    const legacy = await t.prisma.employee.create({
      data: {
        login: 'legacy-pin',
        fullName: 'Заведён до фичи',
        role: 'SEAMSTRESS',
        roles: ['SEAMSTRESS'],
        active: true,
        pinHash: await bcrypt.hash('legacy-pass', 4),
      },
    });

    const card = await request(t.app.getHttpServer())
      .get(`/api/employees/${legacy.id}`)
      .set('Cookie', cookies.admin);
    expect(card.body.hasStoredPin).toBe(false);

    const res = await request(t.app.getHttpServer())
      .post(`/api/employees/${legacy.id}/reveal-pin`)
      .set('Cookie', cookies.admin);
    // Не 404 и не 500 — это штатный ответ, UI по нему предлагает
    // задать PIN заново.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ pin: null, reason: 'NOT_STORED' });

    // А после смены PIN'а показ начинает работать.
    await request(t.app.getHttpServer())
      .patch(`/api/employees/${legacy.id}`)
      .set('Cookie', cookies.admin)
      .send({ pin: 'legacy-new' })
      .expect(200);
    const after = await request(t.app.getHttpServer())
      .post(`/api/employees/${legacy.id}/reveal-pin`)
      .set('Cookie', cookies.admin);
    expect(after.body.pin).toBe('legacy-new');
  });

  // ---------------------------------------------------------------------------
  // 4. RBAC
  // ---------------------------------------------------------------------------

  test('SHOP_MANAGER не может посмотреть PIN ADMIN-учётки', async () => {
    const res = await request(t.app.getHttpServer())
      .post(`/api/employees/${adminId}/reveal-pin`)
      .set('Cookie', cookies.manager);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMPLOYEE_ADMIN_TARGET_FORBIDDEN');
  });

  test('SHOP_MANAGER не может СМЕНИТЬ PIN ADMIN-учётки (иначе войдёт админом)', async () => {
    const res = await request(t.app.getHttpServer())
      .patch(`/api/employees/${adminId}`)
      .set('Cookie', cookies.manager)
      .send({ pin: 'take-over' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMPLOYEE_ADMIN_TARGET_FORBIDDEN');

    // И пароль админа действительно не тронут.
    const login = await request(t.app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: 'pin-admin', password: 'take-over' });
    expect(login.status).toBe(401);
  });

  test('SHOP_MANAGER не может посмотреть или сменить PIN SUPERADMIN-учётки', async () => {
    // Отдельный кейс, потому что `grantsAdmin(['SUPERADMIN'])` = false:
    // код лежит в SYSTEM_ROLE_CODES, и метод выходит по ветке
    // areAllSystemRoles. Гейты ходят через `isPrivilegedTarget`, и без
    // него самая привилегированная учётка была защищена слабее ADMIN.
    const su = await t.prisma.employee.create({
      data: {
        login: 'pin-superadmin',
        fullName: 'Супер Админ',
        role: 'SUPERADMIN',
        roles: ['SUPERADMIN'],
        active: true,
        pinHash: await bcrypt.hash('su-pass', 4),
      },
    });

    const view = await request(t.app.getHttpServer())
      .post(`/api/employees/${su.id}/reveal-pin`)
      .set('Cookie', cookies.manager);
    expect(view.status).toBe(403);
    expect(view.body.code).toBe('EMPLOYEE_ADMIN_TARGET_FORBIDDEN');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/employees/${su.id}`)
      .set('Cookie', cookies.manager)
      .send({ pin: 'su-taken-over' });
    expect(patch.status).toBe(403);
  });

  test('SHOP_MANAGER не может ЗАВЕСТИ админа — иначе все гейты выше обходятся', async () => {
    // Без этого гейта вся модель угроз показа PIN рушится: менеджер
    // создаёт себе ADMIN-учётку и смотрит пароль кого угодно.
    const res = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Свой Админ',
        login: 'self-made-admin',
        pin: 'pin-escalate',
        role: 'ADMIN',
        compensationType: 'PIECEWORK',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMPLOYEE_ADMIN_TARGET_FORBIDDEN');

    // Карточка действительно не создана — 403 не должен быть «мягким».
    const inDb = await t.prisma.employee.findUnique({
      where: { login: 'self-made-admin' },
    });
    expect(inDb).toBeNull();
  });

  test('ADMIN по-прежнему заводит админов, а менеджер — обычных сотрудников', async () => {
    // Обратная сторона гейта: он не должен ломать штатную работу.
    const byAdmin = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.admin)
      .send({
        fullName: 'Второй Админ',
        login: 'second-admin',
        pin: 'pin-admin-2',
        role: 'ADMIN',
        compensationType: 'PIECEWORK',
      });
    expect(byAdmin.status).toBe(201);

    const byManager = await request(t.app.getHttpServer())
      .post('/api/employees')
      .set('Cookie', cookies.manager)
      .send({
        fullName: 'Обычная Швея',
        login: 'plain-seamstress',
        pin: 'pin-plain-2',
        role: 'SEAMSTRESS',
        compensationType: 'PIECEWORK',
      });
    expect(byManager.status).toBe(201);
  });

  test('SHOP_MANAGER свободно смотрит и меняет PIN обычного сотрудника', async () => {
    const id = await createEmployee('reveal-4', 'pin-plain');

    const view = await request(t.app.getHttpServer())
      .post(`/api/employees/${id}/reveal-pin`)
      .set('Cookie', cookies.manager);
    expect(view.status).toBe(200);
    expect(view.body.pin).toBe('pin-plain');

    const patch = await request(t.app.getHttpServer())
      .patch(`/api/employees/${id}`)
      .set('Cookie', cookies.manager)
      .send({ pin: 'pin-by-manager' });
    expect(patch.status).toBe(200);
  });

  test('рабочая роль не имеет доступа к показу вообще', async () => {
    const id = await createEmployee('reveal-5', 'pin-plain');
    const res = await request(t.app.getHttpServer())
      .post(`/api/employees/${id}/reveal-pin`)
      .set('Cookie', cookies.seamstress);
    expect(res.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 5. Аудит
  // ---------------------------------------------------------------------------

  test('журнал пишет факт просмотра и смены, но не сам PIN', async () => {
    const id = await createEmployee('reveal-6', 'pin-audit');
    await request(t.app.getHttpServer())
      .post(`/api/employees/${id}/reveal-pin`)
      .set('Cookie', cookies.admin)
      .expect(200);
    await request(t.app.getHttpServer())
      .patch(`/api/employees/${id}`)
      .set('Cookie', cookies.admin)
      .send({ pin: 'pin-audit-2' })
      .expect(200);

    const rows = await t.prisma.auditLog.findMany({
      where: { entityType: 'EMPLOYEE', entityId: id },
    });
    const events = rows.map((r) => r.event);
    expect(events).toContain('EMPLOYEE_PIN_VIEWED');
    expect(events).toContain('EMPLOYEE_PIN_CHANGED');

    // Ни один payload не должен содержать открытый PIN — иначе
    // шифрование колонки бессмысленно, журнал читается глазами.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('pin-audit');
    expect(dump).not.toContain('pin-audit-2');
    expect(dump).not.toContain('$2a$');
    expect(dump).not.toContain('$2b$');
  });

  test('неудачный показ (нечего показывать) в журнал не пишется', async () => {
    const legacy = await t.prisma.employee.create({
      data: {
        login: 'legacy-audit',
        fullName: 'Без обратимой копии',
        role: 'SEAMSTRESS',
        roles: ['SEAMSTRESS'],
        active: true,
        pinHash: await bcrypt.hash('legacy-pass', 4),
      },
    });
    await request(t.app.getHttpServer())
      .post(`/api/employees/${legacy.id}/reveal-pin`)
      .set('Cookie', cookies.admin)
      .expect(200);

    const viewed = await t.prisma.auditLog.count({
      where: { entityType: 'EMPLOYEE', entityId: legacy.id, event: 'EMPLOYEE_PIN_VIEWED' },
    });
    expect(viewed).toBe(0);
  });
});
