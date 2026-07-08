'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CUTTING_TASK_MAX_LAYERS,
  CUTTING_TASK_MAX_LAYS,
  CUTTING_TASK_MAX_PER_LAYER_QTY,
  CUTTING_TASK_MAX_ROLLS,
  type CuttingTaskLayDto,
  type CuttingTaskSizeRowDto,
  type CuttingTaskVariantDto,
  type SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';
import {
  completeCuttingTaskAction,
  saveCuttingProgressAction,
} from '../actions';

/**
 * Интерактивная форма раскроя (status IN_PROGRESS) — или read-only показ
 * итогов (status DONE).
 *
 * Раскрой многораскладный: в одном заказе раскройщик делает несколько
 * раскладов. Для каждого расклада:
 *   - чекбоксом выбирает размеры из плана заказа и для каждого вводит
 *     «количество размера на настиле» (`perLayerQty`);
 *   - добавляет рулоны и для каждого вводит количество слоёв;
 *   - видит «всего слоёв» и «итог по размеру» расклада в реальном времени.
 *
 * Итог по размеру в заказе = Σ по раскладам (слои расклада × «на настиле»).
 * Внизу — «+ Добавить расклад», затем «Сохранить» / «Раскрой завершён».
 */

interface RollDraft {
  /** Локальный ключ для React (стабилен при добавлении/удалении). */
  key: string;
  ordinal: number;
  layers: string;
  /** Ф3 «Расцветки»: id расцветки рулона (`OrderVariant`) или `null`. */
  variantId: string | null;
}

interface LayDraft {
  key: string;
  /** Выбранные размеры: `sizeId → perLayerQty` строкой. Наличие = выбран. */
  sizes: Record<string, string>;
  rolls: RollDraft[];
}

interface Props {
  taskId: string;
  /** План по размерам (снимок заказа) — что доступно для выбора. */
  sizeRows: CuttingTaskSizeRowDto[];
  /** Существующие расклады задачи. */
  lays: CuttingTaskLayDto[];
  /**
   * Ф3 «Расцветки»: расцветки заказа. >1 расцветки → на каждый рулон
   * показываем селект цвета; ≤1 → рулоны молча берут единственную
   * расцветку (или `null`).
   */
  variants: CuttingTaskVariantDto[];
  readOnly?: boolean;
}

