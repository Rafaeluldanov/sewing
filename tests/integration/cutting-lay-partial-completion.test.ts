/**
 * Integration-тест: частичное завершение раскроя по раскладу
 * (`POST /api/cutting-tasks/:id/lays/:ordinal/complete` / `.../reopen`,
 * merge-сохранение прогресса в `CuttingTasksService.persistProgress`).
 *
 * Контекст. Единица готовности раскроя переехала с задачи на РАСКЛАД:
 * раскройщик закрывает расклад 1 («Расклад готов») и по нему сразу можно
 * выпускать паспорта, пока настилается расклад 2. Задача при этом остаётся
 * `IN_PROGRESS`, а «Раскрой завершён» закрывает всё, что ещё открыто.
 *
 * Почему этот файл критичен. Сохранение прогресса раньше было полным
 * replace (`deleteMany` + create с `ordinal = индекс + 1`), а
 * `Passport.cuttingLayOrdinal` ссылается на номер расклада. С закрытыми
 * раскладами replace означал бы: автосейв формы (он идёт по таймеру)
 * пересоздаёт расклады, и выпущенные паспорта начинают указывать на чужой
 * настил — молча, без единой ошибки. Поэтому сохранение стало merge по
 * `ordinal`, а тесты ниже прибивают именно эти инварианты.
 *
 * Проверяем:
 *   1. Автосейв НЕ трогает закрытый расклад: он остаётся с тем же
 *      `ordinal`, содержимым и `completedAt`.
 *   2. Правка закрытого расклада → 409 `CUTTING_LAY_LOCKED`.
 *   3. Новый расклад получает `ordinal = max + 1` (append-only), номера не
 *      переиспользуются даже после удаления расклада.
 *   4. «Расклад готов» на незаполненном настиле → 400
 *      `CUTTING_LAY_COMPLETION_INCOMPLETE`; закрытие идемпотентно.
 *   5. «Открыть расклад» возвращает его в работу, но только пока по нему
 *      нет паспортов (иначе 409 `CUTTING_LAY_HAS_PASSPORTS`).
 *   6. «Раскрой завершён» закрывает оставшиеся расклады и ставит `DONE`.
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

describeWithDb('integration — partial cutting completion by lay', () => {
  let t: TestApp;
  let seed: SeedResult;
  let cutterCookie: string;
  let orderId: string;
  let taskId: string;
  let sizeId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    cutterCookie = loginAs(t, seed.employees['cutter']);
    sizeId = seed.sizes.M;

    const order = await t.prisma.order.create({
      data: {
        number: `O-LAY-${Math.random().toString(36).slice(2, 8)}`,
        orderDate: new Date(),
        color: seed.product.color,
        status: 'IN_PRODUCTION',
        companyDivisionId: seed.companyDivisions.MARKETPLACE.id,
        items: {
          create: { productId: seed.product.id, sizeId, qtyPlan: 200 },
        },
      },
    });
    orderId = order.id;

    const task = await t.prisma.cuttingTask.create({
      data: {
        orderId: order.id,
        status: 'IN_PROGRESS',
        assignedToId: seed.employees['cutter'].id,
        startedAt: new Date(),
        sizeRows: {
          create: {
            sortOrder: 10,
            sizeId,
            sizeCodeSnapshot: 'M',
            qtyPlan: 200,
          },
        },
      },
    });
    taskId = task.id;
  });

  /** Payload одного расклада: размер M + рулоны. */
  function lay(
    rolls: Array<{ ordinal: number; layers: number }>,
    opts: { ordinal?: number; perLayerQty?: number } = {},
  ) {
    return {
      ...(opts.ordinal != null ? { ordinal: opts.ordinal } : {}),
      laySizes: [{ sizeId, perLayerQty: opts.perLayerQty ?? 2 }],
      rolls,
    };
  }

  function save(lays: unknown[]) {
    return request(t.app.getHttpServer())
      .patch(`/api/cutting-tasks/${taskId}`)
      .set('Cookie', cutterCookie)
      .send({ lays });
  }

  function completeLay(ordinal: number) {
    return request(t.app.getHttpServer())
      .post(`/api/cutting-tasks/${taskId}/lays/${ordinal}/complete`)
      .set('Cookie', cutterCookie);
  }

  function reopenLay(ordinal: number) {
    return request(t.app.getHttpServer())
      .post(`/api/cutting-tasks/${taskId}/lays/${ordinal}/reopen`)
      .set('Cookie', cutterCookie);
  }

  // ---------------------------------------------------------------------------
  // 1–2. Закрытый расклад неприкосновенен
  // ---------------------------------------------------------------------------

  test('автосейв не пересоздаёт закрытый расклад и не меняет его ordinal', async () => {
    // Расклад 1 закрыт, дальше настилаем расклад 2 — как в реальном флоу.
    await save([lay([{ ordinal: 1, layers: 10 }])]).expect(200);
    await completeLay(1).expect(201);

    const before = await t.prisma.cuttingTaskLay.findFirst({
      where: { taskId, ordinal: 1 },
      include: { rolls: true, laySizes: true },
    });
    expect(before?.completedAt).not.toBeNull();

    // Автосейв присылает ТОЛЬКО открытые расклады (так делает форма).
    const r = await save([lay([{ ordinal: 1, layers: 7 }])]).expect(200);

    const after = await t.prisma.cuttingTaskLay.findMany({
      where: { taskId },
      orderBy: { ordinal: 'asc' },
      include: { rolls: true },
    });
    expect(after).toHaveLength(2);
    // Закрытый расклад: тот же id, тот же ordinal, те же слои.
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.ordinal).toBe(1);
    expect(after[0]!.rolls[0]!.layers).toBe(10);
    expect(after[0]!.completedAt).not.toBeNull();
    // Новый расклад получил следующий номер, а не «1».
    expect(after[1]!.ordinal).toBe(2);
    expect(after[1]!.rolls[0]!.layers).toBe(7);
    expect(after[1]!.completedAt).toBeNull();

    // DTO отдаёт закрытость и прогресс выпуска по раскладу.
    const lay1 = r.body.lays.find((l: { ordinal: number }) => l.ordinal === 1);
    expect(lay1).toMatchObject({
      completedAt: expect.any(String),
      completedByName: seed.employees['cutter'].fullName,
      totalPassports: 1,
      releasedPassports: 0,
    });
  });

  test('правка закрытого расклада отвергается (CUTTING_LAY_LOCKED)', async () => {
    await save([lay([{ ordinal: 1, layers: 10 }])]).expect(200);
    await completeLay(1).expect(201);

    const r = await save([lay([{ ordinal: 1, layers: 99 }], { ordinal: 1 })]);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CUTTING_LAY_LOCKED');

    // Настил не изменился.
    const l = await t.prisma.cuttingTaskLay.findFirst({
      where: { taskId, ordinal: 1 },
      include: { rolls: true },
    });
    expect(l!.rolls[0]!.layers).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // 3. Append-only нумерация
  // ---------------------------------------------------------------------------

  test('номера раскладов append-only: не переиспользуются после удаления', async () => {
    // Два открытых расклада.
    const r1 = await save([
      lay([{ ordinal: 1, layers: 5 }]),
      lay([{ ordinal: 1, layers: 6 }]),
    ]).expect(200);
    const ordinals1 = r1.body.lays.map((l: { ordinal: number }) => l.ordinal);
    expect(ordinals1).toEqual([1, 2]);

    // Удаляем второй (форма перестала его присылать) и добавляем новый.
    const r2 = await save([
      lay([{ ordinal: 1, layers: 5 }], { ordinal: 1 }),
      lay([{ ordinal: 1, layers: 8 }]),
    ]).expect(200);
    const ordinals2 = r2.body.lays.map((l: { ordinal: number }) => l.ordinal);
    // Номер 2 освободился, но новый расклад получил 3: `cuttingLayOrdinal`
    // выпущенных паспортов не должен указывать на другой настил.
    expect(ordinals2).toEqual([1, 3]);
  });

  test('обновление существующего расклада не создаёт копию', async () => {
    await save([lay([{ ordinal: 1, layers: 5 }])]).expect(200);
    const r = await save([
      lay([{ ordinal: 1, layers: 12 }], { ordinal: 1, perLayerQty: 3 }),
    ]).expect(200);
    expect(r.body.lays).toHaveLength(1);
    expect(r.body.lays[0].ordinal).toBe(1);
    expect(r.body.lays[0].rolls[0].layers).toBe(12);
    expect(r.body.lays[0].sizes[0].perLayerQty).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // 4. Гейт закрытия
  // ---------------------------------------------------------------------------

  test('«Расклад готов» на незаполненном настиле → 400', async () => {
    // Рулон без слоёв — нечего выпускать.
    await save([lay([{ ordinal: 1, layers: 0 }])]).expect(200);
    const r = await completeLay(1);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTING_LAY_COMPLETION_INCOMPLETE');
    expect(r.body.message).toContain('слои');
  });

  test('закрытие идемпотентно, несуществующий расклад → 404', async () => {
    await save([lay([{ ordinal: 1, layers: 4 }])]).expect(200);
    await completeLay(1).expect(201);
    // Повторный тап по кнопке не должен ругаться.
    const again = await completeLay(1);
    expect(again.status).toBe(201);
    expect(
      again.body.lays.find((l: { ordinal: number }) => l.ordinal === 1)
        .completedAt,
    ).toEqual(expect.any(String));

    const missing = await completeLay(42);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('CUTTING_LAY_NOT_FOUND');
  });

  // ---------------------------------------------------------------------------
  // 5. Переоткрытие
  // ---------------------------------------------------------------------------

  test('открыть расклад можно, пока по нему нет паспортов', async () => {
    await save([lay([{ ordinal: 1, layers: 4 }])]).expect(200);
    await completeLay(1).expect(201);

    const ok = await reopenLay(1);
    expect(ok.status).toBe(201);
    expect(ok.body.lays[0].completedAt).toBeNull();

    // И снова можно править настил.
    await save([lay([{ ordinal: 1, layers: 9 }], { ordinal: 1 })]).expect(200);
  });

  test('расклад с выпущенным паспортом не открывается (CUTTING_LAY_HAS_PASSPORTS)', async () => {
    await save([lay([{ ordinal: 1, layers: 4 }])]).expect(200);
    await completeLay(1).expect(201);

    // Выпускаем паспорт по закрытому раскладу — раскройщик может сам.
    const rel = await request(t.app.getHttpServer())
      .post('/api/passports/release-from-rolls')
      .set('Cookie', cutterCookie)
      .send({
        orderId,
        layOrdinal: 1,
        sizeId,
        cutDate: '2026-09-27T00:00:00.000Z',
        rollOrdinals: [1],
      });
    expect(rel.status).toBe(201);

    const r = await reopenLay(1);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CUTTING_LAY_HAS_PASSPORTS');

    // Расклад остался закрытым, прогресс выпуска виден в карточке.
    const detail = await request(t.app.getHttpServer())
      .get(`/api/cutting-tasks/${taskId}`)
      .set('Cookie', cutterCookie)
      .expect(200);
    expect(detail.body.lays[0]).toMatchObject({
      completedAt: expect.any(String),
      releasedPassports: 1,
      totalPassports: 1,
    });
  });

  // ---------------------------------------------------------------------------
  // 6. «Раскрой завершён» добивает остаток
  // ---------------------------------------------------------------------------

  test('«Раскрой завершён» закрывает оставшиеся расклады и ставит DONE', async () => {
    await save([lay([{ ordinal: 1, layers: 10 }])]).expect(200);
    await completeLay(1).expect(201);
    // Добавляем второй расклад и завершаем раскрой целиком.
    await save([lay([{ ordinal: 1, layers: 5 }])]).expect(200);

    const r = await request(t.app.getHttpServer())
      .post(`/api/cutting-tasks/${taskId}/complete`)
      .set('Cookie', cutterCookie)
      .send({ lays: [lay([{ ordinal: 1, layers: 5 }], { ordinal: 2 })] });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('DONE');
    for (const l of r.body.lays) {
      expect(l.completedAt).toEqual(expect.any(String));
    }

    // Очередь выпуска: раскрой завершён, паспортов ещё нет → NEW.
    const ready = await request(t.app.getHttpServer())
      .get('/api/cutting-tasks/ready-for-release')
      .set('Cookie', cutterCookie)
      .expect(200);
    const row = ready.body.find(
      (o: { orderId: string }) => o.orderId === orderId,
    );
    expect(row).toMatchObject({
      status: 'NEW',
      cuttingInProgress: false,
      laysClosed: 2,
      laysTotal: 2,
    });
  });

  test('все расклады закрыты → «Раскрой завершён» с пустым payload ставит DONE', async () => {
    // Реальный залёт (заказ 02-00002, 30.07): единственный расклад закрыт
    // кнопкой «Расклад готов», форма шлёт пустой `lays` (закрытые она не
    // отправляет — `CUTTING_LAY_LOCKED`). Гейт полноты не должен читать это
    // как «нет ни одного расклада», иначе раскрой не закрыть никогда.
    await save([lay([{ ordinal: 1, layers: 10 }])]).expect(200);
    await completeLay(1).expect(201);

    const r = await request(t.app.getHttpServer())
      .post(`/api/cutting-tasks/${taskId}/complete`)
      .set('Cookie', cutterCookie)
      .send({ lays: [] });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('DONE');
    // Расклад остался один и со своим исходным `completedAt` — «завершить
    // раскрой» не переписывает подпись того, кто закрыл настил.
    expect(r.body.lays).toHaveLength(1);
    expect(r.body.lays[0]).toMatchObject({
      ordinal: 1,
      completedByName: seed.employees['cutter'].fullName,
    });
  });

  test('пустой payload без единого закрытого расклада по-прежнему отвергается', async () => {
    const r = await request(t.app.getHttpServer())
      .post(`/api/cutting-tasks/${taskId}/complete`)
      .set('Cookie', cutterCookie)
      .send({ lays: [] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUTTING_TASK_COMPLETION_INCOMPLETE');
    expect(String(r.body.message)).toContain('нет ни одного расклада');
  });
});
