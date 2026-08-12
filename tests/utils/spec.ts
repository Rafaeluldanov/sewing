/**
 * Хелперы «спецификация материалов номенклатуры» для integration-тестов.
 *
 * Этап 5 плана «техкарты → номенклатура»: справочника техкарт больше нет,
 * состав материалов заказа даёт спецификация карточки номенклатуры
 * (`PatternItemMaterialLine` + `PatternItemSpecParameter`), материализуемая
 * в снимок `OrderMaterialRequirement` при создании/пересборке заказа.
 *
 * Тесты, которые раньше делали `POST /api/tech-cards` + заказ с
 * `techCardId`, теперь создают лекало со спецификацией
 * (`createSpecPattern`) и заказ с `patternItemId`. Если заказу нужно СВОЁ
 * лекало (нормы/площади) — спецификация копируется на него
 * (`copySpecLinesTo`): карточка у заказа одна.
 */
import request from 'supertest';
import type { TestApp } from './app';

export interface SpecLineInput {
  name: string;
  unit: string;
  qtyPerUnit: string;
  normUnit?: string | null;
  note?: string | null;
  materialRole?: string | null;
  fabricType?: string | null;
  densityGsm?: number | null;
  plannedWidthCm?: number | null;
  colorRule?: string | null;
  fixedColorText?: string | null;
  hardwareSizeText?: string | null;
  hardwareMaterialText?: string | null;
  subtypeKey?: string | null;
  characteristics?: Record<string, unknown> | null;
  parameterBindings?: Record<string, string> | null;
}

let __specSeq = 0;

/**
 * Создать активное лекало со спецификацией материалов. Возвращает id
 * карточки — он же играет роль прежнего «id техкарты»: заказ, созданный с
 * `patternItemId = id`, материализует снимок из этих строк.
 */
export async function createSpecPattern(
  t: TestApp,
  cookie: string,
  opts: {
    name?: string;
    article?: string;
    materialLines?: SpecLineInput[];
    parameters?: Array<Record<string, unknown>>;
  },
): Promise<{ id: string }> {
  __specSeq += 1;
  const article =
    opts.article ?? `SPEC-${Date.now().toString(36)}-${__specSeq}`;
  const created = await request(t.app.getHttpServer())
    .post('/api/patterns')
    .set('Cookie', cookie)
    .send({ name: opts.name ?? `Спецификация ${article}`, article })
    .expect(201);
  const patternId = created.body.id as string;
  if (
    (opts.materialLines?.length ?? 0) > 0 ||
    (opts.parameters?.length ?? 0) > 0
  ) {
    await request(t.app.getHttpServer())
      .put(`/api/patterns/${patternId}/material-spec`)
      .set('Cookie', cookie)
      .send({
        materialLines: opts.materialLines ?? [],
        parameters: opts.parameters ?? [],
      })
      .expect(200);
  }
  return { id: patternId };
}

/**
 * Скопировать строки спецификации (и слоты) с одной карточки на другую —
 * для тестов, где заказ должен жить на СВОЁМ лекале (с нормами/площадями),
 * а состав материалов описан отдельно.
 */
export async function copySpecLinesTo(
  t: TestApp,
  fromPatternId: string,
  toPatternId: string,
): Promise<void> {
  const [lines, params] = await Promise.all([
    t.prisma.patternItemMaterialLine.findMany({
      where: { patternItemId: fromPatternId },
      orderBy: { sortOrder: 'asc' },
    }),
    t.prisma.patternItemSpecParameter.findMany({
      where: { patternItemId: fromPatternId },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);
  if (lines.length > 0) {
    await t.prisma.patternItemMaterialLine.createMany({
      data: lines.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => ({
        ...rest,
        characteristics: rest.characteristics ?? undefined,
        parameterBindings: rest.parameterBindings ?? undefined,
        patternItemId: toPatternId,
      })),
    });
  }
  if (params.length > 0) {
    await t.prisma.patternItemSpecParameter.createMany({
      data: params.map(({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => ({
        ...rest,
        options: rest.options ?? undefined,
        patternItemId: toPatternId,
      })),
    });
  }
}
