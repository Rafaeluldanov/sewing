'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { ReleaseLayDto, ReleasedRollDto } from '@sewing/shared/cutting-tasks';
import type { ReleasedPassportLiteDto } from '@sewing/shared/passports';
import { sendPassportPrintJobsBatch } from '@/components/print-button-actions';
import { buildPassportsBatchPrintPath } from '@/lib/browser-api-paths';
import { releaseFromRollsAction } from '../actions';

interface Props {
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  /** Расклады из завершённой задачи раскройщика. */
  lays: ReleaseLayDto[];
  /** Уже выпущенные рулоны `(расклад, размер, рулон)` + их паспорт. */
  released: ReleasedRollDto[];
  today: string;
  disabled: boolean;
}

interface SuccessState {
  created: ReleasedPassportLiteDto[];
  skipped: number[];
}

/**
 * Рулонный выпуск паспортов помощником раскройщика — по раскладам.
 *
 * Помощник ничего не вводит руками: расклады с размерами и рулонами
 * приходят из завершённой задачи раскройщика. Он выбирает расклад (если
 * их несколько), размер, отмечает рулоны («Выбрать все» или по одному —
 * кейс «сломался принтер, продолжить с нужного рулона») и жмёт «Выпустить
 * паспорт». Количество на каждый рулон = `слои рулона × раскладка размера
 * в этом раскладе` — считается и показывается тут же, окончательно его
 * проставляет backend.
 *
 * Уже выпущенные тройки `(расклад, размер, рулон)` помечены «выпущено» и
 * не выпускаются повторно (новый паспорт не плодим), но их паспорт можно
 * распечатать ещё раз кнопкой «Выпустить ещё раз» — кейс «завис принтер».
 */
