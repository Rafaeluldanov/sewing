/**
 * Unit-тесты чистого критерия «весь тираж выпущен» —
 * `countReleasePairs` (`apps/api/src/common/cutting-release.ts`).
 *
 * Этот подсчёт — общий источник истины для метки «Завершено» на доске
 * помощника раскройщика (`CuttingTasksService.listReadyForRelease`) и
 * для гейта авто-завершения заказа при упаковке
 * (`PackingService.maybeCompleteOrderOnPack` → `isOrderCuttingFullyReleased`).
 * Именно он защищает заказ от преждевременного и НЕОБРАТИМОГО перехода
 * в `DONE`, когда при инкрементальном порулонном выпуске упакованы лишь
 * первые рулоны, а остаток тиража ещё не выпущен.
 *
 * Ожидаемая тройка = размер с `perLayerQty > 0` × рулон с `layers > 0`.
 * Выпущенная = её ключ `layOrdinal:sizeId:rollOrdinal` есть в releasedSet.
 */
import { expect, test } from 'vitest';

import { countReleasePairs } from '@sewing/api/common/cutting-release';

test('нет раскладов → {0, 0}', () => {
  expect(countReleasePairs([], new Set())).toEqual({
    totalPairs: 0,
    releasedPairs: 0,
  });
});

test('1 расклад × 1 размер × 1 рулон, выпущен → {1, 1}', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [{ sizeId: 'M', perLayerQty: 3 }],
      rolls: [{ ordinal: 1, layers: 5 }],
    },
  ];
  expect(countReleasePairs(lays, new Set(['1:M:1']))).toEqual({
    totalPairs: 1,
    releasedPairs: 1,
  });
});

test('тройка ожидается, но не выпущена → {1, 0}', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [{ sizeId: 'M', perLayerQty: 3 }],
      rolls: [{ ordinal: 1, layers: 5 }],
    },
  ];
  expect(countReleasePairs(lays, new Set())).toEqual({
    totalPairs: 1,
    releasedPairs: 0,
  });
});

test('ГЛАВНЫЙ КЕЙС: 2 рулона, выпущен только первый → {2, 1} (не «завершено»)', () => {
  // Ровно ситуация преждевременного авто-DONE: первый рулон выпущен и
  // упакован, второй ещё не выпущен. releasedPairs < totalPairs ⇒ гейт
  // не даст заказу уйти в DONE.
  const lays = [
    {
      ordinal: 1,
      laySizes: [{ sizeId: 'M', perLayerQty: 3 }],
      rolls: [
        { ordinal: 1, layers: 5 },
        { ordinal: 2, layers: 4 },
      ],
    },
  ];
  const res = countReleasePairs(lays, new Set(['1:M:1']));
  expect(res).toEqual({ totalPairs: 2, releasedPairs: 1 });
  expect(res.releasedPairs >= res.totalPairs).toBe(false);
});

test('оба рулона выпущены → {2, 2} (можно завершать)', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [{ sizeId: 'M', perLayerQty: 3 }],
      rolls: [
        { ordinal: 1, layers: 5 },
        { ordinal: 2, layers: 4 },
      ],
    },
  ];
  const res = countReleasePairs(lays, new Set(['1:M:1', '1:M:2']));
  expect(res).toEqual({ totalPairs: 2, releasedPairs: 2 });
  expect(res.releasedPairs >= res.totalPairs).toBe(true);
});

test('размер с perLayerQty=0 и рулон с layers=0 не считаются ожидаемыми', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [
        { sizeId: 'M', perLayerQty: 3 },
        { sizeId: 'L', perLayerQty: 0 }, // не на настиле — игнор
      ],
      rolls: [
        { ordinal: 1, layers: 5 },
        { ordinal: 2, layers: 0 }, // пустой рулон — игнор
      ],
    },
  ];
  // Ожидается только (M × рулон1) = 1 тройка.
  expect(countReleasePairs(lays, new Set(['1:M:1']))).toEqual({
    totalPairs: 1,
    releasedPairs: 1,
  });
});

test('sizeId=null не даёт ожидаемых троек', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [{ sizeId: null, perLayerQty: 3 }],
      rolls: [{ ordinal: 1, layers: 5 }],
    },
  ];
  expect(countReleasePairs(lays, new Set())).toEqual({
    totalPairs: 0,
    releasedPairs: 0,
  });
});

test('несколько раскладов и размеров: тройки считаются по декартову произведению внутри расклада', () => {
  const lays = [
    {
      ordinal: 1,
      laySizes: [
        { sizeId: 'M', perLayerQty: 3 },
        { sizeId: 'L', perLayerQty: 2 },
      ],
      rolls: [
        { ordinal: 1, layers: 5 },
        { ordinal: 2, layers: 4 },
      ],
    },
    {
      ordinal: 2,
      laySizes: [{ sizeId: 'S', perLayerQty: 1 }],
      rolls: [{ ordinal: 1, layers: 6 }],
    },
  ];
  // Расклад 1: 2 размера × 2 рулона = 4; Расклад 2: 1 × 1 = 1. Итого 5.
  const released = new Set(['1:M:1', '1:M:2', '1:L:1', '2:S:1']); // 4 из 5
  expect(countReleasePairs(lays, released)).toEqual({
    totalPairs: 5,
    releasedPairs: 4,
  });
});
