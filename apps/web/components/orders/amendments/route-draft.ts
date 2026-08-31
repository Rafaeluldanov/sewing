/**
 * Чистая часть холста правки маршрута заказа
 * (`components/orders/amendments/route-amendment-tab.tsx`): модель строки
 * черновика и три преобразования, в которых живут все инварианты
 * параллельных групп.
 *
 * Вынесено из компонента ради unit-тестов: именно здесь был баг, из-за
 * которого правка маршрута любого заказа с параллельной группой ПОЗАДИ
 * фронта производства падала в `409 AMENDMENT_ROUTE_FRONTIER_CHANGED`
 * (`normalizeLinks` сбрасывал связь у замороженных шагов, и снимок уезжал
 * на бэкенд с `parallelGroup: null` в замороженном префиксе).
 *
 * Бэкенд-половина инвариантов — `planRouteAmendment`
 * (`packages/shared/src/amendments.ts`).
 */

import type {
  OperationAmendmentOptionDto,
  OperationAmendmentStepDto,
} from '@sewing/shared';

/** Шаг холста. `key` стабилен на всё время правки (React + фокус). */
export interface DraftStep {
  key: string;
  operationId: string;
  /**
   * Индекс шага в СНИМКЕ маршрута, который продолжает эта строка; `null` —
   * шаг добавлен в этой правке. Идентичность шага — позиция, а не операция:
   * одна операция может стоять в маршруте несколько раз (чередующиеся
   * ОТК/ВТО), и по `operationId` такие шаги неразличимы. Уходит на бэкенд
   * как `sourceIndex` (см. `RouteAmendmentStepSchema`).
   */
  sourceIndex: number | null;
  name: string;
  code: string;
  category: string | null;
  /**
   * «Этот шаг в одной параллельной группе с предыдущим». Храним именно
   * флаг связи, а не номер группы: номер — производная, его пересчёт
   * после каждой перестановки собирается один раз в `toPayloadSteps`.
   */
  linkedWithPrev: boolean;
  /**
   * `parallelGroup` из СНИМКА (`null` — шаг вне группы или новый). Нужен
   * замороженным шагам: бэкенд сверяет префикс до фронта один в один,
   * включая НОМЕР группы, а пересборка номеров из флагов связи вернула бы
   * другой номер (или `null`) и дала бы `AMENDMENT_ROUTE_FRONTIER_CHANGED`
   * на ровном месте. См. `toPayloadSteps`.
   */
  snapshotGroup: number | null;
  rateRub: number | null;
  timeNormSec: number | null;
  /** Шаг заморожен фронтом: не двигается, не удаляется. */
  frozen: boolean;
  /** По операции уже есть выработка — убрать нельзя даже впереди фронта. */
  hasWork: boolean;
  /** Добавлен в этой правке, ещё не сохранён. */
  isNew: boolean;
}

/**
 * Счётчик ключей для шагов, добавленных в этой правке. Именно счётчик, а не
 * `operationId`: одну и ту же операцию можно поставить в маршрут несколько
 * раз, и общий ключ схлопнул бы такие чипы в React в один.
 */
let draftKeySeq = 0;

export function toDraft(
  steps: readonly OperationAmendmentStepDto[],
): DraftStep[] {
  return steps.map((s, i) => ({
    // Ключ по позиции снимка, а не по операции — при повторах операции
    // ключи обязаны различаться.
    key: `step:${s.index}`,
    sourceIndex: s.index,
    operationId: s.operationId,
    name: s.operationName,
    code: s.operationCode,
    category: s.operationCategory,
    linkedWithPrev:
      i > 0 &&
      s.parallelGroup != null &&
      s.parallelGroup === steps[i - 1].parallelGroup,
    snapshotGroup: s.parallelGroup ?? null,
    rateRub: s.rateRub,
    timeNormSec: s.timeNormSec,
    frozen: !s.movable,
    hasWork: s.movable && !s.removable,
    isNew: false,
  }));
}

