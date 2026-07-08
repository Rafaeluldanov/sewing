'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { ReleaseLayDto, ReleasedRollDto } from '@sewing/shared/cutting-tasks';
import type {
  ReleasedPassportLiteDto,
  ReleaseOverCutDto,
} from '@sewing/shared/passports';
import { sendPassportPrintJobsBatch } from '@/components/print-button-actions';
import { buildPassportsBatchPrintPath } from '@/lib/browser-api-paths';
import { releaseFromRollsAction } from '../actions';

// Ф3 «Расцветки»: декоративный свотч цвета рулона по названию (основа→hex).
const ROLL_COLOR_STEMS: ReadonlyArray<readonly [string, string]> = [
  ['бел', '#f2f2f0'], ['черн', '#222222'], ['красн', '#d23b3b'],
  ['оранж', '#e8823a'], ['желт', '#e8b73a'], ['зелен', '#2e9e4a'],
  ['голуб', '#5cb3e8'], ['фиолет', '#8a5cd1'], ['розов', '#e87ba8'],
  ['бордов', '#7b1f2b'], ['корич', '#8a5a2b'], ['беж', '#e3d3b3'],
  ['бирюз', '#1fb6a6'], ['серебр', '#c9ccd1'], ['син', '#2f7fd1'],
  ['сер', '#8a8a86'],
];
function rollSwatch(name: string): string {
  const q = name.trim().toLowerCase().replace(/ё/g, 'е');
  for (const [stem, hex] of ROLL_COLOR_STEMS) {
    if (q.startsWith(stem)) return hex;
  }
  return '#b7c3d0';
}

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
  /** Уведомление о перекрое плана размера (печать не блокировалась). */
  overCut: ReleaseOverCutDto | null;
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

  // Ф3 «Расцветки»: показываем колонку «Цвет» рулона только если в раскрое
  // реально несколько цветов (иначе одноцветный заказ — колонка лишняя).
  const multiColor = useMemo(() => {
    const colors = new Set<string>();
    for (const l of lays) {
      for (const r of l.rolls) {
        if (r.variantColor) colors.add(r.variantColor);
      }
    }
    return colors.size > 1;
  }, [lays]);

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

  // ---- «Выпустить ещё раз»: повторная печать уже выпущенных паспортов -------
  // (например, завис принтер). Новые паспорта не создаём — только
  // переотправка существующих на печать. Запускается той же нижней кнопкой
  // (она меняет подпись), когда выбраны уже выпущенные рулоны; кнопок у
  // каждого рулона больше нет.
  const [reprintFeedback, setReprintFeedback] = useState<{
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

  // Выбирать можно любой рулон со слоями — и невыпущенный (новый паспорт),
  // и уже выпущенный (повторная печать). Блокируем только рулоны без слоёв
  // (размер не на этом настиле).
  const selectableOrdinals = useMemo(
    () =>
      rolls
        .filter((r) => r.layers * perLayerQty > 0)
        .map((r) => r.ordinal),
    [rolls, perLayerQty],
  );

  // Смена размера сбрасывает выбор: набор выпущенных и количества другие.
  useEffect(() => {
    setSelected(new Set());
    setError(null);
    setReprintFeedback(null);
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
    selectableOrdinals.length > 0 &&
    selectableOrdinals.every((o) => selected.has(o));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableOrdinals));
  };

  // Если ВСЕ выбранные рулоны уже выпущены — нижняя кнопка переключается на
  // повторную печать (а не создаёт паспорта). Смешанный выбор трактуем как
  // обычный выпуск: уже выпущенные рулоны backend идемпотентно пропустит.
  const selectedAllReleased =
    selected.size > 0 && [...selected].every((o) => releasedForSize.has(o));

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
      setSuccess({
        created,
        skipped: res.skipped ?? [],
        overCut: res.overCut ?? null,
      });
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

  // Повторная печать выбранных уже выпущенных паспортов (нижняя кнопка в
  // режиме «выпустить ещё раз»). Переиспользует тот же batch-механизм печати
  // (PrintJob + браузерный fallback), что и экран успеха, но без создания
  // паспортов — кейс «принтер завис, печатаем заново».
  const handleReprintSelected = () => {
    const ids = [...selected]
      .map((o) => releasedPassportByOrdinal.get(o)?.id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    setReprintFeedback(null);
    startReprintTransition(async () => {
      const res = await sendPassportPrintJobsBatch(ids);
      if (res.ok) {
        const failedNote =
          res.failed && res.failed > 0
            ? ` · не ушло: ${res.failed}${
                res.firstError ? ` (${res.firstError})` : ''
              }`
            : '';
        setReprintFeedback({
          kind: res.printed === 0 ? 'err' : 'ok',
          text: `Отправлено на принтер повторно: ${res.printed ?? 0}${failedNote}`,
        });
      } else if (res.noPrinter) {
        if (typeof window !== 'undefined') {
          window.open(
            buildPassportsBatchPrintPath(ids),
            '_blank',
            'noopener',
          );
        }
        setReprintFeedback({
          kind: 'ok',
          text: 'Принтер не настроен — открыта печать выбранных в браузере.',
        });
      } else {
        setReprintFeedback({
          kind: 'err',
          text: res.error ?? 'Не удалось отправить на печать.',
        });
      }
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

        {success.overCut && (
          <div
            className="meta-line"
            role="status"
            style={{
              marginTop: '0.6rem',
              padding: '0.6rem 0.8rem',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-warn-soft)',
              color: 'var(--color-warn-fg)',
            }}
          >
            Уведомление: по размеру{' '}
            <strong>{selectedSize?.sizeCode ?? '—'}</strong> выпущено{' '}
            <strong>{success.overCut.cutQty}</strong> шт при плане{' '}
            <strong>{success.overCut.planQty}</strong> — на{' '}
            <strong>{success.overCut.overBy}</strong> больше. Печать не
            заблокирована.
          </div>
        )}

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
                      disabled={disabled || selectableOrdinals.length === 0}
                    >
                      {allSelected ? 'Снять выбор' : 'Выбрать все рулоны'}
                    </button>
                  </div>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Рулон</th>
                        {multiColor && <th>Цвет</th>}
                        <th>Слоёв</th>
                        <th>Паспортов</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rolls.map((r) => {
                        const qty = r.layers * perLayerQty;
                        const isReleased = releasedForSize.has(r.ordinal);
                        // Выбрать можно любой рулон со слоями: невыпущенный →
                        // новый паспорт, уже выпущенный → повторная печать.
                        const isSelectable = qty > 0;
                        return (
                          <tr key={r.ordinal}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selected.has(r.ordinal)}
                                disabled={disabled || !isSelectable}
                                onChange={() => toggleRoll(r.ordinal)}
                                aria-label={`Рулон ${r.ordinal}`}
                              />
                            </td>
                            <td>Рулон {r.ordinal}</td>
                            {multiColor && (
                              <td>
                                {r.variantColor ? (
                                  <span
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 6,
                                    }}
                                  >
                                    <span
                                      style={{
                                        width: 12,
                                        height: 12,
                                        borderRadius: '50%',
                                        background: rollSwatch(r.variantColor),
                                        border: '1px solid rgba(0,0,0,.15)',
                                        flex: 'none',
                                      }}
                                      aria-hidden
                                    />
                                    {r.variantColor}
                                  </span>
                                ) : (
                                  <span className="hint">—</span>
                                )}
                              </td>
                            )}
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
                        {multiColor && <td></td>}
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
          onClick={selectedAllReleased ? handleReprintSelected : handleRelease}
          disabled={disabled || pending || reprintPending || selected.size === 0}
        >
          {selectedAllReleased
            ? reprintPending
              ? 'Печатаем…'
              : 'Выпустить ещё раз паспорт'
            : pending
              ? 'Выпускаем…'
              : 'Выпустить паспорт'}
        </button>
        <Link href="/work/cut-orders" className="btn btn-ghost">
          Отмена
        </Link>
      </div>
      {reprintFeedback && (
        <span
          className="meta-line"
          style={{
            color:
              reprintFeedback.kind === 'ok'
                ? 'var(--color-ok-fg)'
                : 'var(--color-danger-fg)',
          }}
        >
          {reprintFeedback.text}
        </span>
      )}
    </div>
  );
}
