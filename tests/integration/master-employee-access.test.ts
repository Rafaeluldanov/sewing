/**
 * Integration-тесты «участки сотрудника» (11.08.2026):
 *
 *   - режим «Доступы» в кабинете мастера —
 *     `GET/PUT /api/master/employee-stats/access`
 *     (`apps/api/src/modules/master-employee-stats/*`);
 *   - переключение участка сотрудником —
 *     `GET /api/me/workplaces`, `POST /api/me/switch-workplace`
 *     (`apps/api/src/modules/me/*`, `packages/shared/src/workplace.ts`).
 *
 * Ключевые инварианты, ради которых тесты и написаны:
 *
 *   1. Белый список цеховых ролей проверяет СЕРВЕР: мастер не может ни
 *      выдать привилегированную роль, ни отредактировать того, у кого
 *      она уже есть (иначе сохранение набора молча отобрало бы доступ).
 *   2. «Раскройщик + помощник раскройщика» одному человеку запрещены:
 *      выпуск и стеллаж у раскройщика уже во вкладках его кабинета, а
 *      вторая роль ломает ему запирание на `/cutter`.
 *   3. Активный участок сбрасывается, если роль ушла из набора — иначе
 *      сотрудник залипнет на терминале, куда его больше не пускают.
 *   4. Переключаться можно только на НАЗНАЧЕННЫЙ участок, и списком, и
 *      сканом QR рабочего места.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — участки сотрудника (мастер + переключение)', () => {
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
      master: loginAs(t, seed.employees['master']!),
      seamstress: loginAs(t, seed.employees['seamstress']!),
    };
  });

  const api = () => request(t.app.getHttpServer());

  // =========================================================================
  // Режим «Доступы» у мастера
  // =========================================================================

  test('мастер видит список сотрудников с их участками', async () => {
    const res = await api()
      .get('/api/master/employee-stats/access')
      .set('Cookie', cookies['master']!)
      .expect(200);

    const rows = res.body.rows as Array<{
      employeeId: string;
      roles: string[];
      primaryRole: string;
      editable: boolean;
    }>;
    const seamstress = rows.find(
      (r) => r.employeeId === seed.employees['seamstress']!.id,
    );
    expect(seamstress).toBeTruthy();
    expect(seamstress!.roles).toEqual(['SEAMSTRESS']);
    expect(seamstress!.editable).toBe(true);

    // Начальник цеха в списке виден, но мастеру не редактируется.
    const chief = rows.find(
      (r) => r.employeeId === seed.employees['shop-chief']!.id,
    );
    expect(chief?.editable).toBe(false);
  });

  test('мастер добавляет швее участок ВТО', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    const res = await api()
      .put(`/api/master/employee-stats/access/${employeeId}`)
      .set('Cookie', cookies['master']!)
      .send({ roles: ['SEAMSTRESS', 'IRONING'], primaryRole: 'SEAMSTRESS' })
      .expect(200);

    expect(res.body.roles.sort()).toEqual(['IRONING', 'SEAMSTRESS']);
    expect(res.body.primaryRole).toBe('SEAMSTRESS');

    const row = await t.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row!.roles.sort()).toEqual(['IRONING', 'SEAMSTRESS']);
    expect(row!.role).toBe('SEAMSTRESS');
  });

  test('мастер не может выдать роль вне цеха', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    const res = await api()
      .put(`/api/master/employee-stats/access/${employeeId}`)
      .set('Cookie', cookies['master']!)
      .send({
        roles: ['SEAMSTRESS', 'SHOP_MANAGER'],
        primaryRole: 'SEAMSTRESS',
      })
      .expect(403);
    expect(res.body.code).toBe('MASTER_ROLE_NOT_ASSIGNABLE');

    const row = await t.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row!.roles).not.toContain('SHOP_MANAGER');
  });

  test('мастер не редактирует сотрудника с доступами вне цеха', async () => {
    const employeeId = seed.employees['shop-chief']!.id;
    const res = await api()
      .put(`/api/master/employee-stats/access/${employeeId}`)
      .set('Cookie', cookies['master']!)
      .send({ roles: ['SEAMSTRESS'], primaryRole: 'SEAMSTRESS' })
      .expect(403);
    expect(res.body.code).toBe('MASTER_EMPLOYEE_NOT_EDITABLE');

    const row = await t.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row!.role).toBe('SHOP_MANAGER');
  });

  test('раскройщику не выдать участок помощника раскройщика', async () => {
    const employeeId = seed.employees['cutter']!.id;
    const res = await api()
      .put(`/api/master/employee-stats/access/${employeeId}`)
      .set('Cookie', cookies['master']!)
      .send({
        roles: ['CUTTER', 'CUTTER_ASSISTANT'],
        primaryRole: 'CUTTER',
      })
      .expect(409);
    expect(res.body.code).toBe('MASTER_ROLE_PAIR_REDUNDANT');
  });

  test('снятый участок сбрасывает активный участок сотрудника', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    await t.prisma.employee.update({
      where: { id: employeeId },
      data: { roles: ['SEAMSTRESS', 'IRONING'], activeRole: 'IRONING' },
    });

    await api()
      .put(`/api/master/employee-stats/access/${employeeId}`)
      .set('Cookie', cookies['master']!)
      .send({ roles: ['SEAMSTRESS'], primaryRole: 'SEAMSTRESS' })
      .expect(200);

    const row = await t.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row!.activeRole).toBeNull();
  });

  test('швея не может править доступы', async () => {
    await api()
      .put(`/api/master/employee-stats/access/${seed.employees['qc']!.id}`)
      .set('Cookie', cookies['seamstress']!)
      .send({ roles: ['QC'], primaryRole: 'QC' })
      .expect(403);
  });

  test('набор не может остаться пустым', async () => {
    await api()
      .put(`/api/master/employee-stats/access/${seed.employees['seamstress']!.id}`)
      .set('Cookie', cookies['master']!)
      .send({ roles: [], primaryRole: 'SEAMSTRESS' })
      .expect(400);
  });

  // =========================================================================
  // Переключение участка сотрудником
  // =========================================================================

  test('сотрудник видит свои участки списком', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    await t.prisma.employee.update({
      where: { id: employeeId },
      data: { roles: ['SEAMSTRESS', 'IRONING'] },
    });

    const res = await api()
      .get('/api/me/workplaces')
      .set('Cookie', cookies['seamstress']!)
      .expect(200);

    const roles = (res.body.workplaces as Array<{ role: string }>).map(
      (w) => w.role,
    );
    expect(roles.sort()).toEqual(['IRONING', 'SEAMSTRESS']);
    const current = (
      res.body.workplaces as Array<{ role: string; current: boolean }>
    ).find((w) => w.current);
    // Ни разу не переключался — текущий участок равен основной роли.
    expect(current?.role).toBe('SEAMSTRESS');
    // Название приходит из справочника ролей, а не кодом.
    expect(
      (res.body.workplaces as Array<{ role: string; label: string }>).find(
        (w) => w.role === 'IRONING',
      )?.label,
    ).toBe('ВТО');
  });

  test('переключение выбором участка из списка', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    await t.prisma.employee.update({
      where: { id: employeeId },
      data: { roles: ['SEAMSTRESS', 'IRONING'] },
    });

    const res = await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({ role: 'IRONING' })
      .expect(200);

    expect(res.body.role).toBe('IRONING');
    // Конкретное рабочее место не называлось — оборудования в ответе нет.
    expect(res.body.equipmentId).toBeNull();

    const row = await t.prisma.employee.findUnique({ where: { id: employeeId } });
    expect(row!.activeRole).toBe('IRONING');
  });

  test('на чужой участок переключиться нельзя', async () => {
    const res = await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({ role: 'QC' })
      .expect(403);
    expect(res.body.code).toBe('WORKPLACE_ROLE_FORBIDDEN');
  });

  test('нужен ровно один из code/role', async () => {
    await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({})
      .expect(400);
    await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({ role: 'IRONING', code: 'equipment:whatever' })
      .expect(400);
  });

  test('переключение сканом QR рабочего места по-прежнему работает', async () => {
    const employeeId = seed.employees['seamstress']!.id;
    await t.prisma.employee.update({
      where: { id: employeeId },
      data: { roles: ['SEAMSTRESS', 'IRONING'] },
    });
    const equipment = await t.prisma.equipment.create({
      data: {
        code: 'wto-table-01',
        name: 'Стол ВТО',
        displayNumber: '9',
        qrCode: 'equipment-pending:wto-table-01',
        active: true,
        role: 'IRONING',
      },
    });

    const res = await api()
      .post('/api/me/switch-workplace')
      .set('Cookie', cookies['seamstress']!)
      .send({ code: `equipment:${equipment.id}` })
      .expect(200);

    expect(res.body.role).toBe('IRONING');
    expect(res.body.equipmentId).toBe(equipment.id);
    expect(res.body.equipmentName).toBe('Стол ВТО');
  });
});
