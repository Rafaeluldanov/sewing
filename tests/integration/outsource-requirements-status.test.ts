/**
 * Integration-тесты ручного операционного статуса выполнения внешней
 * потребности заказа (MVP-3 техкарт, ADR-0022 §«Manual execution
 * status»). Описание API см. `docs/api.md §«outsource execution
 * status»`.
 *
 * Покрытие:
 *   A. `OrdersService.start()` создаёт snapshot с
 *      `executionStatus = PLANNED`, `orderedAt = receivedAt = null`,
 *      `displayStatus` собран корректно.
 *   B. CUT_READY + крой не размещён → переход PLANNED → ORDERED
 *      запрещён (`409 OUTSOURCE_NOT_READY_TO_ORDER`).
 *   C. CUT_READY + крой размещён → PLANNED → ORDERED → RECEIVED
 *      проходит, timestamps выставляются.
 *   D. MANUAL → PLANNED → ORDERED доступен сразу, без cut placement.
 *   E. Запрещённые переходы (`PLANNED → RECEIVED`,
 *      `ORDERED → PLANNED`, `RECEIVED → ORDERED`) → 409
 *      `OUTSOURCE_REQUIREMENT_INVALID_TRANSITION`.
 *   F. Идемпотентность: повторный POST с тем же статусом возвращает
 *      200 + `OrderDetailDto`, без побочных эффектов.
 *   G. `getOne()` корректно собирает композитный `displayStatus` /
 *      `displayStatusLabel`.
 *   H. Правка шаблона техкарты после `start()` НЕ перезаписывает
 *      `executionStatus` уже зафиксированных snapshot-строк.
 *
 * Сознательно НЕ покрываем:
 *   - rollback-переходы (их через action нет, см. ADR-0022);
 *   - vendor-directory / purchase orders (вне scope MVP);
 *   - bulk-actions из `/orders` (вне scope MVP).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import {
  loginAs,
  startTestApp,
  stopTestApp,
  type TestApp,
} from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb(
  'integration — outsource requirement execution status (MVP-3, ADR-0022)',
  () => {
    let t: TestApp;
    let seed: SeedResult;
    let cookie: string;

    beforeAll(async () => {
      t = await startTestApp();
    });
    afterAll(async () => {
      await stopTestApp(t);
    });
    beforeEach(async () => {
      await resetDatabase(t.prisma);
      seed = await seedMinimal(t.prisma);
      cookie = loginAs(t, seed.employees['shop-chief']);
    });

    // -------------------------------------------------------------------------
    // A. start() ставит дефолтные значения; getOne() их корректно отдаёт.
    // -------------------------------------------------------------------------
    test('A. start(): executionStatus=PLANNED, orderedAt/receivedAt=null', async () => {
      const tc = await createTechCard({
        outsourceLines: [
          { name: 'Шелкография', unit: 'шт', qtyPerUnit: '1' },
          {
            name: 'Шелкография по крою',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'CUT_READY',
          },
        ],
      });
      const orderId = await createAndStart(tc.id);

      const res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);

      const rows = res.body.outsourceRequirements;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.executionStatus).toBe('PLANNED');
        expect(r.orderedAt).toBeNull();
        expect(r.receivedAt).toBeNull();
      }

      // displayStatus: MANUAL+PLANNED → PLANNED, label=null;
      // CUT_READY+PLANNED+notReady → PLANNED, label="Ожидает размещения кроя".
      const manualRow = rows.find(
        (x: { triggerType: string }) => x.triggerType === 'MANUAL',
      );
      const cutReadyRow = rows.find(
        (x: { triggerType: string }) => x.triggerType === 'CUT_READY',
      );
      expect(manualRow.displayStatus).toBe('PLANNED');
      expect(manualRow.displayStatusLabel).toBeNull();
      expect(cutReadyRow.displayStatus).toBe('PLANNED');
      expect(cutReadyRow.displayStatusLabel).toBe('Ожидает размещения кроя');
    });

    // -------------------------------------------------------------------------
    // B. CUT_READY guard: PLANNED → ORDERED запрещён, пока крой не размещён.
    // -------------------------------------------------------------------------
    test('B. CUT_READY + крой не готов → 409 OUTSOURCE_NOT_READY_TO_ORDER', async () => {
      const tc = await createTechCard({
        outsourceLines: [
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'CUT_READY',
          },
        ],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      const r = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('OUTSOURCE_NOT_READY_TO_ORDER');
    });

    // -------------------------------------------------------------------------
    // C. CUT_READY happy-path: разместили крой → PLANNED → ORDERED → RECEIVED.
    // -------------------------------------------------------------------------
    test('C. CUT_READY + крой готов → PLANNED → ORDERED → RECEIVED', async () => {
      const tc = await createTechCard({
        outsourceLines: [
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'CUT_READY',
          },
        ],
      });
      const orderId = await createAndStartWithSize(tc.id, 1);
      const reqId = await firstOutsourceId(orderId);
      await placeAllPassports(orderId, 1);

      // displayStatus = READY_TO_ORDER теперь
      const ready = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(ready.body.outsourceRequirements[0].displayStatus).toBe(
        'READY_TO_ORDER',
      );

      const t0 = Date.now();
      const ordered = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      const orderedRow = ordered.body.outsourceRequirements[0];
      expect(orderedRow.executionStatus).toBe('ORDERED');
      expect(orderedRow.displayStatus).toBe('ORDERED');
      expect(orderedRow.displayStatusLabel).toBe('Заказано');
      expect(orderedRow.orderedAt).not.toBeNull();
      // timestamp в разумном окне
      const ts = Date.parse(orderedRow.orderedAt as string);
      expect(ts).toBeGreaterThanOrEqual(t0 - 1000);
      expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
      expect(orderedRow.receivedAt).toBeNull();

      const received = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'RECEIVED' })
        .expect(201);
      const receivedRow = received.body.outsourceRequirements[0];
      expect(receivedRow.executionStatus).toBe('RECEIVED');
      expect(receivedRow.displayStatus).toBe('RECEIVED');
      expect(receivedRow.displayStatusLabel).toBe('Получено');
      expect(receivedRow.receivedAt).not.toBeNull();
      // orderedAt НЕ сбрасывается после второго перехода
      expect(receivedRow.orderedAt).toBe(orderedRow.orderedAt);
    });

    // -------------------------------------------------------------------------
    // D. MANUAL → ORDERED доступен сразу, без размещения кроя.
    // -------------------------------------------------------------------------
    test('D. MANUAL + крой не размещён → PLANNED → ORDERED проходит', async () => {
      const tc = await createTechCard({
        outsourceLines: [
          { name: 'Доставка', triggerType: 'MANUAL' },
        ],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      const r = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      expect(r.body.outsourceRequirements[0].executionStatus).toBe('ORDERED');
      expect(r.body.outsourceRequirements[0].displayStatusLabel).toBe(
        'Заказано',
      );
    });

    // -------------------------------------------------------------------------
    // E. Запрещённые переходы.
    // -------------------------------------------------------------------------
    test('E1. PLANNED → RECEIVED запрещено', async () => {
      const tc = await createTechCard({
        outsourceLines: [{ name: 'Доставка', triggerType: 'MANUAL' }],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      const r = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'RECEIVED' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('OUTSOURCE_REQUIREMENT_INVALID_TRANSITION');
    });

    test('E2. RECEIVED → ORDERED запрещено (терминальный статус)', async () => {
      const tc = await createTechCard({
        outsourceLines: [{ name: 'Доставка', triggerType: 'MANUAL' }],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);
      // Дойти до RECEIVED
      await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'RECEIVED' })
        .expect(201);

      const r = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('OUTSOURCE_REQUIREMENT_INVALID_TRANSITION');
    });

    test('E3. ORDERED → PLANNED через action невозможен (Zod-валидация)', async () => {
      // Через action разрешены только 'ORDERED' / 'RECEIVED' (Zod
      // enum), поэтому 'PLANNED' падает на валидации.
      const tc = await createTechCard({
        outsourceLines: [{ name: 'Доставка', triggerType: 'MANUAL' }],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      const r = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'PLANNED' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
    });

    // -------------------------------------------------------------------------
    // F. Идемпотентность.
    // -------------------------------------------------------------------------
    test('F. Идемпотентный повтор: тот же статус → возвращает текущий DTO без изменений', async () => {
      const tc = await createTechCard({
        outsourceLines: [{ name: 'Доставка', triggerType: 'MANUAL' }],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      const first = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      const orderedAt1 = first.body.outsourceRequirements[0].orderedAt;
      expect(orderedAt1).not.toBeNull();

      // Повторяем тот же переход — orderedAt не должен затереться/обновиться.
      const second = await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      expect(second.body.outsourceRequirements[0].executionStatus).toBe(
        'ORDERED',
      );
      expect(second.body.outsourceRequirements[0].orderedAt).toBe(orderedAt1);
    });

    // -------------------------------------------------------------------------
    // G. Композитный displayStatus в getOne() во всех ветках.
    // -------------------------------------------------------------------------
    test('G. getOne(): displayStatus собирается по всем ветвям композиции', async () => {
      const tc = await createTechCard({
        outsourceLines: [
          { name: 'Доставка', triggerType: 'MANUAL' },
          {
            name: 'Шелкография',
            unit: 'шт',
            qtyPerUnit: '1',
            triggerType: 'CUT_READY',
          },
        ],
      });
      const orderId = await createAndStartWithSize(tc.id, 1);

      // 1) Дефолт: MANUAL → PLANNED/null; CUT_READY → PLANNED/«Ожидает».
      let res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      const byTrigger = (rows: any[], trig: string) =>
        rows.find((r) => r.triggerType === trig);
      let manual = byTrigger(res.body.outsourceRequirements, 'MANUAL');
      let cutReady = byTrigger(res.body.outsourceRequirements, 'CUT_READY');
      expect(manual.displayStatus).toBe('PLANNED');
      expect(manual.displayStatusLabel).toBeNull();
      expect(cutReady.displayStatus).toBe('PLANNED');
      expect(cutReady.displayStatusLabel).toBe('Ожидает размещения кроя');

      // 2) Размещаем крой — CUT_READY должен стать READY_TO_ORDER.
      await placeAllPassports(orderId, 1);
      res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      cutReady = byTrigger(res.body.outsourceRequirements, 'CUT_READY');
      expect(cutReady.displayStatus).toBe('READY_TO_ORDER');
      expect(cutReady.displayStatusLabel).toBe('Готово к заказу');

      // 3) Помечаем MANUAL как ORDERED.
      await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${manual.id}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);
      res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      manual = byTrigger(res.body.outsourceRequirements, 'MANUAL');
      expect(manual.displayStatus).toBe('ORDERED');
      expect(manual.displayStatusLabel).toBe('Заказано');

      // 4) Помечаем MANUAL как RECEIVED.
      await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${manual.id}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'RECEIVED' })
        .expect(201);
      res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      manual = byTrigger(res.body.outsourceRequirements, 'MANUAL');
      expect(manual.displayStatus).toBe('RECEIVED');
      expect(manual.displayStatusLabel).toBe('Получено');
    });

    // -------------------------------------------------------------------------
    // H. Edit-after-start: правка шаблона не трогает executionStatus snapshot-а.
    // -------------------------------------------------------------------------
    test('H. PATCH tech-card после start() не сбрасывает executionStatus', async () => {
      const tc = await createTechCard({
        outsourceLines: [{ name: 'Доставка', triggerType: 'MANUAL' }],
      });
      const orderId = await createAndStart(tc.id);
      const reqId = await firstOutsourceId(orderId);

      await request(t.app.getHttpServer())
        .post(
          `/api/orders/${orderId}/outsource-requirements/${reqId}/status`,
        )
        .set('Cookie', cookie)
        .send({ executionStatus: 'ORDERED' })
        .expect(201);

      // Полностью заменяем outsourceLines в шаблоне (full-replace).
      await request(t.app.getHttpServer())
        .patch(`/api/tech-cards/${tc.id}`)
        .set('Cookie', cookie)
        .send({
          outsourceLines: [{ name: 'Совсем другая строка' }],
        })
        .expect(200);

      const res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      // Snapshot заказа продолжает «знать» свою строку и её статус.
      expect(res.body.outsourceRequirements[0].name).toBe('Доставка');
      expect(res.body.outsourceRequirements[0].executionStatus).toBe('ORDERED');
    });

    // -------------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------------

    async function createTechCard(body: {
      outsourceLines: Array<{
        name: string;
        unit?: string | null;
        qtyPerUnit?: string | null;
        vendorName?: string | null;
        note?: string | null;
        triggerType?: 'MANUAL' | 'CUT_READY';
      }>;
    }): Promise<{ id: string }> {
      const code = `TC-EXEC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const r = await request(t.app.getHttpServer())
        .post('/api/tech-cards')
        .set('Cookie', cookie)
        .send({ code, name: code, outsourceLines: body.outsourceLines });
      if (r.status !== 201) {
        throw new Error(
          `createTechCard failed: ${r.status} ${JSON.stringify(r.body)}`,
        );
      }
      return { id: r.body.id };
    }

    async function createAndStart(techCardId: string): Promise<string> {
      return createAndStartWithSize(techCardId, 1);
    }

    async function createAndStartWithSize(
      techCardId: string,
      qtyPlan: number,
    ): Promise<string> {
      const r = await request(t.app.getHttpServer())
        .post('/api/orders')
        .set('Cookie', cookie)
        .send({
          orderDate: '2026-04-15T00:00:00.000Z',
          productId: seed.product.id,
          items: [{ sizeId: seed.sizes.M, qtyPlan }],
          techCardId,
        })
        .expect(201);
      const orderId = r.body.id as string;
      await request(t.app.getHttpServer())
        .post(`/api/orders/${orderId}/start`)
        .set('Cookie', cookie)
        .expect(201);
      return orderId;
    }

    async function firstOutsourceId(orderId: string): Promise<string> {
      const res = await request(t.app.getHttpServer())
        .get(`/api/orders/${orderId}`)
        .set('Cookie', cookie)
        .expect(200);
      return res.body.outsourceRequirements[0].id as string;
    }

    async function placeAllPassports(
      orderId: string,
      qtyPlan: number,
    ): Promise<void> {
      // Создаём по паспорту на каждую единицу плана и кладём в A1.
      for (let i = 0; i < qtyPlan; i += 1) {
        const p = await request(t.app.getHttpServer())
          .post('/api/passports')
          .set('Cookie', cookie)
          .send({
            orderId,
            sizeId: seed.sizes.M,
            rollNumber: `R-${i + 1}`,
            cutDate: '2026-04-15T00:00:00.000Z',
            qtyCut: 1,
            cutterId: seed.employees.cutter.id,
          })
          .expect(201);
        await request(t.app.getHttpServer())
          .post(`/api/passports/${p.body.id}/place`)
          .set('Cookie', cookie)
          .send({ cellId: seed.cells.A1.id })
          .expect(201);
      }
    }
  },
);
