'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { ReleaseRollDto, ReleaseSizeDto } from '@sewing/shared/cutting-tasks';
import type { ReleasedPassportLiteDto } from '@sewing/shared/passports';
import { PrintButton } from '@/components/print-button';
import { buildPassportPrintPath } from '@/lib/browser-api-paths';
import { releaseFromRollsAction } from '../actions';

interface Props {
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizes: ReleaseSizeDto[];
  rolls: ReleaseRollDto[];
  /** Уже выпущенные пары `(размер, рулон)`. */
  released: Array<{ sizeId: string; ordinal: number }>;
  today: string;
  disabled: boolean;
}

interface SuccessState {
  created: ReleasedPassportLiteDto[];
  skipped: number[];
}

/**
 * Рулонный выпуск паспортов помощником раскройщика.
 *
 * Помощник ничего не вводит руками: размеры и рулоны приходят из
 * завершённой задачи раскройщика. Он выбирает размер, отмечает рулоны
 * («Выбрать все» или по одному — кейс «сломался принтер, продолжить с
 * нужного рулона») и жмёт «Выпустить паспорт». Количество на каждый
 * рулон = `слои рулона × раскладка размера на настиле` — считается и
 * показывается тут же, но окончательно его проставляет backend.
 *
 * Уже выпущенные пары `(размер, рулон)` помечены «выпущено» и не
 * выбираются повторно.
 */
