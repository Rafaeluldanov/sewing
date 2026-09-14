/**
 * Регрессия «Аудит движка расчёта 13.09.2026», K9 — завершение заявки
 * конструктору переносит Кулирка/Кашкорсе в поразмерные нормы лекала
 * (`ConstructorTasksService.syncSizeParameterValuesFromTask`).
 *
 * Правила после починки:
 *   - колонка задачи попадает РОВНО в один LINEAR-параметр роли (по label
 *     «Кулирка» / «Кашкорсе», затем по подтипу, иначе первый по sortOrder) —
 *     категория с двумя RIB-параметрами («Рибана» + «Кашкорсе», конфигурация
 *     прод-заказа 02-00015) получает одну норму RIB, потребность цеха по
 *     роли RIB считается один раз;
 *   - заменяются только пары (параметр, размер задачи) с числом: заявка на
 *     существующее лекало по размерам M/L с пустой колонкой «Кашкорсе» не
 *     стирает норму S и не стирает колонку «Кашкорсе» целиком.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';

import { refreshAdminCookie, startTestApp, stopTestApp, type TestApp } from '../utils/app';
import { describeWithDb, resetDatabase } from '../utils/db';
import { seedMinimal, type SeedResult } from '../utils/seed';

interface CategoryWithParams {
  id: string;
  parameters: Array<{ id: string; roleKey: string; label: string; inputType: string }>;
}
interface NeedRow {
  materialRole: string | null;
  sourceName: string | null;
  calculatedQty: string;
  unit: string;
}

describeWithDb('integration — заявка конструктору → поразмерные нормы лекала (K9)', () => {
  let t: TestApp;
  let seed: SeedResult;
  let catCounter = 0;

  beforeAll(async () => {
    t = await startTestApp();
  });
  afterAll(async () => {
    await stopTestApp(t);
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    seed = await seedMinimal(t.prisma);
    await refreshAdminCookie(t);
  });

  const http = () => request(t.app.getHttpServer());

  async function createCategory(
    params: Array<{ roleKey: string; label: string; sortOrder?: number }>,
  ): Promise<CategoryWithParams> {
    catCounter += 1;
    const r = await http()
      .post('/api/pattern-categories')
      .set('Cookie', t.adminCookie)
      .send({
        name: `K9 cat ${catCounter}`,
        iconKey: 'HOODIE',
        parameters: params.map((p) => ({
          roleKey: p.roleKey,
          label: p.label,
          inputType: 'LINEAR_M_BY_SIZE',
          unit: 'м пог.',
          ...(p.sortOrder != null ? { sortOrder: p.sortOrder } : {}),
        })),
      })
      .expect(201);
    return { id: r.body.id, parameters: r.body.parameters };
  }

  function findParam(cat: CategoryWithParams, label: string) {
    const p = cat.parameters.find((x) => x.label === label);
    if (!p) throw new Error(`Параметр "${label}" не найден в категории`);
    return p;
  }

  /** Конструктор (admin допущен ручками) берёт задачу и завершает без файлов. */
  async function assignAndComplete(taskId: string): Promise<void> {
    await http()
      .post(`/api/constructor-tasks/${taskId}/assign-self`)
      .set('Cookie', t.adminCookie)
      .expect(201);
    const done = await http()
      .post(`/api/constructor-tasks/${taskId}/complete`)
      .set('Cookie', t.adminCookie)
      .field('payload', JSON.stringify({ sizeFiles: [] }))
      .expect(201);
    expect(done.body.status).toBe('PENDING_ACCEPT');
  }

  async function accept(taskId: string): Promise<void> {
    const r = await http()
      .post(`/api/constructor-tasks/${taskId}/accept`)
      .set('Cookie', t.adminCookie)
      .expect(201);
    expect(r.body.status).toBe('DONE');
  }

  async function loadValues(patternItemId: string) {
    const rows = await t.prisma.patternItemSizeParameterValue.findMany({
      where: { patternItemId },
      include: { size: { select: { code: true } } },
    });
    return rows.map((r) => ({
      categoryParameterId: r.categoryParameterId,
      roleKey: r.roleKey,
      label: r.labelSnapshot,
      size: r.size.code,
      value: Number(r.value),
    }));
  }

  /** Поток «Отправить конструктору» из /admin/orders/new: DRAFT-лекало + заявка + DRAFT-заказ. */
  async function saveDraftWithOrder(categoryId: string): Promise<{
    taskId: string;
    patternItemId: string;
    orderId: string;
  }> {
    const payload = {
      calcPayload: {
        categoryId,
        sizes: [{ sizeId: seed.sizes.M, qtyPlan: 100, areas: [] }],
      },
      clientId: seed.client.id,
      comment: 'K9',
      sizeRows: [
        { sizeId: seed.sizes.M, sizeCodeSnapshot: 'M', kulirkaMeters: '1.2', kashkorseMeters: '0.3' },
      ],
    };
    const r = await http()
      .post('/api/constructor-tasks?createDraftOrder=true')
      .set('Cookie', t.adminCookie)
      .field('payload', JSON.stringify(payload))
      .expect(201);
    expect(r.body.orderId).toBeTruthy();
    return { taskId: r.body.taskId, patternItemId: r.body.patternItemId, orderId: r.body.orderId };
  }

  async function calculateNeeds(orderId: string): Promise<{ needs: NeedRow[]; warnings: string[] }> {
    const calc = await http()
      .post(`/api/orders/${orderId}/workshop-needs/calculate`)
      .set('Cookie', t.adminCookie)
      .send({})
      .expect(201);
    return { needs: calc.body.needs as NeedRow[], warnings: calc.body.warnings as string[] };
  }

  // ---------------------------------------------------------------------------
  // fan-out: одно число колонки → один параметр роли
  // ---------------------------------------------------------------------------
  test('complete() пишет kashkorseMeters ровно в ОДИН RIB-параметр — по совпадению label', async () => {
    const cat = await createCategory([
      { roleKey: 'MAIN_FABRIC', label: 'Основное полотно' },
      { roleKey: 'RIB', label: 'Рибана' },
      { roleKey: 'RIB', label: 'Кашкорсе' },
    ]);
    const { taskId, patternItemId } = await saveDraftWithOrder(cat.id);
    await assignAndComplete(taskId);

    const values = await loadValues(patternItemId);
    const main = values.filter((v) => v.roleKey === 'MAIN_FABRIC');
    const rib = values.filter((v) => v.roleKey === 'RIB');

    // MAIN_FABRIC: единственный параметр роли — «Основное полотно» получает Кулирку.
    expect(main).toHaveLength(1);
    expect(main[0]!.label).toBe('Основное полотно');
    expect(main[0]!.value).toBeCloseTo(1.2, 4);
    // RIB: колонка «Кашкорсе» → параметр «Кашкорсе» (совпадение label); «Рибана» пуста.
    expect(rib).toHaveLength(1);
    expect(rib[0]!.categoryParameterId).toBe(findParam(cat, 'Кашкорсе').id);
    expect(rib[0]!.value).toBeCloseTo(0.3, 4);
  });

  test('без совпадения label — первый параметр роли по sortOrder, и только он', async () => {
    // Категория без «Кашкорсе» по имени: два RIB-параметра с чужими именами,
    // порядок задан явно — «Пояс» раньше «Манжет».
    const cat = await createCategory([
      { roleKey: 'MAIN_FABRIC', label: 'Кулирка' },
      { roleKey: 'RIB', label: 'Манжеты', sortOrder: 20 },
      { roleKey: 'RIB', label: 'Пояс', sortOrder: 10 },
    ]);
    const { taskId, patternItemId } = await saveDraftWithOrder(cat.id);
    await assignAndComplete(taskId);

    const values = await loadValues(patternItemId);
    const rib = values.filter((v) => v.roleKey === 'RIB');
    expect(rib).toHaveLength(1);
    expect(rib[0]!.categoryParameterId).toBe(findParam(cat, 'Пояс').id);
    expect(values.filter((v) => v.roleKey === 'MAIN_FABRIC')).toHaveLength(1);
  });

  test('потребность цеха по роли RIB после заявки = 0.3 × 100 = 30 м пог., одной строкой', async () => {
    const cat = await createCategory([
      { roleKey: 'MAIN_FABRIC', label: 'Основное полотно' },
      { roleKey: 'RIB', label: 'Рибана' },
      { roleKey: 'RIB', label: 'Кашкорсе' },
    ]);
    const { taskId, orderId } = await saveDraftWithOrder(cat.id);
    await assignAndComplete(taskId);
    await accept(taskId);

    const { needs } = await calculateNeeds(orderId);
    const mainNeeds = needs.filter((n) => n.materialRole === 'MAIN_FABRIC');
    const ribNeeds = needs.filter((n) => n.materialRole === 'RIB');
    expect(mainNeeds).toHaveLength(1);
    expect(Number(mainNeeds[0]!.calculatedQty)).toBeCloseTo(120, 4);
    expect(ribNeeds).toHaveLength(1);
    expect(Number(ribNeeds[0]!.calculatedQty)).toBeCloseTo(30, 4);
  });

  // ---------------------------------------------------------------------------
  // стирание: заявка на существующее лекало — только пары из задачи
  // ---------------------------------------------------------------------------
  async function setupActivePatternWithNorms(): Promise<{
    patternItemId: string;
    mainId: string;
    ribId: string;
  }> {
    const cat = await createCategory([
      { roleKey: 'MAIN_FABRIC', label: 'Основное полотно' },
      { roleKey: 'RIB', label: 'Кашкорсе' },
    ]);
    const main = findParam(cat, 'Основное полотно');
    const rib = findParam(cat, 'Кашкорсе');
    const p = await http()
      .post('/api/patterns')
      .set('Cookie', t.adminCookie)
      .send({ name: 'K9 Футболка базовая', article: `K9-TEE-${catCounter}`, categoryId: cat.id })
      .expect(201);
    const patternItemId = p.body.id as string;
    await http()
      .put(`/api/patterns/${patternItemId}/size-parameter-values`)
      .set('Cookie', t.adminCookie)
      .send({
        values: [
          { categoryParameterId: main.id, sizeId: seed.sizes.S, value: '1.0' },
          { categoryParameterId: main.id, sizeId: seed.sizes.M, value: '1.1' },
          { categoryParameterId: main.id, sizeId: seed.sizes.L, value: '1.2' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.S, value: '0.1' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.M, value: '0.1' },
          { categoryParameterId: rib.id, sizeId: seed.sizes.L, value: '0.1' },
        ],
      })
      .expect(200);
    expect(await loadValues(patternItemId)).toHaveLength(6);
    return { patternItemId, mainId: main.id, ribId: rib.id };
  }

  async function sendExistingPatternToConstructor(patternItemId: string): Promise<string> {
    const r = await http()
      .post('/api/constructor-tasks/for-pattern')
      .set('Cookie', t.adminCookie)
      .field(
        'payload',
        JSON.stringify({
          patternItemId,
          comment: 'K9 уточнить лекало M/L',
          // Строки = размеры ЗАКАЗА (M, L), колонка «Кашкорсе» не тронута.
          sizeRows: [
            { sizeId: seed.sizes.M, sizeCodeSnapshot: 'M', kulirkaMeters: '1.15', kashkorseMeters: null },
            { sizeId: seed.sizes.L, sizeCodeSnapshot: 'L', kulirkaMeters: '1.25', kashkorseMeters: null },
          ],
        }),
      )
      .expect(201);
    return r.body.taskId as string;
  }

  test('заявка на существующее лекало (M, L; Кашкорсе пусто) не стирает норму S и колонку «Кашкорсе»', async () => {
    const { patternItemId, mainId, ribId } = await setupActivePatternWithNorms();
    const taskId = await sendExistingPatternToConstructor(patternItemId);
    await assignAndComplete(taskId);

    const after = await loadValues(patternItemId);
    const mainBySize = Object.fromEntries(
      after.filter((v) => v.categoryParameterId === mainId).map((v) => [v.size, v.value]),
    );
    const ribBySize = Object.fromEntries(
      after.filter((v) => v.categoryParameterId === ribId).map((v) => [v.size, v.value]),
    );
    // Правки заявки применены к M и L…
    expect(mainBySize.M).toBeCloseTo(1.15, 4);
    expect(mainBySize.L).toBeCloseTo(1.25, 4);
    // …норма S, которой в заявке не было, осталась.
    expect(mainBySize.S).toBeCloseTo(1.0, 4);
    // Колонка «Кашкорсе» в заявке пустая → значения лекала не тронуты.
    expect(ribBySize).toEqual({ S: 0.1, M: 0.1, L: 0.1 });
    expect(after).toHaveLength(6);
  });

  test('после такой заявки заказ S×100 получает 100 м пог. полотна и 10 м пог. кашкорсе', async () => {
    const { patternItemId } = await setupActivePatternWithNorms();
    const taskId = await sendExistingPatternToConstructor(patternItemId);
    await assignAndComplete(taskId);
    await accept(taskId);

    const order = await http()
      .post('/api/orders')
      .set('Cookie', t.adminCookie)
      .send({
        orderDate: '2026-04-15T00:00:00.000Z',
        productId: seed.product.id,
        patternItemId,
        color: 'белый',
        items: [{ sizeId: seed.sizes.S, qtyPlan: 100 }],
      })
      .expect(201);

    const { needs } = await calculateNeeds(order.body.id as string);
    const main = needs.filter((n) => n.materialRole === 'MAIN_FABRIC');
    const rib = needs.filter((n) => n.materialRole === 'RIB');
    expect(main).toHaveLength(1);
    expect(Number(main[0]!.calculatedQty)).toBeCloseTo(100, 4);
    expect(rib).toHaveLength(1);
    expect(Number(rib[0]!.calculatedQty)).toBeCloseTo(10, 4);
  });

  test('повторный complete (REWORK) той же заявки идемпотентен — значения не дублируются', async () => {
    const { patternItemId } = await setupActivePatternWithNorms();
    const taskId = await sendExistingPatternToConstructor(patternItemId);
    await assignAndComplete(taskId);
    // Менеджер вернул на доработку, конструктор завершил снова.
    await http()
      .post(`/api/constructor-tasks/${taskId}/rework`)
      .set('Cookie', t.adminCookie)
      .field('payload', JSON.stringify({ comment: 'ещё раз' }))
      .expect(201);
    await assignAndComplete(taskId);
    const after = await loadValues(patternItemId);
    expect(after).toHaveLength(6);
    expect(after.find((v) => v.roleKey === 'MAIN_FABRIC' && v.size === 'M')?.value).toBeCloseTo(1.15, 4);
  });
});
