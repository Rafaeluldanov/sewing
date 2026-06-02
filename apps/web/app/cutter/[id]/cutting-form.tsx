'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CUTTING_TASK_MAX_LAYERS,
  CUTTING_TASK_MAX_PER_LAYER_QTY,
  CUTTING_TASK_MAX_ROLLS,
  type CuttingTaskRollDto,
  type CuttingTaskSizeRowDto,
  type SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';
import {
  completeCuttingTaskAction,
  saveCuttingProgressAction,
} from '../actions';

/**
 * Интерактивная форма раскроя (status IN_PROGRESS) — или read-only
 * показ итогов (status DONE).
 *
 * Что делает раскройщик:
 *   - в таблице размеров вводит «количество размера на настиле»
 *     (`perLayerQty`);
 *   - добавляет рулоны и для каждого вводит количество слоёв;
 *   - видит в реальном времени «всего слоёв» и «итог по размеру»
 *     (= всего слоёв × кол-во на настиле) рядом с планом;
 *   - сохраняет прогресс или жмёт «Раскрой завершён».
 *
 * Итоги считаются на клиенте мгновенно; сервер пересчитывает их же из
 * сохранённых данных (единая чистая функция `computeCuttingTotals`).
 */

interface RollDraft {
  /** Локальный ключ для React (стабилен при добавлении/удалении). */
  key: string;
  ordinal: number;
  layers: string;
}

interface Props {
  taskId: string;
  sizeRows: CuttingTaskSizeRowDto[];
  rolls: CuttingTaskRollDto[];
  readOnly?: boolean;
}

