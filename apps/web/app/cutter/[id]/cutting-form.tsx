'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  CUTTING_TASK_MAX_LAYERS,
  CUTTING_TASK_MAX_LAYS,
  CUTTING_TASK_MAX_PER_LAYER_QTY,
  CUTTING_TASK_MAX_ROLLS,
  listCuttingCompletionProblems,
  listLayCompletionProblems,
  type CuttingTaskLayDto,
  type CuttingTaskSizeRowDto,
  type CuttingTaskVariantDto,
  type SaveCuttingTaskProgressDto,
} from '@sewing/shared/cutting-tasks';
import {
  completeCuttingLayAction,
  completeCuttingTaskAction,
  reopenCuttingLayAction,
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
  /**
   * Номер расклада на сервере (`CuttingTaskLay.ordinal`). `null` — расклад
   * ещё не сохранён (создан кнопкой «+ Добавить расклад»), номер выдаст
   * backend.
   *
   * Обязателен в payload для существующих раскладов: сохранение — merge по
   * `ordinal`, а не replace. Без него каждый автосейв пересоздавал бы
   * расклады с новыми номерами, а `Passport.cuttingLayOrdinal` выпущенных
   * паспортов указывал бы на чужой настил.
   */
  ordinal: number | null;
  /** Частичное завершение: момент «Расклад готов» (ISO) или `null`. */
  completedAt: string | null;
  /** Кто закрыл расклад — подпись в шапке закрытого расклада. */
  completedByName: string | null;
  /** Сколько паспортов по раскладу уже выпущено / ожидается. */
  releasedPassports: number;
  totalPassports: number;
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

/**
 * Поля нового (ещё не сохранённого) расклада: номера нет — его выдаст
 * backend при первом сохранении (append-only, max+1); закрытым он,
 * очевидно, тоже быть не может.
 */
const NEW_LAY_META = {
  ordinal: null,
  completedAt: null,
  completedByName: null,
  releasedPassports: 0,
  totalPassports: 0,
} as const;

function layFromDto(dto: CuttingTaskLayDto): LayDraft {
  const sizes: Record<string, string> = {};
  for (const s of dto.sizes) {
    if (s.sizeId) sizes[s.sizeId] = s.perLayerQty === 0 ? '' : String(s.perLayerQty);
  }
  return {
    key: `lay-${dto.id}`,
    ordinal: dto.ordinal,
    completedAt: dto.completedAt,
    completedByName: dto.completedByName,
    releasedPassports: dto.releasedPassports,
    totalPassports: dto.totalPassports,
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
    return [{ key: 'lay-init-1', ...NEW_LAY_META, sizes: {}, rolls: [] }];
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
        : [
            ...prev,
            { key: nextKey('lay'), ...NEW_LAY_META, sizes: {}, rolls: [] },
          ],
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
      // ЗАКРЫТЫЕ расклады в payload не отправляем: backend их не принимает
      // (`CUTTING_LAY_LOCKED`) и их отсутствие для него — норма. Открытые
      // идут со своим `ordinal`, чтобы сохранение обновило их, а не
      // создало копии; новые — без `ordinal` (номер выдаст backend).
      lays: layDrafts
        .filter((lay) => !lay.completedAt)
        .map((lay) => ({
          ...(lay.ordinal != null ? { ordinal: lay.ordinal } : {}),
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
    const payload = buildPayload();
    // Зеркало backend-гейта (`CUTTING_TASK_COMPLETION_INCOMPLETE`):
    // завершать можно только полностью заполненный настил — раскройщик
    // видит, что именно не заполнено, без похода на сервер.
    const problems = listCuttingCompletionProblems(
      payload.lays,
      (sizeId) =>
        selectableSizes.find((r) => r.sizeId === sizeId)?.sizeCodeSnapshot ??
        sizeId,
    );
    if (problems.length > 0) {
      setError(`Нельзя завершить раскрой: ${problems.join('; ')}.`);
      return;
    }
    const ok = window.confirm(
      'Завершить раскрой? После завершения задача станет недоступна для редактирования.',
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await completeCuttingTaskAction(taskId, payload);
      if (!result.ok) setError(result.error ?? 'Не удалось завершить раскрой');
      else router.refresh();
    });
  }

  // --- Частичное завершение раскроя ----------------------------------------

  /**
   * Что мешает закрыть расклад — зеркало backend-гейта
   * (`CUTTING_LAY_COMPLETION_INCOMPLETE`), те же формулировки. Пустой
   * список = кнопка «Расклад готов» активна.
   */
  function layProblems(lay: LayDraft): string[] {
    return listLayCompletionProblems(
      {
        laySizes: Object.entries(lay.sizes).map(([sizeId, v]) => ({
          sizeId,
          perLayerQty: clampInt(v, CUTTING_TASK_MAX_PER_LAYER_QTY),
        })),
        rolls: lay.rolls.map((r) => ({
          ordinal: r.ordinal,
          layers: clampInt(r.layers, CUTTING_TASK_MAX_LAYERS),
          variantId: r.variantId,
        })),
      },
      (sizeId) =>
        selectableSizes.find((r) => r.sizeId === sizeId)?.sizeCodeSnapshot ??
        sizeId,
    );
  }

  /**
   * «Расклад готов» — закрыть один расклад, не завершая раскрой заказа.
   * Сначала сохраняем прогресс (backend закрывает то, что лежит в БД),
   * потом закрываем. Для нового, ещё не сохранённого расклада номер
   * приходит только после сохранения — поэтому просим сохранить и повторить.
   */
  function handleCompleteLay(lay: LayDraft) {
    setError(null);
    setSavedNote(null);
    const problems = layProblems(lay);
    if (problems.length > 0) {
      setError(`Нельзя закрыть расклад: ${problems.join('; ')}.`);
      return;
    }
    const total = lay.rolls.reduce(
      (n, r) => n + (clampInt(r.layers, CUTTING_TASK_MAX_LAYERS) > 0 ? 1 : 0),
      0,
    ) * Object.keys(lay.sizes).length;
    const ok = window.confirm(
      `Закрыть расклад? Появится ${total} паспорт(ов) к выпуску. ` +
        'После закрытия настил нельзя править — открыть расклад можно, ' +
        'пока по нему не выпущен ни один паспорт.',
    );
    if (!ok) return;
    startTransition(async () => {
      // Сохраняем текущее состояние формы: закрытие проверяет БД.
      const saved = await saveCuttingProgressAction(taskId, buildPayload());
      if (!saved.ok) {
        setError(saved.error ?? 'Не удалось сохранить');
        return;
      }
      const ordinal = lay.ordinal ?? saved.ordinals?.[laySlotIndex(lay)] ?? null;
      if (ordinal == null) {
        setError('Расклад сохранён — нажмите «Расклад готов» ещё раз.');
        router.refresh();
        return;
      }
      const result = await completeCuttingLayAction(taskId, ordinal);
      if (!result.ok) setError(result.error ?? 'Не удалось закрыть расклад');
      else router.refresh();
    });
  }

  /** Индекс расклада среди отправленных (открытых) — для сопоставления с ответом. */
  function laySlotIndex(lay: LayDraft): number {
    return layDrafts.filter((l) => !l.completedAt).findIndex((l) => l.key === lay.key);
  }

  /** «Открыть расклад» — снять закрытие, если по нему нет паспортов. */
  function handleReopenLay(lay: LayDraft) {
    setError(null);
    if (lay.ordinal == null) return;
    if (lay.releasedPassports > 0) {
      setError(
        `По раскладу уже выпущено паспортов: ${lay.releasedPassports}. ` +
          'Сначала удалите их в «Выпущенных паспортах».',
      );
      return;
    }
    const ok = window.confirm(
      'Открыть расклад для правок? Выпуск паспортов по нему станет недоступен, ' +
        'пока вы не закроете его снова.',
    );
    if (!ok) return;
    startTransition(async () => {
      const result = await reopenCuttingLayAction(taskId, lay.ordinal as number);
      if (!result.ok) setError(result.error ?? 'Не удалось открыть расклад');
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
            // Номер — серверный (`CuttingTaskLay.ordinal`), а не индекс:
            // после закрытия/удаления раскладов индекс расходится с тем,
            // что записано в паспортах (`Расклад N · Рулон M`).
            ordinal={lay.ordinal ?? idx + 1}
            readOnly={readOnly || !!lay.completedAt}
            canRemove={
              !readOnly &&
              !lay.completedAt &&
              layDrafts.filter((l) => !l.completedAt).length > 1
            }
            problems={lay.completedAt ? [] : layProblems(lay)}
            onCompleteLay={() => handleCompleteLay(lay)}
            onReopenLay={() => handleReopenLay(lay)}
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
  /**
   * Частичное завершение: что мешает закрыть этот расклад (пусто = можно).
   * Для уже закрытого расклада всегда пусто.
   */
  problems: string[];
  onCompleteLay: () => void;
  onReopenLay: () => void;
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
  problems,
  onCompleteLay,
  onReopenLay,
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
    <section
      className={
        'constructor-card-block cutter-lay' +
        (lay.completedAt ? ' cutter-lay--closed' : '')
      }
    >
      <div className="constructor-card-block__head cutter-lay__head">
        <h2 className="constructor-card-block__title">Расклад {ordinal}</h2>
        {lay.completedAt ? (
          <span className="constructor-status constructor-status--done">
            Закрыт
          </span>
        ) : null}
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
        {lay.completedAt ? (
          <>
            {' · паспорта: '}
            <strong>
              {lay.releasedPassports} из {lay.totalPassports}
            </strong>
          </>
        ) : null}
      </p>

      {/*
       * Частичное завершение раскроя. Открытый расклад: «Расклад готов»
       * (гаснет, пока настил не заполнен — причины показываем рядом теми же
       * словами, что и backend). Закрытый: подпись «кто закрыл» + «Открыть
       * расклад», доступный пока по раскладу нет выпущенных паспортов.
       */}
      {lay.completedAt ? (
        <div className="cutter-lay__foot">
          <p className="cutter-lay__closed-note">
            Настил закрыт
            {lay.completedByName ? `, закрыл ${lay.completedByName}` : ''} — правки
            недоступны.{' '}
            {lay.releasedPassports > 0
              ? `По раскладу выпущено паспортов: ${lay.releasedPassports}, открыть его можно только после их удаления.`
              : 'Паспортов по нему ещё нет — расклад можно открыть.'}
          </p>
          <button
            type="button"
            className="constructor-btn constructor-btn--ghost"
            onClick={onReopenLay}
            disabled={disabled || lay.releasedPassports > 0}
          >
            Открыть расклад
          </button>
        </div>
      ) : (
        <>
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
          {!readOnly && (
            <div className="cutter-lay__foot">
              <button
                type="button"
                className="constructor-btn constructor-btn--primary"
                onClick={onCompleteLay}
                disabled={disabled || problems.length > 0}
                title={
                  problems.length > 0
                    ? `Нельзя закрыть: ${problems.join('; ')}`
                    : 'Закрыть расклад — по нему можно будет выпускать паспорта'
                }
              >
                Расклад готов
              </button>
              {problems.length > 0 && (
                <p className="cutter-lay__problems">
                  Закрыть нельзя: {problems.join('; ')}.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
