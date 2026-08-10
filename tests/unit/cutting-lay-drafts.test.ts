/**
 * Unit-тесты слияния черновиков раскладов с серверными данными
 * (`apps/web/lib/cutting-lay-drafts.ts`).
 *
 * Почему этот файл существует. Форма раскроя держит расклады в локальном
 * стейте, а сервер после каждого действия присылает свою версию. Пока
 * стейт брался из пропсов один раз при монтировании, эти две картины
 * расходились — и 10.08.2026 на прод-заказе 02-00013 это стоило настила:
 *
 *   1. «Открыть расклад» вернул расклад в работу, но форма считала его
 *      закрытым → в payload он не попадал → «Сохранить» его удалило
 *      (тогда backend сносил всё, чего нет в payload);
 *   2. только что созданный расклад остался без `ordinal` → «Раскрой
 *      завершён» завёл его второй раз, копией.
 *
 * Тесты ниже прибивают ровно эти два сценария.
 */
import { describe, expect, test } from 'vitest';
import type { CuttingTaskLayDto } from '../../packages/shared/src/cutting-tasks';
import {
  layFromDto,
  laysSignature,
  mergeServerLays,
  NEW_LAY_META,
  type LayDraft,
} from '../../apps/web/lib/cutting-lay-drafts';

function serverLay(
  ordinal: number,
  opts: {
    id?: string;
    completedAt?: string | null;
    perLayerQty?: number;
    layers?: number;
    releasedPassports?: number;
  } = {},
): CuttingTaskLayDto {
  return {
    id: opts.id ?? `lay-${ordinal}`,
    ordinal,
    sizes: [
      {
        sizeId: 'size-m',
        sizeCodeSnapshot: 'M',
        sortOrder: 1,
        perLayerQty: opts.perLayerQty ?? 2,
      },
    ],
    rolls: [
      {
        id: `roll-${ordinal}-1`,
        ordinal: 1,
        layers: opts.layers ?? 10,
        variantId: null,
        variantColor: null,
      },
    ],
    completedAt: opts.completedAt ?? null,
    completedByName: opts.completedAt ? 'Раскройщик' : null,
    totalPassports: 1,
    releasedPassports: opts.releasedPassports ?? 0,
    reopenDeletesPassports: opts.releasedPassports ?? 0,
    reopenBlockedPassports: [],
    reopenBlockedTotal: 0,
  };
}

function newDraft(key = 'lay-new-1'): LayDraft {
  return { key, ...NEW_LAY_META, sizes: {}, rolls: [] };
}

describe('mergeServerLays', () => {
  test('открытый на сервере расклад перестаёт считаться закрытым (кейс «Открыть расклад»)', () => {
    // Форма загрузилась, когда расклад был закрыт…
    const drafts = [layFromDto(serverLay(1, { completedAt: '2026-08-10T07:00:00.000Z' }))];
    // …а после «Открыть расклад» сервер отдаёт его открытым.
    const merged = mergeServerLays(drafts, [serverLay(1)]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.completedAt).toBeNull();
    expect(merged[0]!.completedByName).toBeNull();
    // Настил на месте: именно его стирало «Сохранить» на рассинхроне.
    expect(merged[0]!.sizes).toEqual({ 'size-m': '2' });
    expect(merged[0]!.rolls.map((r) => r.layers)).toEqual(['10']);
  });

  test('новый расклад забирает номер, выданный сервером (иначе дубль)', () => {
    const draft = { ...newDraft(), sizes: { 'size-m': '3' } };
    const merged = mergeServerLays([draft], [serverLay(2, { perLayerQty: 3 })]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.ordinal).toBe(2);
    // Ключ черновика не меняется — поля ввода не перемонтируются.
    expect(merged[0]!.key).toBe(draft.key);
  });

  test('два новых расклада разбирают номера по порядку', () => {
    const merged = mergeServerLays(
      [newDraft('a'), newDraft('b')],
      [serverLay(3), serverLay(4)],
    );
    expect(merged.map((l) => [l.key, l.ordinal])).toEqual([
      ['a', 3],
      ['b', 4],
    ]);
  });

  test('несохранённые цифры открытого расклада не затираются сервером', () => {
    const drafts = [layFromDto(serverLay(1, { perLayerQty: 2, layers: 10 }))];
    drafts[0]!.sizes = { 'size-m': '5' };
    drafts[0]!.rolls[0]!.layers = '12';

    const merged = mergeServerLays(drafts, [
      serverLay(1, { perLayerQty: 2, layers: 10, releasedPassports: 0 }),
    ]);
    expect(merged[0]!.sizes).toEqual({ 'size-m': '5' });
    expect(merged[0]!.rolls[0]!.layers).toBe('12');
  });

  test('закрытый на сервере расклад показывается строго по серверу', () => {
    // Локально «5» не сохранили, а расклад уже закрыт — он read-only,
    // и на экране должно быть то, что в БД.
    const drafts = [layFromDto(serverLay(1))];
    drafts[0]!.sizes = { 'size-m': '5' };

    const merged = mergeServerLays(drafts, [
      serverLay(1, { completedAt: '2026-08-10T08:00:00.000Z' }),
    ]);
    expect(merged[0]!.completedAt).toBe('2026-08-10T08:00:00.000Z');
    expect(merged[0]!.sizes).toEqual({ 'size-m': '2' });
  });

  test('удалённый на сервере расклад уходит, чужой новый — добавляется в конец', () => {
    const drafts = [layFromDto(serverLay(1)), layFromDto(serverLay(2))];
    const merged = mergeServerLays(drafts, [serverLay(2), serverLay(5)]);
    expect(merged.map((l) => l.ordinal)).toEqual([2, 5]);
  });

  test('пустой сервер и несохранённый черновик: черновик остаётся', () => {
    const draft = { ...newDraft(), sizes: { 'size-m': '4' } };
    expect(mergeServerLays([draft], [])).toEqual([draft]);
  });
});

describe('laysSignature', () => {
  test('меняется при закрытии/открытии расклада и при смене состава', () => {
    const open = laysSignature([serverLay(1)]);
    const closed = laysSignature([
      serverLay(1, { completedAt: '2026-08-10T08:00:00.000Z' }),
    ]);
    const two = laysSignature([serverLay(1), serverLay(2)]);
    expect(open).not.toBe(closed);
    expect(open).not.toBe(two);
    expect(laysSignature([serverLay(1)])).toBe(open);
  });

  test('меняется при выпуске паспорта по раскладу (кнопки зависят от счётчиков)', () => {
    expect(laysSignature([serverLay(1)])).not.toBe(
      laysSignature([serverLay(1, { releasedPassports: 1 })]),
    );
  });
});