export function CutterAssistantRollForm({
  orderId,
  orderNumber,
  productName,
  color,
  sizes,
  rolls,
  released,
  today,
  disabled,
}: Props) {
  const router = useRouter();
  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );
  const [sizeId, setSizeId] = useState<string>(
    () => sortedSizes[0]?.sizeId ?? '',
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [pending, startTransition] = useTransition();

  const selectedSize = sortedSizes.find((s) => s.sizeId === sizeId);
  const perLayerQty = selectedSize?.perLayerQty ?? 0;

  // Уже выпущенные рулоны для выбранного размера.
  const releasedForSize = useMemo(() => {
    const set = new Set<number>();
    for (const r of released) {
      if (r.sizeId === sizeId) set.add(r.ordinal);
    }
    return set;
  }, [released, sizeId]);

  // Рулоны, которые сейчас можно выпустить по выбранному размеру:
  // ещё не выпущены и дают положительное количество.
  const releasableOrdinals = useMemo(
    () =>
      rolls
        .filter((r) => !releasedForSize.has(r.ordinal) && r.layers * perLayerQty > 0)
        .map((r) => r.ordinal),
    [rolls, releasedForSize, perLayerQty],
  );

  // Смена размера сбрасывает выбор: набор выпущенных и количества другие.
  useEffect(() => {
    setSelected(new Set());
    setError(null);
  }, [sizeId]);

  const toggleRoll = (ordinal: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  };

  const allSelected =
    releasableOrdinals.length > 0 &&
    releasableOrdinals.every((o) => selected.has(o));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(releasableOrdinals));
  };

  const selectedQty = rolls.reduce(
    (acc, r) => acc + (selected.has(r.ordinal) ? r.layers * perLayerQty : 0),
    0,
  );

  const handleRelease = () => {
    if (selected.size === 0) return;
    setError(null);
    startTransition(async () => {
      const res = await releaseFromRollsAction(orderId, {
        sizeId,
        cutDate: today,
        rollOrdinals: [...selected],
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSuccess({ created: res.created ?? [], skipped: res.skipped ?? [] });
    });
  };

  // ---- Успешный выпуск: список паспортов с печатью ------------------------
  if (success) {
    return (
      <div className="card">
        <div className="success-box">
          <strong>
            Выпущено паспортов: {success.created.length}
            {selectedSize ? ` · размер ${selectedSize.sizeCode}` : ''}
          </strong>
          {success.skipped.length > 0 && (
            <div style={{ marginTop: '0.4rem' }}>
              Пропущено как уже выпущенные:{' '}
              <strong>
                {success.skipped.map((o) => `Рулон ${o}`).join(', ')}
              </strong>
            </div>
          )}
        </div>

        {success.created.length > 0 && (
          <ul className="constructor-list" style={{ marginTop: '0.6rem' }}>
            {success.created.map((p) => (
              <li key={p.id} className="constructor-list__item">
                <div
                  className="form-row"
                  style={{ alignItems: 'center', marginBottom: 0 }}
                >
                  <div>
                    <strong>Паспорт {p.number}</strong>
                    <div className="hint">
                      {p.rollNumber} · {p.qtyCut} шт
                    </div>
                  </div>
                  <PrintButton
                    sourceType="PASSPORT_PRINT"
                    sourceId={p.id}
                    fallbackHref={buildPassportPrintPath(p.id)}
                    label="Распечатать"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="actions-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setSuccess(null);
              setSelected(new Set());
              // Перечитываем серверные данные, чтобы только что выпущенные
              // рулоны показались как «выпущено».
              router.refresh();
            }}
          >
            Продолжить выпуск
          </button>
          <Link href="/work/cut-orders" className="btn btn-ghost">
            ← К выбору заказа
          </Link>
        </div>
      </div>
    );
  }

  // ---- Основная форма выбора размера и рулонов ----------------------------
  return (
    <div className="card">
      {error && <div className="error-box">{error}</div>}

      <div className="form-row">
        <label>Заказ</label>
        <div>
          <strong>{orderNumber}</strong>
          <div className="hint">
            Изделие: {productName} · цвет: {color}
          </div>
        </div>
      </div>

      <div className="form-row">
        <label id="release-sizeId-label">Размер</label>
        <div>
          {sortedSizes.length === 0 ? (
            <div className="hint">— в задаче раскроя нет размеров —</div>
          ) : (
            <div
              className="size-picker"
              role="radiogroup"
              aria-labelledby="release-sizeId-label"
            >
              {sortedSizes.map((s) => {
                const isActive = sizeId === s.sizeId;
                return (
                  <label
                    key={s.sizeId}
                    className={
                      'size-picker__option' + (isActive ? ' is-active' : '')
                    }
                  >
                    <input
                      type="radio"
                      name="release-sizeId"
                      value={s.sizeId}
                      checked={isActive}
                      onChange={(e) => setSizeId(e.target.value)}
                      className="size-picker__input"
                    />
                    <span className="size-picker__code">{s.sizeCode}</span>
                    {/* Новое требование: подпись «количество размера на
                        настиле» прямо под размером. */}
                    <span className="size-picker__meta">
                      на настиле: {s.perLayerQty}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="form-row">
        <label>Рулоны</label>
        <div>
          {rolls.length === 0 ? (
            <div className="hint">
              В задаче раскроя нет рулонов со слоями — выпускать нечего.
            </div>
          ) : (
            <>
              <div
                className="actions-row"
                style={{ marginTop: 0, marginBottom: '0.5rem' }}
              >
                <button
                  type="button"
                  className="btn"
                  onClick={toggleAll}
                  disabled={disabled || releasableOrdinals.length === 0}
                >
                  {allSelected ? 'Снять выбор' : 'Выбрать все рулоны'}
                </button>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th></th>
                    <th>Рулон</th>
                    <th>Слоёв</th>
                    <th>Паспортов</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rolls.map((r) => {
                    const qty = r.layers * perLayerQty;
                    const isReleased = releasedForSize.has(r.ordinal);
                    const isReleasable = !isReleased && qty > 0;
                    return (
                      <tr key={r.ordinal}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(r.ordinal)}
                            disabled={disabled || !isReleasable}
                            onChange={() => toggleRoll(r.ordinal)}
                            aria-label={`Рулон ${r.ordinal}`}
                          />
                        </td>
                        <td>Рулон {r.ordinal}</td>
                        <td>{r.layers}</td>
                        <td>{qty}</td>
                        <td>
                          {isReleased ? (
                            <span className="constructor-status constructor-status--done">
                              ✔ выпущено
                            </span>
                          ) : qty === 0 ? (
                            <span className="hint">размер не на настиле</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td></td>
                    <td>
                      <strong>Итого к выпуску</strong>
                    </td>
                    <td></td>
                    <td>
                      <strong>{selectedQty}</strong>
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      <div className="actions-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRelease}
          disabled={disabled || pending || selected.size === 0}
        >
          {pending ? 'Выпускаем…' : 'Выпустить паспорт'}
        </button>
        <Link href="/work/cut-orders" className="btn btn-ghost">
          Отмена
        </Link>
      </div>
    </div>
  );
}
