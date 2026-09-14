/**
 * Юнит-тесты упаковочного режима кнопочных строк потребности
 * (`apps/web/app/admin/workshop-needs/button-units.ts`).
 *
 * Аудит движка расчёта 13.09.2026:
 *
 *   - N2-1 (high): любое сохранение кнопочной строки без сохранённого
 *     «Шт/упак» стирало `purchaseQty`/`quotedPrice` — формы выводили
 *     «Упаковок» из штук ÷ packSize, получали пустоту и отправляли её
 *     как «закупщик стёр». Теперь поле уходит только если его тронули
 *     (`packFieldToSubmit`), а режим упаковок включается только при
 *     сохранённом packSize (`isPackMode`).
 *   - N2-13 (low): цена за штуку округлялась до 2 знаков при колонке
 *     Decimal(14,4): 37 ₽/1000 шт → 0.04 (+8 % в смете), 4 ₽/1000 шт →
 *     0 → смета «Цена должна быть > 0». Теперь 4 знака, как у ниток.
 */
import { describe, expect, test } from 'vitest';

import {
  isButtonNeed,
  isPackMode,
  packFieldToSubmit,
  packSizeToSubmit,
  packagesToPieces,
  piecesToPackages,
  pricePerPackToPiece,
  pricePerPieceToPack,
} from '../../apps/web/app/admin/workshop-needs/button-units';

describe('button-units — N2-13: цена за 1 шт с 4 знаками', () => {
  test('37 ₽ за упаковку 1000 шт → 0.037 (а не 0.04)', () => {
    expect(pricePerPackToPiece('37', '1000')).toBe('0.037');
  });

  test('4 ₽ за упаковку 1000 шт → 0.004 (а не 0 — смета бы встала)', () => {
    expect(pricePerPackToPiece('4', '1000')).toBe('0.004');
  });

  test('1000 ₽ за 3000 шт → 0.3333; обратно за упаковку — 999.9 (2 знака для показа)', () => {
    expect(pricePerPackToPiece('1000', '3000')).toBe('0.3333');
    // Отображение «цена за упаковку» остаётся с 2 знаками.
    expect(pricePerPieceToPack('0.3333', '3000')).toBe('999.9');
  });

  test('делящиеся нацело цены — round-trip точный, хвостовые нули срезаны', () => {
    expect(pricePerPackToPiece('150', '100')).toBe('1.5');
    expect(pricePerPackToPiece('100', '10')).toBe('10');
    expect(pricePerPieceToPack('1.5', '100')).toBe('150');
  });

  test('результат проходит Zod-регексп quotedPrice (не более 4 знаков)', () => {
    for (const [price, size] of [
      ['100', '12'],
      ['37', '1000'],
      ['1', '7'],
      ['0.5', '3'],
    ]) {
      expect(pricePerPackToPiece(price, size)).toMatch(/^\d+(\.\d{1,4})?$/);
    }
  });

  test('пустые / нулевые входы → пустая строка', () => {
    expect(pricePerPackToPiece('', '100')).toBe('');
    expect(pricePerPackToPiece('37', '')).toBe('');
    expect(pricePerPackToPiece('37', '0')).toBe('');
    expect(pricePerPackToPiece(null, null)).toBe('');
  });
});

describe('button-units — N2-1: режим упаковок только при сохранённом packSize', () => {
  test('isButtonNeed: PACKAGING + «кнопк» в имени или описании', () => {
    expect(isButtonNeed('PACKAGING', 'Кнопка 15 мм', null)).toBe(true);
    expect(isButtonNeed('PACKAGING', null, 'кнопки пластиковые')).toBe(true);
    expect(isButtonNeed('PACKAGING', 'Молния', null)).toBe(false);
    expect(isButtonNeed('MAIN', 'Кнопка', null)).toBe(false);
  });

  test('без сохранённого packSize кнопочная строка — НЕ в режиме упаковок', () => {
    expect(isPackMode(true, null)).toBe(false);
    expect(isPackMode(true, '')).toBe(false);
    expect(isPackMode(true, '  ')).toBe(false);
  });

  test('с сохранённым packSize — в режиме упаковок; не-кнопки — никогда', () => {
    expect(isPackMode(true, '100')).toBe(true);
    expect(isPackMode(false, '100')).toBe(false);
  });

  test('исходные «Упаковок»/«Цена за упаковку» восстанавливаются из штук и packSize', () => {
    // Сценарий аудита: ERP поставила purchaseQty 1800 шт × 1.5 ₽.
    expect(piecesToPackages('1800', '100')).toBe('18');
    expect(pricePerPieceToPack('1.5', '100')).toBe('150');
    // Без packSize вывести нельзя — именно поэтому режим упаковок выключен.
    expect(piecesToPackages('1800', null)).toBe('');
    expect(pricePerPieceToPack('1.5', null)).toBe('');
  });
});

