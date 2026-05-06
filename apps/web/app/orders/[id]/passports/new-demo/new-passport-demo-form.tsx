'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  createPassportDemoBatchAction,
  type PassportDemoFormState,
} from './actions';

interface SizeOption {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
  qtyCutFact: number;
  remaining: number;
}

interface CutterOption {
  id: string;
  fullName: string;
  login: string;
}

interface Props {
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizes: SizeOption[];
  today: string;
  disabled: boolean;
  creatorIsCutter: boolean;
  cutterOptions: CutterOption[];
}

const initialState: PassportDemoFormState = {};

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn btn-primary"
      disabled={pending || disabled}
    >
      {pending ? 'Выпускаем…' : 'Выпустить паспорта'}
    </button>
  );
}

function pickDefaultSize(sizes: SizeOption[]): string {
  const sorted = [...sizes].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder);
  const xs = sorted.find((s) => s.sizeCode.trim().toUpperCase() === 'XS');
  if (xs) return xs.sizeId;
  return sorted[0]?.sizeId ?? '';
}

/**
 * Демо-форма выпуска паспортов «по сетке рулонов».
 *
 * Поведение по ТЗ:
 *   - первым идёт выбор размера, по умолчанию XS (если такого нет — первый
 *     по `sizeSortOrder`);
 *   - поле «количество рулонов» — свободный ввод;
 *   - кнопка «Создать сетку» делает таблицу с N строками `Рулон 1..N` и
 *     полем количества; в подвале — итог по размеру;
 *   - если рулонов 0 → показываем ошибку «нельзя создавать сетку без
 *     указания количества рулонов»;
 *   - если пользователь меняет размер при уже созданной сетке, сетка
 *     пересоздаётся с тем же количеством рулонов (количества сбрасываются —
 *     другой размер ≠ тот же физический раскрой);
 *   - дата кроя и раскройщик подставляются автоматически, как в обычном
 *     `/orders/:id/passports/new`.
 */
