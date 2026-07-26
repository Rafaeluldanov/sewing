/**
 * Integration-тесты фичи «Параметры техкарт».
 *
 * Параметр — именованный слот в ЯЧЕЙКЕ строки материала («Полотно → плотность»),
 * значение вводится в ЗАКАЗЕ, по каждой расцветке отдельно. Один шаблон
 * заменяет несколько близнецов ТК-*-160/190/220.
 *
 * Покрытие:
 *   1. Слот материализуется в заказ по расцветкам; значение подставляется в
 *      снимок И В LEGACY-КОЛОНКУ `densityGsm` — именно её читает расчёт
 *      потребности. Параметр, записавший только JSON-характеристику, был бы
 *      виден в UI и молча не влиял бы на закупку.
 *   2. Разные значения по расцветкам → разные плотности в снимке.
 *   3. Гейт полноты СНЯТ (16.07): пустой обязательный слот больше не держит
 *      заказ — ячейка остаётся пустой, расчёт стартует.
 *   4. ФАЗА 2 «техкарта живёт в заказе»: правка шаблона НЕ протекает в заказ,
 *      но количества пересчитываются, а «Обновить из шаблона» подтягивает.
 *   5. Строка, добавленная прямо в заказ, переживает смену техкарты.
 *   6. Решение 16.07: ЛЮБАЯ строка снимка правится (PATCH, включая шаблонные;
 *      правки переживают ресинк; ячейка под параметром — 409) и удаляется
 *      (кроме последней шаблонной — её воскресила бы перематериализация).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { loginAs, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

describeWithDb('integration — параметры техкарт', () => {
  let t: TestApp;
  let seed: SeedResult;
  let manager: string;
  /** Лекало заказа: `startCalculation` требует его первым же гейтом. */
  let patternItemId: string;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    manager = loginAs(t, seed.employees['shop-chief']);
    const pattern = await t.prisma.patternItem.create({
      data: {
        name: 'Худи',
        article: `ART-${Date.now().toString(36)}`,
        status: 'ACTIVE',
      },
    });
    patternItemId = pattern.id;
  });

  /** Шаблон с параметром «плотность», привязанным к ячейке строки полотна. */
  async function createParametricTechCard(opts?: {
    code?: string;
    defaultValue?: string | null;
    qtyPerUnit?: string;
  }): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', manager)
      .send({
        code: opts?.code ?? 'TC-PARAM',
        name: 'Кулирка параметрическая',
        parameters: [
          {
            key: 'main_density',
            label: 'Плотность',
            inputType: 'ENUM',
            options: ['160', '190', '220'],
            unit: 'г/м²',
            isRequired: true,
            ...(opts?.defaultValue === null
              ? {}
              : { defaultValue: opts?.defaultValue ?? '190' }),
          },
        ],
        materialLines: [
          {
            name: 'Полотно',
            unit: 'м2',
            qtyPerUnit: opts?.qtyPerUnit ?? '0.42',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            colorRule: 'ORDER_COLOR',
            parameterBindings: { 'char:density': 'main_density' },
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  /**
   * Заказ с ОДНОЙ расцветкой. Снимок и параметры такого заказа живут
   * order-level группой (`orderVariantId = null`), хотя у расцветки есть
   * реальный id — на этом расхождении и ловился баг «нет техкарты».
   */
  async function createOrderWithOneColorway(techCardId: string): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-14T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        techCardId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          {
            color: 'Белый',
            techCardId,
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  /** Заказ с двумя расцветками на одной техкарте. */
  async function createOrderWithTwoColorways(techCardId: string): Promise<string> {
    const res = await request(t.app.getHttpServer())
      .post('/api/orders')
      .set('Cookie', manager)
      .send({
        orderDate: '2026-07-14T00:00:00.000Z',
        clientId: seed.client.id,
        patternItemId,
        techCardId,
        items: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
        variants: [
          {
            color: 'Белый',
            techCardId,
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 60 }],
          },
          {
            color: 'Чёрный',
            techCardId,
            sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  const snapshot = (orderId: string) =>
    t.prisma.orderMaterialRequirement.findMany({
      where: { orderId },
      orderBy: [{ variantColor: 'asc' }, { sortOrder: 'asc' }],
    });

  test('слот материализуется по расцветкам и подставляется в legacy-колонку', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const params = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);

    expect(params.body.variants).toHaveLength(2);
    for (const v of params.body.variants) {
      expect(v.parameters).toHaveLength(1);
      // Значение по умолчанию из шаблона.
      expect(v.parameters[0].value).toBe('190');
      expect(v.parameters[0].valueSource).toBe('TEMPLATE');
      expect(v.missingRequiredCount).toBe(0);
      // Параметр знает, в какую ячейку он подставляется.
      expect(v.parameters[0].targets[0].field).toBe('char:density');
    }

    const rows = await snapshot(orderId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      // КЛЮЧЕВОЕ: и JSON-характеристика, и legacy-колонка. Downstream
      // (WorkshopNeeds/cut-readiness/себестоимость) читает именно колонку.
      expect(r.densityGsm).toBe(190);
      expect(r.characteristics).toMatchObject({ density: 190 });
      // totalQty = qtyPerUnit × тираж расцветки.
      expect(Number(r.totalQty)).toBeCloseTo(r.variantColor === 'Белый' ? 25.2 : 16.8, 4);
    }
  });

  test('разные значения по расцветкам дают разные плотности в снимке', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const params = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);
    const black = params.body.variants.find(
      (v: { color: string }) => v.color === 'Чёрный',
    );

    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card-parameters/${black.parameters[0].id}`)
      .set('Cookie', manager)
      .send({ value: '220' })
      .expect(200);

    const rows = await snapshot(orderId);
    const byColor = Object.fromEntries(rows.map((r) => [r.variantColor, r.densityGsm]));
    expect(byColor).toEqual({ Белый: 190, Чёрный: 220 });

    // Значение вне списка ENUM отбивается.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card-parameters/${black.parameters[0].id}`)
      .set('Cookie', manager)
      .send({ value: '999' })
      .expect(409);
  });

  test('пустой обязательный слот БОЛЬШЕ НЕ держит заказ (обязательность снята 16.07)', async () => {
    // Раньше здесь ждали 400 ORDER_SPEC_INCOMPLETE. Решение 16.07: заказ,
    // который заводим сами, комплектуем сами — гейт полноты снят (вернётся
    // точечно для позиций из ЕРП по `owner=ERP`, когда появится импорт).
    // Пустой слот просто оставляет ячейку пустой: плотности в снимке нет,
    // но заказ уходит в расчёт.
    const techCardId = await createParametricTechCard({ defaultValue: null });
    const orderId = await createOrderWithTwoColorways(techCardId);

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/start-calculation`)
      .set('Cookie', manager)
      .send({})
      .expect(201);

    const order = await t.prisma.order.findUnique({ where: { id: orderId } });
    expect(order?.status).toBe('CALCULATION');
    // Ячейка под незаполненным параметром остаётся пустой — а не тихо берёт
    // значение из шаблона (семантика «ячейка принадлежит параметру» цела).
    const rows = await snapshot(orderId);
    for (const r of rows) expect(r.densityGsm).toBeNull();
  });

  test('фаза 2: правка шаблона не протекает в заказ, но количества пересчитываются', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);

    const variants = await t.prisma.orderVariant.findMany({
      where: { orderId },
      orderBy: { ordinal: 'asc' },
    });
    const white = variants.find((v) => v.color === 'Белый')!;

    // Шаблон в справочнике изменился.
    await request(t.app.getHttpServer())
      .patch(`/api/tech-cards/${techCardId}`)
      .set('Cookie', manager)
      .send({
        materialLines: [
          {
            name: 'Полотно ПЕРЕИМЕНОВАНО',
            unit: 'м2',
            qtyPerUnit: '0.99',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'двунитка',
            colorRule: 'ORDER_COLOR',
            parameterBindings: { 'char:density': 'main_density' },
          },
        ],
      })
      .expect(200);

    // Пересборка заказа (самый частый путь — правка расцветки).
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${white.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Белый',
        techCardId,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 100 }],
      })
      .expect(200);

    const rows = await snapshot(orderId);
    // Структура НЕ поехала: имя и норма прежние.
    expect(rows.every((r) => r.name === 'Полотно')).toBe(true);
    expect(rows.every((r) => Number(r.qtyPerUnit) === 0.42)).toBe(true);
    // Количества — пересчитаны: 0.42 × 100.
    const whiteRow = rows.find((r) => r.variantColor === 'Белый')!;
    expect(Number(whiteRow.totalQty)).toBeCloseTo(42, 4);

    // Осознанный клапан подтягивает шаблон.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/reload-from-template`)
      .set('Cookie', manager)
      .expect(201);

    const reloaded = await snapshot(orderId);
    expect(reloaded.every((r) => r.name === 'Полотно ПЕРЕИМЕНОВАНО')).toBe(true);
    expect(reloaded.every((r) => Number(r.qtyPerUnit) === 0.99)).toBe(true);
    // Значение параметра пережило перезагрузку — оно живёт в своей таблице.
    expect(reloaded.every((r) => r.densityGsm === 190)).toBe(true);
  });

  test('строка, добавленная в заказе, переживает смену техкарты', async () => {
    const techCardId = await createParametricTechCard();
    const other = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', manager)
      .send({
        code: 'TC-OTHER',
        name: 'Другая',
        materialLines: [
          {
            name: 'Футер',
            unit: 'м2',
            qtyPerUnit: '0.77',
            materialRole: 'MAIN_FABRIC',
            colorRule: 'ORDER_COLOR',
          },
        ],
      })
      .expect(201);
    const orderId = await createOrderWithTwoColorways(techCardId);

    const variants = await t.prisma.orderVariant.findMany({ where: { orderId } });
    const black = variants.find((v) => v.color === 'Чёрный')!;

    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({
        orderVariantId: black.id,
        name: 'Лента усилительная',
        unit: 'м',
        qtyPerUnit: '0.9',
      })
      .expect(201);

    // Тираж ручной строки считается тем же путём: 0.9 × 40.
    let manual = await t.prisma.orderMaterialRequirement.findFirst({
      where: { orderId, isManual: true },
    });
    expect(Number(manual?.totalQty)).toBeCloseTo(36, 4);

    // Смена техкарты расцветки: шаблонная строка заменяется, ручная — нет.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${black.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Чёрный',
        techCardId: other.body.id,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 40 }],
      })
      .expect(200);

    const rows = await snapshot(orderId);
    const blackRows = rows.filter((r) => r.variantColor === 'Чёрный');
    expect(blackRows.map((r) => r.name).sort()).toEqual([
      'Лента усилительная',
      'Футер',
    ]);
    manual = blackRows.find((r) => r.isManual)!;
    expect(manual.name).toBe('Лента усилительная');

    // Решение 16.07: шаблонные строки теперь удаляются, НО не последняя —
    // «строк из шаблона нет» = триггер перематериализации, ресинк тут же
    // вернул бы её молча. У одно-строчной техкарты это ровно этот случай.
    const fromTemplate = blackRows.find((r) => !r.isManual)!;
    const res = await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/tech-card/lines/${fromTemplate.id}`)
      .set('Cookie', manager)
      .expect(409);
    expect(res.body.code).toBe('ORDER_MATERIAL_LAST_TEMPLATE_LINE');
  });

  // Регресс на баг «У этой расцветки нет техкарты — выберите её в блоке
  // Расцветки»: у заказа с ОДНОЙ расцветкой снимок группируется order-level
  // (`orderVariantId = null`), а UI-плитка знает расцветку по реальному id и
  // слал его в записи. Слот/строка улетали в группу, которую чтение не
  // читает → тихо пропадали. Бэкенд нормализует ключ (`resolveSnapshotVariantId`).
  test('одна расцветка: снимок под order-level ключом (null)', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithOneColorway(techCardId);

    const params = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);

    // Ровно одна order-level группа — именно её `resolveVariantParamsGroup`
    // отдаёт по реальному id расцветки на фронте.
    expect(params.body.variants).toHaveLength(1);
    expect(params.body.variants[0].orderVariantId).toBeNull();
    expect(params.body.variants[0].color).toBe('Белый');
    expect(params.body.variants[0].parameters).toHaveLength(1);
  });

  test('одна расцветка: запись с реальным id расцветки нормализуется в снимок', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithOneColorway(techCardId);

    // Реальный id единственной расцветки — как раз его слал старый UI.
    const variant = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId },
    });

    // Ад-хок параметр с id расцветки (а не null): бэкенд обязан положить его
    // в order-level группу, иначе слот тихо исчезнет.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .send({
        orderVariantId: variant.id,
        key: 'adhoc_note',
        label: 'Примечание',
        inputType: 'TEXT',
        isRequired: false,
        value: 'проверка',
        target: null,
      })
      .expect(201);

    // Ручная строка материала — тоже с id расцветки.
    await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/lines`)
      .set('Cookie', manager)
      .send({
        orderVariantId: variant.id,
        name: 'Лента усилительная',
        unit: 'м',
        qtyPerUnit: '0.5',
      })
      .expect(201);

    // Оба легли в order-level группу и ВИДНЫ при чтении (не пропали).
    const after = await request(t.app.getHttpServer())
      .get(`/api/orders/${orderId}/tech-card-parameters`)
      .set('Cookie', manager)
      .expect(200);
    expect(after.body.variants).toHaveLength(1);
    const group = after.body.variants[0];
    expect(group.orderVariantId).toBeNull();
    expect(group.parameters.map((p: { key: string }) => p.key)).toContain(
      'adhoc_note',
    );
    expect(group.lines.map((l: { name: string }) => l.name)).toContain(
      'Лента усилительная',
    );

    // Ад-хок параметр записан под null, а не под id расцветки.
    const stored = await t.prisma.orderTechCardParameter.findFirstOrThrow({
      where: { orderId, key: 'adhoc_note' },
    });
    expect(stored.orderVariantId).toBeNull();
  });

  test('одна расцветка: «сохранить как шаблон» с id расцветки не падает пустотой', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithOneColorway(techCardId);
    const variant = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId },
    });

    // Снимок лежит под null; запрос с реальным id раньше находил 0 строк и
    // отбивался ORDER_TECH_CARD_EMPTY. Нормализация ключа это чинит.
    const res = await request(t.app.getHttpServer())
      .post(`/api/orders/${orderId}/tech-card/save-as-template`)
      .set('Cookie', manager)
      .send({
        orderVariantId: variant.id,
        code: 'TC-FROM-ONE',
        name: 'Из одноцветного заказа',
      })
      .expect(201);
    expect(res.body.materialLines.length).toBeGreaterThan(0);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Решение 16.07 «техкарта живёт в заказе»: ЛЮБАЯ строка снимка (и
  // шаблонная, и ручная) правится и удаляется прямо в заказе.
  // ───────────────────────────────────────────────────────────────────────

  test('PATCH строки: правка нормы/цвета шаблонной строки переживает ресинк; ячейка под параметром — 409', async () => {
    const techCardId = await createParametricTechCard();
    const orderId = await createOrderWithTwoColorways(techCardId);
    const white = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId, color: 'Белый' },
    });
    const row = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, orderVariantId: white.id, isManual: false },
    });

    // Правим норму и цвет шаблонной строки.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card/lines/${row.id}`)
      .set('Cookie', manager)
      .send({ qtyPerUnit: '0.5', colorText: 'графит' })
      .expect(200);

    const edited = await t.prisma.orderMaterialRequirement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(edited.qtyPerUnit.toString()).toBe('0.5');
    // Итог пересчитан единым ресинком: 0.5 × 60 шт Белого.
    expect(edited.totalQty.toString()).toBe('30');
    // Цвет запинен как FIXED_COLOR — иначе пересчёт вывел бы его из
    // colorRule заново и правка тихо откатилась бы.
    expect(edited.colorRule).toBe('FIXED_COLOR');
    expect(edited.resolvedColorText).toBe('графит');

    // Чужой ресинк (правка расцветки) правку НЕ затирает: ветка пересчёта
    // читает собственные значения строки, а не шаблон (Фаза 2).
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${white.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Белый',
        techCardId,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 80 }],
      })
      .expect(200);
    const after = await t.prisma.orderMaterialRequirement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.qtyPerUnit.toString()).toBe('0.5');
    expect(after.totalQty.toString()).toBe('40'); // 0.5 × новый тираж 80
    expect(after.resolvedColorText).toBe('графит');

    // Ячейка «плотность» этой строки привязана к параметру main_density —
    // прямая правка запрещена (два писателя в одну ячейку).
    const res = await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/tech-card/lines/${row.id}`)
      .set('Cookie', manager)
      .send({ densityGsm: 300 })
      .expect(409);
    expect(res.body.code).toBe('ORDER_TECH_CARD_CELL_TAKEN');
  });

  test('DELETE шаблонной строки: удаляется, ресинк не воскрешает; последняя — 409', async () => {
    // Техкарта с ДВУМЯ строками — чтобы после удаления одной шаблонные
    // строки в группе ещё оставались.
    const tcRes = await request(t.app.getHttpServer())
      .post('/api/tech-cards')
      .set('Cookie', manager)
      .send({
        code: 'TC-TWO-LINES',
        name: 'Две строки',
        materialLines: [
          {
            name: 'Полотно',
            unit: 'м2',
            qtyPerUnit: '0.42',
            materialRole: 'MAIN_FABRIC',
            fabricType: 'кулирка',
            colorRule: 'ORDER_COLOR',
          },
          {
            name: 'Рибана',
            unit: 'кг',
            qtyPerUnit: '0.12',
            materialRole: 'RIB',
            fabricType: 'рибана',
            colorRule: 'ORDER_COLOR',
          },
        ],
      })
      .expect(201);
    const techCardId = tcRes.body.id as string;
    const orderId = await createOrderWithTwoColorways(techCardId);
    const white = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId, color: 'Белый' },
    });
    const whiteRows = await t.prisma.orderMaterialRequirement.findMany({
      where: { orderId, orderVariantId: white.id, isManual: false },
      orderBy: { sortOrder: 'asc' },
    });
    expect(whiteRows).toHaveLength(2);

    // Удаляем шаблонную строку «Рибана» у Белого.
    const ribana = whiteRows.find((r) => r.name === 'Рибана')!;
    await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/tech-card/lines/${ribana.id}`)
      .set('Cookie', manager)
      .expect(200);

    // Чужой ресинк НЕ воскрешает удалённую строку: в группе остались
    // шаблонные строки → ветка ПЕРЕСЧЁТА, а не перематериализация.
    await request(t.app.getHttpServer())
      .patch(`/api/orders/${orderId}/colorways/${white.id}`)
      .set('Cookie', manager)
      .send({
        color: 'Белый',
        techCardId,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 70 }],
      })
      .expect(200);
    const namesAfter = (
      await t.prisma.orderMaterialRequirement.findMany({
        where: { orderId, orderVariantId: white.id },
      })
    ).map((r) => r.name);
    expect(namesAfter).toEqual(['Полотно']);
    // У Чёрного обе строки на месте — удаление строго per-variant.
    const black = await t.prisma.orderVariant.findFirstOrThrow({
      where: { orderId, color: 'Чёрный' },
    });
    expect(
      await t.prisma.orderMaterialRequirement.count({
        where: { orderId, orderVariantId: black.id },
      }),
    ).toBe(2);

    // Последняя шаблонная строка группы не удаляется: «строк из шаблона
    // нет» = триггер перематериализации, ресинк тут же вернул бы её молча.
    const last = await t.prisma.orderMaterialRequirement.findFirstOrThrow({
      where: { orderId, orderVariantId: white.id, isManual: false },
    });
    const res = await request(t.app.getHttpServer())
      .delete(`/api/orders/${orderId}/tech-card/lines/${last.id}`)
      .set('Cookie', manager)
      .expect(409);
    expect(res.body.code).toBe('ORDER_MATERIAL_LAST_TEMPLATE_LINE');
  });
});
