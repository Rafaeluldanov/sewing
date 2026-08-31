/**
 * Unit-тесты клиентской половины холста правки маршрута
 * (`apps/web/components/orders/amendments/route-draft.ts`) в связке с
 * бэкендной проверкой `planRouteAmendment` (`packages/shared/src/amendments.ts`).
 *
 * Регрессия 31.08.2026 (прод, заказ `02-00023`): маршрут с параллельной
 * группой ПОЗАДИ фронта производства невозможно было сохранить — любая
 * правка хвоста уходила на бэкенд с `parallelGroup: null` у замороженных
 * шагов и получала `409 AMENDMENT_ROUTE_FRONTIER_CHANGED «Шаг 3 уже
 * проходят паспорта»`. Виноват был клиент (`normalizeLinks` сбрасывал
 * связь у ЗАМОРОЖЕННЫХ шагов, а `toPayloadSteps` пересобирал номера групп
 * заново), поэтому тест проверяет именно пару «черновик → payload →
 * planRouteAmendment».
 */

import { describe, expect, it } from 'vitest';
import type { OperationAmendmentStepDto } from '@sewing/shared';
import { planRouteAmendment } from '@sewing/shared/amendments';
import {
  fromOption,
  normalizeLinks,
  toDraft,
  toPayloadSteps,
} from '../../apps/web/components/orders/amendments/route-draft';

/**
 * Маршрут в форме прод-заказа `02-00023`: шаги 2–3 (КИПЕРКА / РАСПОШИВ)
 * стоят в одной параллельной группе и уже позади фронта (паспорта на
 * шаге 4).
 */
const FRONTIER = 4;

function snapshot(): OperationAmendmentStepDto[] {
  const rows: {
    code: string;
    group: number | null;
  }[] = [
    { code: 'CUT', group: null },
    { code: 'SEW', group: null },
    { code: 'KIPER', group: 1 },
    { code: 'RASPOSHIV', group: 1 },
    { code: 'OVERLOCK', group: null },
    { code: 'WTO', group: null },
    { code: 'PACK', group: null },
  ];
  return rows.map((r, index) => ({
    index,
    operationId: `op-${r.code}`,
    operationName: r.code,
    operationCode: r.code,
    operationCategory: 'SEWING',
    parallelGroup: r.group,
    ahead: index > FRONTIER,
    rateRub: null,
    timeNormSec: null,
    movable: index > FRONTIER,
    removable: index > FRONTIER,
  }));
}

const currentSteps = () =>
  snapshot().map((s) => ({
    index: s.index,
    operationId: s.operationId,
    parallelGroup: s.parallelGroup,
  }));

/** Количество замороженных шагов = первая позиция, куда можно класть. */
const MIN_SLOT = FRONTIER + 1;

describe('route-draft: параллельная группа позади фронта', () => {
  it('перестановка в хвосте не трогает замороженный префикс', () => {
    const draft = toDraft(snapshot());
    // Меняем местами два последних шага (оба впереди фронта).
    const rows = draft.slice();
    const [wto] = rows.splice(5, 1);
    rows.splice(6, 0, wto);

    const payload = toPayloadSteps(normalizeLinks(rows, MIN_SLOT));

    // Группа замороженных шагов дошла до бэкенда как в снимке.
    expect(payload.slice(0, 5).map((p) => p.parallelGroup)).toEqual([
      null,
      null,
      1,
      1,
      null,
    ]);

    const planned = planRouteAmendment(currentSteps(), payload, FRONTIER);
    expect(planned.ok).toBe(true);
  });

  it('вставка новой операции в хвост не ломает префикс', () => {
    const draft = toDraft(snapshot());
    const rows = draft.slice();
    rows.splice(6, 0, fromOption({
      id: 'op-QC',
      code: 'QC',
      name: 'ОТК',
      category: 'QC',
      rateRub: null,
      timeNormSec: null,
    }));

    const payload = toPayloadSteps(normalizeLinks(rows, MIN_SLOT));
    const planned = planRouteAmendment(currentSteps(), payload, FRONTIER);
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.plan.addedOperationIds).toEqual(['op-QC']);
    }
  });

  it('номера новых групп не сталкиваются с номерами замороженных', () => {
    const draft = toDraft(snapshot());
    const rows = draft.slice();
    // Связываем два последних шага (впереди фронта) в новую группу.
    rows[6] = { ...rows[6], linkedWithPrev: true };

    const payload = toPayloadSteps(normalizeLinks(rows, MIN_SLOT));
    const frozenGroups = payload.slice(0, 5).map((p) => p.parallelGroup);
    const tailGroup = payload[6].parallelGroup;

    expect(frozenGroups).toEqual([null, null, 1, 1, null]);
    expect(tailGroup).not.toBeNull();
    expect(frozenGroups).not.toContain(tailGroup);
    expect(payload[5].parallelGroup).toBe(tailGroup);

    expect(planRouteAmendment(currentSteps(), payload, FRONTIER).ok).toBe(true);
  });

  it('шаг, приехавший на первую свободную позицию, теряет связь с замороженным', () => {
    const draft = toDraft(snapshot());
    const rows = draft.slice();
    // Тащим последний шаг на позицию сразу за фронтом и связываем с «пред».
    const [pack] = rows.splice(6, 1);
    rows.splice(MIN_SLOT, 0, { ...pack, linkedWithPrev: true });

    const payload = toPayloadSteps(normalizeLinks(rows, MIN_SLOT));
    // Связь сброшена: иначе замороженный шаг 4 получил бы группу.
    expect(payload[MIN_SLOT].parallelGroup).toBeNull();
    expect(payload[FRONTIER].parallelGroup).toBeNull();
    expect(planRouteAmendment(currentSteps(), payload, FRONTIER).ok).toBe(true);
  });
});