export function NewPassportDemoForm({
  orderId,
  orderNumber,
  productName,
  color,
  sizes,
  today,
  disabled,
  creatorIsCutter,
  cutterOptions,
}: Props) {
  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sizeSortOrder - b.sizeSortOrder),
    [sizes],
  );

  const [sizeId, setSizeId] = useState<string>(() => pickDefaultSize(sizes));
  // rollsCount держим строкой, чтобы поле могло быть пустым (без «0»
  // по умолчанию) и пользователь мог стереть все цифры. Парсим в число
  // только в `handleCreateGrid`.
  const [rollsCount, setRollsCount] = useState<string>('');
  // gridSize = снапшот количества рулонов на момент последнего нажатия
  // «Создать сетку». Именно он определяет, существует ли сетка и какой
  // у неё размер. Это позволяет автоматически пересоздать сетку при
  // смене размера, не трогая ввод rollsCount.
  const [gridSize, setGridSize] = useState<number>(0);
  // По рулону держим строку, чтобы поле было пустым по умолчанию (без
  // «0») и пользователь мог стирать символы. Парсим в число при подсчёте
  // итога и в server action.
  const [quantities, setQuantities] = useState<string[]>([]);
  const [gridError, setGridError] = useState<string | null>(null);

  const [cutterId, setCutterId] = useState<string>(cutterOptions[0]?.id ?? '');

  const action = createPassportDemoBatchAction.bind(null, orderId);
  const [state, formAction] = useFormState(action, initialState);

  // Авто-пересоздание сетки при смене размера, если сетка уже существует.
  // ТЗ: «если пользователь поменял наверху размер, а количество рулонов
  // не поменялось, то создаётся сетка автоматически с тем же количеством
  // рулонов». Используем gridSize как «количество рулонов в сетке».
  useEffect(() => {
    if (gridSize > 0) {
      setQuantities(new Array(gridSize).fill(''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeId]);

  const handleCreateGrid = () => {
    const parsed = Number(rollsCount);
    if (!rollsCount.trim() || !Number.isFinite(parsed) || parsed <= 0) {
      setGridError(
        'Нельзя создавать сетку без указания количества рулонов',
      );
      return;
    }
    setGridError(null);
    const n = Math.floor(parsed);
    setGridSize(n);
    setQuantities(new Array(n).fill(''));
  };

  const total = quantities.reduce((acc, raw) => {
    const n = Number(raw);
    return acc + (raw.trim() && Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  // Все поля сетки должны быть заполнены положительным числом — иначе
  // submit заблокирован. Это и есть «требовали заполнения».
  const allRollsFilled =
    gridSize > 0 &&
    quantities.length === gridSize &&
    quantities.every((raw) => {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) && n > 0;
    });
  const selected = sortedSizes.find((s) => s.sizeId === sizeId);
  const showCutterSelect = !creatorIsCutter && cutterOptions.length > 0;
  const noActiveCutters = !creatorIsCutter && cutterOptions.length === 0;

  if (state.success) {
    const {
      created,
      failed,
      printed,
      printFailed,
      firstError,
      firstPrintError,
    } = state.success;
    return (
      <div className="card">
        <div className="success-box">
          <strong>Выпущено паспортов: {created}</strong>
          <div style={{ marginTop: '0.4rem' }}>
            Отправлено в печать: <strong>{printed}</strong>
            {printFailed > 0 && (
              <>
                {' '}· не ушло в печать: <strong>{printFailed}</strong>
                {firstPrintError ? <> ({firstPrintError})</> : null}
              </>
            )}
          </div>
          {failed > 0 && (
            <div style={{ marginTop: '0.4rem' }}>
              Не удалось выпустить: <strong>{failed}</strong>
              {firstError ? <> · {firstError}</> : null}
            </div>
          )}
        </div>
        <div className="actions-row">
          <Link className="btn btn-primary" href="/work">
            ← На рабочее место
          </Link>
          <Link
            className="btn"
            href={`/orders/${orderId}/passports/new-demo`}
          >
            Ещё одна серия
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}

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
        <label id="demo-sizeId-label">Размер</label>
        <div>
          {sortedSizes.length === 0 ? (
            <div className="hint">— нет размеров —</div>
          ) : (
            <div
              className="size-picker"
              role="radiogroup"
              aria-labelledby="demo-sizeId-label"
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
                      name="sizeId"
                      value={s.sizeId}
                      checked={isActive}
                      onChange={(e) => setSizeId(e.target.value)}
                      className="size-picker__input"
                    />
                    <span className="size-picker__code">{s.sizeCode}</span>
                    <span className="size-picker__meta">
                      ост. {s.remaining} / {s.qtyPlan}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {selected && (
            <div className="hint">
              По умолчанию выбран XS. Доступно к выпуску по выбранному
              размеру: <strong>{selected.remaining}</strong>.
            </div>
          )}
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="rollsCount">Количество рулонов</label>
        <div>
          <input
            id="rollsCount"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            // Контролируемая строка: пустое значение по умолчанию + любое
            // количество удалений, пока пользователь подбирает число.
            // Парсинг → `handleCreateGrid`.
            value={rollsCount}
            onChange={(e) => setRollsCount(e.target.value)}
            placeholder="Например, 3"
          />
          {gridError && (
            <div className="error-box" style={{ marginTop: '0.4rem' }}>
              {gridError}
            </div>
          )}
        </div>
      </div>

      {/*
       * Кнопка «Создать сетку» сидит в собственном `actions-row` — том
       * же контейнере, что финальный submit «Выпустить паспорта», —
       * поэтому отступ и выравнивание у них совпадают.
       */}
      <div className="actions-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleCreateGrid}
        >
          Создать сетку
        </button>
      </div>

      {gridSize > 0 && (
        <div className="form-row">
          <label>Сетка раскроя</label>
          <div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Рулон</th>
                  <th>Количество</th>
                </tr>
              </thead>
              <tbody>
                {quantities.map((q, idx) => (
                  <tr key={idx}>
                    <td>Рулон {idx + 1}</td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        required
                        placeholder="—"
                        value={q}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setQuantities((prev) => {
                            const copy = [...prev];
                            copy[idx] = raw;
                            return copy;
                          });
                        }}
                      />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Итого по размеру</strong>
                  </td>
                  <td>
                    <strong>{total}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCutterSelect && (
        <div className="form-row">
          <label htmlFor="cutterId">Раскройщик</label>
          <div>
            <select
              id="cutterId"
              name="cutterId"
              required
              value={cutterId}
              onChange={(e) => setCutterId(e.target.value)}
            >
              {cutterOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName} ({c.login})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {noActiveCutters && (
        <div className="error-box">
          Нет активных сотрудников с ролью раскройщика. Заведите
          раскройщика в{' '}
          <Link href="/admin/employees">/admin/employees</Link>.
        </div>
      )}

      <input type="hidden" name="cutDate" value={today} />
      <input
        type="hidden"
        name="quantities"
        value={JSON.stringify(quantities)}
      />

      <div className="actions-row">
        <SubmitButton
          disabled={disabled || gridSize === 0 || !allRollsFilled}
        />
        <Link href="/work" className="btn btn-ghost">
          Отмена
        </Link>
      </div>
    </form>
  );
}