function clampInt(raw: string, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

export function CuttingForm({ taskId, sizeRows, rolls, readOnly = false }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // perLayerQty по размеру (строкой — это значения текстовых полей).
  // 0 показываем пустым полем, чтобы ввод давал «5», а не «05».
  const [perLayer, setPerLayer] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const r of sizeRows) {
      if (r.sizeId) init[r.sizeId] = r.perLayerQty === 0 ? '' : String(r.perLayerQty);
    }
    return init;
  });

  // Рабочий список рулонов. 0 слоёв — тоже пустым полем.
  const [rollDrafts, setRollDrafts] = useState<RollDraft[]>(() =>
    rolls.map((r) => ({
      key: `roll-${r.id}`,
      ordinal: r.ordinal,
      layers: r.layers === 0 ? '' : String(r.layers),
    })),
  );

  // --- Живые итоги ---------------------------------------------------------
  const totalLayers = useMemo(
    () =>
      rollDrafts.reduce(
        (sum, r) => sum + clampInt(r.layers, CUTTING_TASK_MAX_LAYERS),
        0,
      ),
    [rollDrafts],
  );

  function perSizeTotal(sizeId: string | null): number {
    if (!sizeId) return 0;
    const per = clampInt(perLayer[sizeId] ?? '0', CUTTING_TASK_MAX_PER_LAYER_QTY);
    return totalLayers * per;
  }

  // Итоговое количество штук по всему настилу = Σ «итог по размеру».
  const grandTotalPieces = sizeRows.reduce(
    (sum, r) => sum + perSizeTotal(r.sizeId),
    0,
  );

  // --- Мутаторы ------------------------------------------------------------
  function addRoll() {
    setRollDrafts((prev) => {
      const nextOrdinal =
        prev.length === 0 ? 1 : Math.max(...prev.map((r) => r.ordinal)) + 1;
      if (nextOrdinal > CUTTING_TASK_MAX_ROLLS) return prev;
      return [
        ...prev,
        { key: `roll-new-${nextOrdinal}-${prev.length}`, ordinal: nextOrdinal, layers: '' },
      ];
    });
    setSavedNote(null);
  }

  function removeRoll(key: string) {
    setRollDrafts((prev) => prev.filter((r) => r.key !== key));
    setSavedNote(null);
  }

  function setRollLayers(key: string, value: string) {
    setRollDrafts((prev) =>
      prev.map((r) => (r.key === key ? { ...r, layers: value } : r)),
    );
    setSavedNote(null);
  }

  function setPerLayerFor(sizeId: string, value: string) {
    setPerLayer((prev) => ({ ...prev, [sizeId]: value }));
    setSavedNote(null);
  }

  // --- Сборка payload + сабмит ---------------------------------------------
  function buildPayload(): SaveCuttingTaskProgressDto {
    return {
      sizeRows: sizeRows
        .filter((r): r is CuttingTaskSizeRowDto & { sizeId: string } => !!r.sizeId)
        .map((r) => ({
          sizeId: r.sizeId,
          perLayerQty: clampInt(
            perLayer[r.sizeId] ?? '0',
            CUTTING_TASK_MAX_PER_LAYER_QTY,
          ),
        })),
      rolls: rollDrafts.map((r) => ({
        ordinal: r.ordinal,
        layers: clampInt(r.layers, CUTTING_TASK_MAX_LAYERS),
      })),
    };
  }

  function handleSave() {
    setError(null);
    setSavedNote(null);
    startTransition(async () => {
      const result = await saveCuttingProgressAction(taskId, buildPayload());
      if (!result.ok) setError(result.error ?? 'Не удалось сохранить');
      else {
        setSavedNote('Сохранено');
        router.refresh();
      }
    });
  }

  function handleComplete() {
    setError(null);
    setSavedNote(null);
    const ok = window.confirm(
      'Завершить раскрой? После завершения задача станет недоступна для редактирования.',
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await completeCuttingTaskAction(taskId, buildPayload());
      if (!result.ok) setError(result.error ?? 'Не удалось завершить раскрой');
      else router.refresh();
    });
  }

  // --- Render --------------------------------------------------------------
  return (
    <div className="cutter-form">
      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">Размеры и итоги</h2>
        <table className="constructor-table cutter-table">
          <thead>
            <tr>
              <th>Размер</th>
              <th>На настиле</th>
              <th>План, шт</th>
              <th>Итог, шт</th>
            </tr>
          </thead>
          <tbody>
            {sizeRows.map((r) => {
              const total = perSizeTotal(r.sizeId);
              const reached = r.qtyPlan > 0 && total >= r.qtyPlan;
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{r.sizeCodeSnapshot}</strong>
                  </td>
                  <td>
                    {readOnly || !r.sizeId ? (
                      r.perLayerQty
                    ) : (
                      <input
                        className="cutter-input"
                        type="number"
                        min={0}
                        max={CUTTING_TASK_MAX_PER_LAYER_QTY}
                        inputMode="numeric"
                        value={perLayer[r.sizeId] ?? ''}
                        onChange={(e) => setPerLayerFor(r.sizeId!, e.target.value)}
                        aria-label={`Количество размера ${r.sizeCodeSnapshot} на настиле`}
                      />
                    )}
                  </td>
                  <td>{r.qtyPlan}</td>
                  <td
                    className={
                      'cutter-total' + (reached ? ' cutter-total--reached' : '')
                    }
                  >
                    {total}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>Итого, шт</td>
              <td className="cutter-total">{grandTotalPieces}</td>
            </tr>
          </tfoot>
        </table>
        <p className="constructor-complete-form__hint">
          Итог по размеру = всего слоёв × количество размера на настиле.
        </p>
      </section>

      <section className="constructor-card-block">
        <h2 className="constructor-card-block__title">Рулоны</h2>
        <table className="constructor-table cutter-table">
          <thead>
            <tr>
              <th>Рулон</th>
              <th>Слоёв</th>
              {!readOnly && <th aria-label="Удалить" />}
            </tr>
          </thead>
          <tbody>
            {rollDrafts.length === 0 ? (
              <tr>
                <td colSpan={readOnly ? 2 : 3} className="constructor-muted">
                  Рулоны ещё не добавлены.
                </td>
              </tr>
            ) : (
              rollDrafts.map((r) => (
                <tr key={r.key}>
                  <td>Рулон {r.ordinal}</td>
                  <td>
                    {readOnly ? (
                      r.layers || 0
                    ) : (
                      <input
                        className="cutter-input"
                        type="number"
                        min={0}
                        max={CUTTING_TASK_MAX_LAYERS}
                        inputMode="numeric"
                        value={r.layers}
                        onChange={(e) => setRollLayers(r.key, e.target.value)}
                        aria-label={`Слоёв в рулоне ${r.ordinal}`}
                      />
                    )}
                  </td>
                  {!readOnly && (
                    <td>
                      <button
                        type="button"
                        className="constructor-btn constructor-btn--ghost cutter-roll-remove"
                        onClick={() => removeRoll(r.key)}
                        aria-label={`Удалить рулон ${r.ordinal}`}
                      >
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
        <p className="cutter-layers-total">
          Всего слоёв: <strong>{totalLayers}</strong>
        </p>
        {!readOnly && (
          <button
            type="button"
            className="constructor-btn constructor-btn--ghost"
            onClick={addRoll}
            disabled={pending}
          >
            + Добавить рулон
          </button>
        )}
      </section>

      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
      {savedNote && (
        <p className="constructor-actions__saved">{savedNote}</p>
      )}

      {!readOnly && (
        <div className="constructor-actions cutter-actions">
          <button
            type="button"
            className="constructor-btn"
            onClick={handleSave}
            disabled={pending}
          >
            {pending ? 'Сохраняем…' : 'Сохранить'}
          </button>
          <button
            type="button"
            className="constructor-btn constructor-btn--primary"
            onClick={handleComplete}
            disabled={pending}
          >
            Раскрой завершён
          </button>
        </div>
      )}
    </div>
  );
}