export function fromOption(op: OperationAmendmentOptionDto): DraftStep {
  draftKeySeq += 1;
  return {
    key: `new:${op.id}:${draftKeySeq}`,
    sourceIndex: null,
    operationId: op.id,
    name: op.name || op.code,
    code: op.code,
    category: op.category,
    linkedWithPrev: false,
    snapshotGroup: null,
    rateRub: op.rateRub,
    timeNormSec: op.timeNormSec,
    frozen: false,
    hasWork: false,
    isNew: true,
  };
}

/**
 * Приведение связей после перестановки/вставки. `minSlot` — количество
 * замороженных шагов, т.е. первая позиция, куда вообще можно что-то
 * положить.
 *
 * Связь «параллельно с предыдущим» может стать невозможной: у первого шага
 * нет предыдущего, а шаг, ПРИЕХАВШИЙ на место сразу за фронтом, связался бы
 * с замороженным — это изменило бы группу замороженного шага.
 *
 * Замороженные шаги (`i < minSlot`) не трогаем вовсе: их связи — часть
 * префикса, который бэкенд сверяет один в один. Сброс «на всякий случай»
 * (`i <= minSlot`) ронял правку любого заказа с параллельной группой позади
 * фронта в `409 AMENDMENT_ROUTE_FRONTIER_CHANGED`.
 *
 * Шаг на позиции `minSlot` сохраняет связь, только если он там и стоял в
 * снимке (`sourceIndex === minSlot`): тогда его группа с замороженным
 * соседом — исходная, а не созданная этой правкой.
 */
export function normalizeLinks(
  rows: readonly DraftStep[],
  minSlot: number,
): DraftStep[] {
  return rows.map((s, i) => {
    if (!s.linkedWithPrev || i < minSlot) return s;
    if (i === 0) return { ...s, linkedWithPrev: false };
    if (i === minSlot && s.sourceIndex !== minSlot) {
      return { ...s, linkedWithPrev: false };
    }
    return s;
  });
}

/**
 * Флаги связи → номера параллельных групп снимка: оба шага пары несут
 * ОДИН `parallelGroup`, цепочка из трёх связанных шагов — одна группа.
 * Это формат `OrderRouteStep.parallelGroup`, который читает enforcement
 * паспортов и доска.
 *
 * ЗАМОРОЖЕННЫЕ шаги отдаём с их номерами ИЗ СНИМКА, а не пересобранными:
 * бэкенд сверяет префикс до фронта один в один, включая номер группы
 * (`planRouteAmendment`), а нумерация «по появлению» совпала бы со снимком
 * только случайно. Новые номера для хвоста поэтому начинаются выше
 * максимального замороженного — иначе две разные группы получили бы один
 * номер.
 */
export function toPayloadSteps(rows: readonly DraftStep[]): {
  operationId: string;
  parallelGroup: number | null;
  sourceIndex: number | null;
}[] {
  const out = rows.map((s) => ({
    operationId: s.operationId,
    parallelGroup: null as number | null,
    // Идентичность шага для бэкенда: какую строку снимка продолжает эта
    // позиция. Без неё повторы операции сопоставились бы по порядку, и
    // per-order расценка/норма могли бы уехать на чужое вхождение.
    sourceIndex: s.sourceIndex,
  }));
  let group = 0;
  rows.forEach((s, i) => {
    if (!s.frozen || s.snapshotGroup == null) return;
    out[i].parallelGroup = s.snapshotGroup;
    group = Math.max(group, s.snapshotGroup);
  });
  rows.forEach((s, i) => {
    if (i === 0 || !s.linkedWithPrev) return;
    // Замороженным номер уже проставлен выше — не перебиваем.
    if (out[i].parallelGroup != null) return;
    if (out[i - 1].parallelGroup == null) {
      group += 1;
      out[i - 1].parallelGroup = group;
    }
    out[i].parallelGroup = out[i - 1].parallelGroup;
  });
  return out;
}