function clampInt(raw: string, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function layFromDto(dto: CuttingTaskLayDto): LayDraft {
  const sizes: Record<string, string> = {};
  for (const s of dto.sizes) {
    if (s.sizeId) sizes[s.sizeId] = s.perLayerQty === 0 ? '' : String(s.perLayerQty);
  }
  return {
    key: `lay-${dto.id}`,
    sizes,
    rolls: dto.rolls.map((r) => ({
      key: `roll-${r.id}`,
      ordinal: r.ordinal,
      layers: r.layers === 0 ? '' : String(r.layers),
      variantId: r.variantId,
    })),
  };
}

export function CuttingForm({
  taskId,
  sizeRows,
  lays,
  variants,
  readOnly = false,
}: Props) {
  // Ф3: дефолтная расцветка нового рулона — первая (для одноцветного
  // заказа это единственная расцветка #0; UI-селект не показываем).
  const defaultVariantId = variants[0]?.id ?? null;
  const multiColor = variants.length > 1;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Счётчик для стабильных локальных ключей новых раскладов/рулонов.
  const seq = useRef(0);
  const nextKey = (p: string) => `${p}-new-${(seq.current += 1)}`;

  // Размеры плана, которые можно выбирать (есть `sizeId`), в порядке плана.
  const selectableSizes = useMemo(
    () =>
      [...sizeRows]
        .filter((r) => r.sizeId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [sizeRows],
  );
  const planBySize = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of sizeRows) if (r.sizeId) m.set(r.sizeId, r.qtyPlan);
    return m;
  }, [sizeRows]);

  // Стартовое состояние: существующие расклады; если их нет и форма
  // редактируемая — один пустой расклад, чтобы было что заполнять.
  const [layDrafts, setLayDrafts] = useState<LayDraft[]>(() => {
    if (lays.length > 0) return lays.map(layFromDto);
    if (readOnly) return [];
    return [{ key: 'lay-init-1', sizes: {}, rolls: [] }];
  });

  // --- Расчёты -------------------------------------------------------------
  const layLayers = (lay: LayDraft) =>
    lay.rolls.reduce((s, r) => s + clampInt(r.layers, CUTTING_TASK_MAX_LAYERS), 0);

  const laySizeTotal = (lay: LayDraft, sizeId: string) =>
    layLayers(lay) * clampInt(lay.sizes[sizeId] ?? '0', CUTTING_TASK_MAX_PER_LAYER_QTY);

  // Итог по размеру в заказе = Σ по раскладам.
  const overallSizeTotal = (sizeId: string) =>
    layDrafts.reduce(
      (sum, lay) => (sizeId in lay.sizes ? sum + laySizeTotal(lay, sizeId) : sum),
      0,
    );

  const grandTotalPieces = selectableSizes.reduce(
    (sum, r) => sum + overallSizeTotal(r.sizeId as string),
    0,
  );

  // --- Мутаторы ------------------------------------------------------------
  function touched() {
    setSavedNote(null);
  }

  function updateLay(key: string, fn: (lay: LayDraft) => LayDraft) {
    setLayDrafts((prev) => prev.map((l) => (l.key === key ? fn(l) : l)));
    touched();
  }

  function addLay() {
    setLayDrafts((prev) =>
      prev.length >= CUTTING_TASK_MAX_LAYS
        ? prev
        : [...prev, { key: nextKey('lay'), sizes: {}, rolls: [] }],
    );
    touched();
  }

  function removeLay(key: string) {
    setLayDrafts((prev) => prev.filter((l) => l.key !== key));
    touched();
  }

  function toggleSize(layKey: string, sizeId: string) {
    updateLay(layKey, (lay) => {
      const sizes = { ...lay.sizes };
      if (sizeId in sizes) delete sizes[sizeId];
      else sizes[sizeId] = '';
      return { ...lay, sizes };
    });
  }

  function setSizePerLayer(layKey: string, sizeId: string, value: string) {
    updateLay(layKey, (lay) => ({
      ...lay,
      sizes: { ...lay.sizes, [sizeId]: value },
    }));
  }

  function addRoll(layKey: string) {
    updateLay(layKey, (lay) => {
      const nextOrdinal =
        lay.rolls.length === 0
          ? 1
          : Math.max(...lay.rolls.map((r) => r.ordinal)) + 1;
      if (nextOrdinal > CUTTING_TASK_MAX_ROLLS) return lay;
      return {
        ...lay,
        rolls: [
          ...lay.rolls,
          {
            key: nextKey('roll'),
            ordinal: nextOrdinal,
            layers: '',
            variantId: defaultVariantId,
          },
        ],
      };
    });
  }

  function setRollVariant(layKey: string, rollKey: string, variantId: string) {
    updateLay(layKey, (lay) => ({
      ...lay,
      rolls: lay.rolls.map((r) =>
        r.key === rollKey ? { ...r, variantId: variantId || null } : r,
      ),
    }));
  }

  function removeRoll(layKey: string, rollKey: string) {
    updateLay(layKey, (lay) => ({
      ...lay,
      rolls: lay.rolls.filter((r) => r.key !== rollKey),
    }));
  }

  function setRollLayers(layKey: string, rollKey: string, value: string) {
    updateLay(layKey, (lay) => ({
      ...lay,
      rolls: lay.rolls.map((r) => (r.key === rollKey ? { ...r, layers: value } : r)),
    }));
  }

  // --- Сборка payload + сабмит ---------------------------------------------
  function buildPayload(): SaveCuttingTaskProgressDto {
    return {
      lays: layDrafts.map((lay) => ({
        laySizes: Object.entries(lay.sizes).map(([sizeId, v]) => ({
          sizeId,
          perLayerQty: clampInt(v, CUTTING_TASK_MAX_PER_LAYER_QTY),
        })),
        rolls: lay.rolls.map((r) => ({
          ordinal: r.ordinal,
          layers: clampInt(r.layers, CUTTING_TASK_MAX_LAYERS),
          variantId: r.variantId,
        })),
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
      {layDrafts.length === 0 ? (
        <section className="constructor-card-block">
          <p className="constructor-muted">Раскладов нет.</p>
        </section>
      ) : (
        layDrafts.map((lay, idx) => (
          <LayBlock
            key={lay.key}
            lay={lay}
            ordinal={idx + 1}
            readOnly={readOnly}
            canRemove={!readOnly && layDrafts.length > 1}
            selectableSizes={selectableSizes}
            planBySize={planBySize}
            layLayers={layLayers(lay)}
            laySizeTotal={(sizeId) => laySizeTotal(lay, sizeId)}
            onToggleSize={(sizeId) => toggleSize(lay.key, sizeId)}
            onSetPerLayer={(sizeId, v) => setSizePerLayer(lay.key, sizeId, v)}
            onAddRoll={() => addRoll(lay.key)}
            onRemoveRoll={(rollKey) => removeRoll(lay.key, rollKey)}
            onSetRollLayers={(rollKey, v) => setRollLayers(lay.key, rollKey, v)}
            onSetRollVariant={(rollKey, v) => setRollVariant(lay.key, rollKey, v)}
            variants={variants}
            multiColor={multiColor}
            onRemove={() => removeLay(lay.key)}
            disabled={pending}
          />
        ))
      )}

      {/* Итог по заказу (сумма по всем раскладам vs план). */}
      {selectableSizes.length > 0 && (
        <section className="constructor-card-block">
          <h2 className="constructor-card-block__title">Итог по заказу</h2>
          <table className="constructor-table cutter-table">
            <thead>
              <tr>
                <th>Размер</th>
                <th>План, шт</th>
                <th>Итог, шт</th>
              </tr>
            </thead>
            <tbody>
              {selectableSizes.map((r) => {
                const total = overallSizeTotal(r.sizeId as string);
                const reached = r.qtyPlan > 0 && total >= r.qtyPlan;
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.sizeCodeSnapshot}</strong>
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
                <td colSpan={2}>Итого, шт</td>
                <td className="cutter-total">{grandTotalPieces}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {error && (
        <p className="constructor-actions__error" role="alert">
          {error}
        </p>
      )}
      {savedNote && <p className="constructor-actions__saved">{savedNote}</p>}

      {!readOnly && (
        <div className="constructor-actions cutter-actions">
          <button
            type="button"
            className="constructor-btn constructor-btn--ghost"
            onClick={addLay}
            disabled={pending || layDrafts.length >= CUTTING_TASK_MAX_LAYS}
          >
            + Добавить расклад
          </button>
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

// ---------------------------------------------------------------------------
// Один расклад: таблица размеров (с чекбоксами) + рулоны + итоги расклада.
// ---------------------------------------------------------------------------
interface LayBlockProps {
  lay: LayDraft;
  ordinal: number;
  readOnly: boolean;
  canRemove: boolean;
  selectableSizes: CuttingTaskSizeRowDto[];
  planBySize: Map<string, number>;
  layLayers: number;
  laySizeTotal: (sizeId: string) => number;
  onToggleSize: (sizeId: string) => void;
  onSetPerLayer: (sizeId: string, value: string) => void;
  onAddRoll: () => void;
  onRemoveRoll: (rollKey: string) => void;
  onSetRollLayers: (rollKey: string, value: string) => void;
  onSetRollVariant: (rollKey: string, variantId: string) => void;
  variants: CuttingTaskVariantDto[];
  multiColor: boolean;
  onRemove: () => void;
  disabled: boolean;
}

function LayBlock({
  lay,
  ordinal,
  readOnly,
  canRemove,
  selectableSizes,
  planBySize,
  layLayers,
  laySizeTotal,
  onToggleSize,
  onSetPerLayer,
  onAddRoll,
  onRemoveRoll,
  onSetRollLayers,
  onSetRollVariant,
  variants,
  multiColor,
  onRemove,
  disabled,
}: LayBlockProps) {
  // В read-only показываем только выбранные размеры; в редактировании —
  // все размеры плана с чекбоксом выбора.
  const readonlySizeIds = Object.keys(lay.sizes);

  return (
    <section className="constructor-card-block cutter-lay">
      <div className="constructor-card-block__head cutter-lay__head">
        <h2 className="constructor-card-block__title">Расклад {ordinal}</h2>
        {canRemove && (
          <button
            type="button"
            className="constructor-btn constructor-btn--ghost cutter-lay-remove"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Удалить расклад ${ordinal}`}
          >
            ✕ Удалить расклад
          </button>
        )}
      </div>

      {/* Размеры и итоги расклада */}
      <table className="constructor-table cutter-table">
        <thead>
          <tr>
            {!readOnly && <th aria-label="Выбор" />}
            <th>Размер</th>
            <th>На настиле</th>
            <th>План, шт</th>
            <th>Итог, шт</th>
          </tr>
        </thead>
        <tbody>
          {readOnly
            ? readonlySizeIds.map((sizeId) => {
                const meta = selectableSizes.find((s) => s.sizeId === sizeId);
                const code = meta?.sizeCodeSnapshot ?? sizeId;
                const total = laySizeTotal(sizeId);
                return (
                  <tr key={sizeId}>
                    <td>
                      <strong>{code}</strong>
                    </td>
                    <td>{lay.sizes[sizeId] || 0}</td>
                    <td>{planBySize.get(sizeId) ?? 0}</td>
                    <td className="cutter-total">{total}</td>
                  </tr>
                );
              })
            : selectableSizes.map((r) => {
                const sizeId = r.sizeId as string;
                const checked = sizeId in lay.sizes;
                const total = checked ? laySizeTotal(sizeId) : 0;
                return (
                  <tr key={r.id} className={checked ? '' : 'cutter-row--off'}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => onToggleSize(sizeId)}
                        aria-label={`Включить размер ${r.sizeCodeSnapshot} в расклад ${ordinal}`}
                      />
                    </td>
                    <td>
                      <strong>{r.sizeCodeSnapshot}</strong>
                    </td>
                    <td>
                      {checked ? (
                        <input
                          className="cutter-input"
                          type="number"
                          min={0}
                          max={CUTTING_TASK_MAX_PER_LAYER_QTY}
                          inputMode="numeric"
                          value={lay.sizes[sizeId] ?? ''}
                          onChange={(e) => onSetPerLayer(sizeId, e.target.value)}
                          aria-label={`Количество размера ${r.sizeCodeSnapshot} на настиле`}
                        />
                      ) : (
                        <span className="constructor-muted">—</span>
                      )}
                    </td>
                    <td>{r.qtyPlan}</td>
                    <td className="cutter-total">{total}</td>
                  </tr>
                );
              })}
          {readOnly && readonlySizeIds.length === 0 && (
            <tr>
              <td colSpan={4} className="constructor-muted">
                Размеры не выбраны.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Рулоны расклада */}
      <table className="constructor-table cutter-table">
        <thead>
          <tr>
            <th>Рулон</th>
            <th>Слоёв</th>
            {multiColor && <th>Цвет</th>}
            {!readOnly && <th aria-label="Удалить" />}
          </tr>
        </thead>
        <tbody>
          {lay.rolls.length === 0 ? (
            <tr>
              <td
                colSpan={2 + (multiColor ? 1 : 0) + (readOnly ? 0 : 1)}
                className="constructor-muted"
              >
                Рулоны ещё не добавлены.
              </td>
            </tr>
          ) : (
            lay.rolls.map((r) => (
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
                      onChange={(e) => onSetRollLayers(r.key, e.target.value)}
                      aria-label={`Слоёв в рулоне ${r.ordinal}`}
                    />
                  )}
                </td>
                {multiColor && (
                  <td>
                    {readOnly ? (
                      variants.find((v) => v.id === r.variantId)?.color ?? '—'
                    ) : (
                      <select
                        className="cutter-input"
                        value={r.variantId ?? ''}
                        onChange={(e) => onSetRollVariant(r.key, e.target.value)}
                        disabled={disabled}
                        aria-label={`Цвет рулона ${r.ordinal}`}
                      >
                        {variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.color}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                )}
                {!readOnly && (
                  <td>
                    <button
                      type="button"
                      className="constructor-btn constructor-btn--ghost cutter-roll-remove"
                      onClick={() => onRemoveRoll(r.key)}
                      disabled={disabled}
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
        Всего слоёв: <strong>{layLayers}</strong>
      </p>
      {!readOnly && (
        <button
          type="button"
          className="constructor-btn constructor-btn--ghost"
          onClick={onAddRoll}
          disabled={disabled}
        >
          + Добавить рулон
        </button>
      )}
    </section>
  );
}