export function CutterAssistantRollForm({
  orderId,
  orderNumber,
  productName,
  color,
  lays,
  released,
  today,
  disabled,
}: Props) {
  const router = useRouter();
  const sortedLays = useMemo(
    () => [...lays].sort((a, b) => a.ordinal - b.ordinal),
    [lays],
  );

  const [layOrdinal, setLayOrdinal] = useState<number>(
    () => sortedLays[0]?.ordinal ?? 0,
  );
  const selectedLay = useMemo(
    () => sortedLays.find((l) => l.ordinal === layOrdinal) ?? sortedLays[0],
    [sortedLays, layOrdinal],
  );

  const sortedSizes = useMemo(
    () =>
      selectedLay
        ? [...selectedLay.sizes].sort((a, b) => a.sortOrder - b.sortOrder)
        : [],
    [selectedLay],
  );
  const rolls = selectedLay?.rolls ?? [];

  const [sizeId, setSizeId] = useState<string>(
    () => sortedLays[0]?.sizes.slice().sort((a, b) => a.sortOrder - b.sortOrder)[0]?.sizeId ?? '',
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [pending, startTransition] = useTransition();

  // ---- Печать на экране успеха: выбор паспортов чекбоксами + одна кнопка --
  const [printSel, setPrintSel] = useState<Set<string>>(new Set());
  const [printFeedback, setPrintFeedback] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [printPending, startPrintTransition] = useTransition();

  // ---- «Выпустить ещё раз»: повторная печать уже выпущенного паспорта -------
  // (например, завис принтер). Новый паспорт не создаём — только переотправка
  // на печать существующего. Фидбек привязан к рулону (`ordinal`).
  const [reprintingOrdinal, setReprintingOrdinal] = useState<number | null>(
    null,
  );
  const [reprintFeedback, setReprintFeedback] = useState<{
    ordinal: number;
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [reprintPending, startReprintTransition] = useTransition();

  // Смена расклада: переключаем размер на первый размер нового расклада и
  // сбрасываем выбор рулонов.
  useEffect(() => {
    const first = sortedSizes[0]?.sizeId ?? '';
    setSizeId(first);
    setSelected(new Set());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layOrdinal]);

  const selectedSize = sortedSizes.find((s) => s.sizeId === sizeId);
  const perLayerQty = selectedSize?.perLayerQty ?? 0;

  // Уже выпущенные рулоны для выбранной пары (расклад, размер): набор
  // ordinal'ов + карта `ordinal → паспорт` для повторной печати.
  const { releasedForSize, releasedPassportByOrdinal } = useMemo(() => {
    const set = new Set<number>();
    const byOrdinal = new Map<number, { id: string; number: string }>();
    for (const r of released) {
      if (r.layOrdinal === layOrdinal && r.sizeId === sizeId) {
        set.add(r.ordinal);
        byOrdinal.set(r.ordinal, { id: r.passportId, number: r.passportNumber });
      }
    }
    return { releasedForSize: set, releasedPassportByOrdinal: byOrdinal };
  }, [released, layOrdinal, sizeId]);

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
        layOrdinal,
        sizeId,
        cutDate: today,
        rollOrdinals: [...selected],
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      const created = res.created ?? [];
      setSuccess({ created, skipped: res.skipped ?? [] });
      setPrintSel(new Set(created.map((p) => p.id)));
      setPrintFeedback(null);
    });
  };

  const togglePrint = (id: string) => {
    setPrintSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePrintSelected = (ids: string[]) => {
    if (ids.length === 0) return;
    setPrintFeedback(null);
    startPrintTransition(async () => {
      const res = await sendPassportPrintJobsBatch(ids);
      if (res.ok) {
        const failedNote =
          res.failed && res.failed > 0
            ? ` · не ушло: ${res.failed}${
                res.firstError ? ` (${res.firstError})` : ''
              }`
            : '';
        setPrintFeedback({
          kind: res.printed === 0 ? 'err' : 'ok',
          text: `Отправлено на принтер: ${res.printed ?? 0}${failedNote}`,
        });
        return;
      }
      if (res.noPrinter) {
        if (typeof window !== 'undefined') {
          window.open(buildPassportsBatchPrintPath(ids), '_blank', 'noopener');
        }
        setPrintFeedback({
          kind: 'ok',
          text: 'Принтер не настроен — открыта печать выбранных в браузере.',
        });
        return;
      }
      setPrintFeedback({
        kind: 'err',
        text: res.error ?? 'Не удалось отправить на печать.',
      });
    });
  };

  // Повторная печать одного уже выпущенного паспорта. Переиспользует тот же
  // batch-механизм печати (PrintJob + браузерный fallback), что и экран
  // успеха, но без создания паспорта — кейс «принтер завис, печатаем заново».
  const handleReprint = (passportId: string, ordinal: number) => {
    setReprintFeedback(null);
    setReprintingOrdinal(ordinal);
    startReprintTransition(async () => {
      const res = await sendPassportPrintJobsBatch([passportId]);
      if (res.ok) {
        setReprintFeedback({
          ordinal,
          kind: res.printed && res.printed > 0 ? 'ok' : 'err',
          text:
            res.printed && res.printed > 0
              ? 'Отправлено на принтер повторно.'
              : `Не ушло${res.firstError ? ` (${res.firstError})` : ''}`,
        });
      } else if (res.noPrinter) {
        if (typeof window !== 'undefined') {
          window.open(
            buildPassportsBatchPrintPath([passportId]),
            '_blank',
            'noopener',
          );
        }
        setReprintFeedback({
          ordinal,
          kind: 'ok',
          text: 'Принтер не настроен — открыта печать в браузере.',
        });
      } else {
        setReprintFeedback({
          ordinal,
          kind: 'err',
          text: res.error ?? 'Не удалось отправить на печать.',
        });
      }
      setReprintingOrdinal(null);
    });
  };

  // ---- Успешный выпуск: чекбоксы по паспортам + одна кнопка «Распечатать» --
  if (success) {
    const created = success.created;
    const allPrintSelected =
      created.length > 0 && created.every((p) => printSel.has(p.id));
    const toggleAllPrint = () =>
      setPrintSel(
        allPrintSelected ? new Set() : new Set(created.map((p) => p.id)),
      );

    return (
      <div className="card">
        <div className="success-box">
          <strong>
            Выпущено паспортов: {created.length}
            {selectedSize ? ` · размер ${selectedSize.sizeCode}` : ''}
            {` · расклад ${layOrdinal}`}
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

        {created.length > 0 && (
          <>
            <div
              className="actions-row"
              style={{ marginTop: '0.6rem', marginBottom: '0.4rem' }}
            >
              <button
                type="button"
                className="btn"
                onClick={toggleAllPrint}
                disabled={printPending}
              >
                {allPrintSelected ? 'Снять выбор' : 'Выбрать все'}
              </button>
            </div>

            <ul className="constructor-list">
              {created.map((p) => (
                <li key={p.id} className="constructor-list__item">
                  <label
                    className="form-row"
                    style={{
                      alignItems: 'center',
                      marginBottom: 0,
                      gap: '0.6rem',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={printSel.has(p.id)}
                      disabled={printPending}
                      onChange={() => togglePrint(p.id)}
                      aria-label={`Паспорт ${p.number}`}
                    />
                    <div>
                      <strong>Паспорт {p.number}</strong>
                      <div className="hint">
                        {p.rollNumber} · {p.qtyCut} шт
                      </div>
                    </div>
                  </label>
                </li>
              ))}
            </ul>

            <div className="actions-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => handlePrintSelected([...printSel])}
                disabled={printPending || printSel.size === 0}
              >
                {printPending
                  ? 'Печатаем…'
                  : `Распечатать (${printSel.size})`}
              </button>
            </div>
            {printFeedback && (
              <span
                className="meta-line"
                style={{
                  color:
                    printFeedback.kind === 'ok'
                      ? 'var(--color-ok-fg)'
                      : 'var(--color-danger-fg)',
                }}
              >
                {printFeedback.text}
              </span>
            )}
          </>
        )}

        <div className="actions-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSuccess(null);
              setSelected(new Set());
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

  // ---- Основная форма: расклад → размер → рулоны --------------------------
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

      {sortedLays.length === 0 ? (
        <div className="hint">— в задаче раскроя нет раскладов —</div>
      ) : (
        <>
          {sortedLays.length > 1 && (
            <div className="form-row">
              <label id="release-lay-label">Расклад</label>
              <div
                className="size-picker"
                role="radiogroup"
                aria-labelledby="release-lay-label"
              >
                {sortedLays.map((l) => {
                  const isActive = l.ordinal === layOrdinal;
                  return (
                    <label
                      key={l.ordinal}
                      className={
                        'size-picker__option' + (isActive ? ' is-active' : '')
                      }
                    >
                      <input
                        type="radio"
                        name="release-lay"
                        value={l.ordinal}
                        checked={isActive}
                        onChange={() => setLayOrdinal(l.ordinal)}
                        className="size-picker__input"
                      />
                      <span className="size-picker__code">Расклад {l.ordinal}</span>
                      <span className="size-picker__meta">
                        размеров: {l.sizes.length}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="form-row">
            <label id="release-sizeId-label">Размер</label>
            <div>
              {sortedSizes.length === 0 ? (
                <div className="hint">— в этом раскладе нет размеров —</div>
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
                  В этом раскладе нет рулонов со слоями — выпускать нечего.
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
                                (() => {
                                  const pass = releasedPassportByOrdinal.get(
                                    r.ordinal,
                                  );
                                  const fb =
                                    reprintFeedback &&
                                    reprintFeedback.ordinal === r.ordinal
                                      ? reprintFeedback
                                      : null;
                                  return (
                                    <div
                                      style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '0.5rem',
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <span className="constructor-status constructor-status--done">
                                        ✔ выпущено
                                      </span>
                                      {pass && (
                                        <button
                                          type="button"
                                          className="btn btn-ghost"
                                          onClick={() =>
                                            handleReprint(pass.id, r.ordinal)
                                          }
                                          disabled={reprintPending}
                                          aria-label={`Выпустить ещё раз паспорт ${pass.number}`}
                                        >
                                          {reprintPending &&
                                          reprintingOrdinal === r.ordinal
                                            ? 'Печатаем…'
                                            : 'Выпустить ещё раз'}
                                        </button>
                                      )}
                                      {fb && (
                                        <span
                                          className="hint"
                                          style={{
                                            color:
                                              fb.kind === 'ok'
                                                ? 'var(--color-ok-fg)'
                                                : 'var(--color-danger-fg)',
                                          }}
                                        >
                                          {fb.text}
                                        </span>
                                      )}
                                    </div>
                                  );
                                })()
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
        </>
      )}

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