describe('button-units — N2-1: packFieldToSubmit — поле уходит только если тронули', () => {
  const base = {
    initialValue: '18',
    initialPackSize: '100',
    convert: packagesToPieces,
  };

  test('ничего не трогали → null (поле не отправляется, БД не переписывается)', () => {
    expect(
      packFieldToSubmit({ ...base, value: '18', packSize: '100' }),
    ).toBeNull();
    // Пробелы вокруг не считаются правкой.
    expect(
      packFieldToSubmit({ ...base, value: ' 18 ', packSize: '100 ' }),
    ).toBeNull();
  });

  test('исходное значение пусто (purchaseQty = null) и не трогали → null, а не ""', () => {
    // Раньше здесь уходило '' → backend писал null «ещё раз»; теперь поле
    // вообще не отправляется.
    expect(
      packFieldToSubmit({
        value: '',
        initialValue: '',
        packSize: '100',
        initialPackSize: '100',
        convert: packagesToPieces,
      }),
    ).toBeNull();
  });

  test('закупщик стёр «Упаковок» сам → "" (очистку передаём)', () => {
    expect(
      packFieldToSubmit({ ...base, value: '', packSize: '100' }),
    ).toBe('');
  });

  test('изменили «Упаковок» → поштучное значение', () => {
    expect(
      packFieldToSubmit({ ...base, value: '20', packSize: '100' }),
    ).toBe('2000');
  });

  test('изменили только «Шт/упак» → штуки пересчитываются от прежних упаковок', () => {
    expect(
      packFieldToSubmit({ ...base, value: '18', packSize: '200' }),
    ).toBe('3600');
  });

  test('стёрли «Шт/упак» при заполненных упаковках → null (пересчитать нечем, БД не трогаем)', () => {
    expect(
      packFieldToSubmit({ ...base, value: '18', packSize: '' }),
    ).toBeNull();
  });

  test('цена: тот же контракт через pricePerPackToPiece', () => {
    const price = {
      initialValue: '150',
      initialPackSize: '100',
      convert: pricePerPackToPiece,
    };
    expect(
      packFieldToSubmit({ ...price, value: '150', packSize: '100' }),
    ).toBeNull();
    expect(
      packFieldToSubmit({ ...price, value: '37', packSize: '1000' }),
    ).toBe('0.037');
    expect(packFieldToSubmit({ ...price, value: '', packSize: '100' })).toBe(
      '',
    );
  });

  test('неизменённое округлённое отображение не переписывает точное число в БД', () => {
    // purchaseQty 1000 шт / packSize 3 → «333.3333» упаковок. Закупщик
    // его не трогал → null: в БД остаётся ровно 1000, а не 999.9999.
    const shown = piecesToPackages('1000', '3');
    expect(shown).toBe('333.3333');
    expect(
      packFieldToSubmit({
        value: shown,
        initialValue: shown,
        packSize: '3',
        initialPackSize: '3',
        convert: packagesToPieces,
      }),
    ).toBeNull();
  });
});

describe('button-units — N2-1 (ревью): «Шт/упак» уходит только при изменении', () => {
  test('значение как при загрузке → null (поле не отправляется, trackOptional не видит правки)', () => {
    expect(packSizeToSubmit({ value: '1000', initialValue: '1000' })).toBeNull();
    expect(packSizeToSubmit({ value: ' 1000 ', initialValue: '1000' })).toBeNull();
  });

  test('строка без упаковок, поле пустое и было пустым → null (не null поверх null)', () => {
    expect(packSizeToSubmit({ value: '', initialValue: '' })).toBeNull();
  });

  test('закупщик ввёл «Шт/упак» впервые → значение', () => {
    expect(packSizeToSubmit({ value: '500', initialValue: '' })).toBe('500');
  });

  test('закупщик стёр «Шт/упак» → пустая строка (очистка передаётся)', () => {
    expect(packSizeToSubmit({ value: '', initialValue: '1000' })).toBe('');
  });

  test('изменил значение → новое значение', () => {
    expect(packSizeToSubmit({ value: '2000', initialValue: '1000' })).toBe('2000');
  });
});
