'use client';

/**
 * `OrderRouteOverridesEditor` — режим «Редактировать маршрут заказа» в
 * блоке «Операции» карточки заказа. Позволяет менеджеру переопределить
 * **в рамках этого заказа** (не меняя справочник операций и шаблон):
 *   - способ оплаты операции: Оклад ⇄ Сделка ⇄ Сделка по размерам;
 *   - расценку (₽/шт) — для сделки;
 *   - норму времени (сек/шт) — FIXED одно значение или BY_SIZE поразмерно.
 *
 * Вне режима редактирования рендерится `children` — обычная серверная
 * таблица операций. По кнопке вся таблица заменяется формой с инпутами и
 * одной кнопкой «Сохранить всё». Сабмит идёт через server action
 * `saveOrderRouteOverridesAction` → `PUT /orders/:id/route-overrides`.
 *
 * Пустой инпут = «без переопределения» (берётся дефолт операции,
 * показанный в placeholder). При переводе операции на сделку расценку
 * нужно задать, если у операции нет своей (`fixedRate`/поразмерной) —
 * иначе сохранение заблокировано. Источник истины — снимок маршрута
 * заказа; справочник операции не меняется.
 */

import { useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Pencil } from 'lucide-react';
import type { PricingMode } from '@sewing/shared/operations';
import type { UpdateOrderRouteOverridesDto } from '@sewing/shared/routes';
import { formatDurationSec } from '@/lib/operations-time-norm';
import { saveOrderRouteOverridesAction } from '@/app/admin/orders/[id]/route-overrides-actions';
import { initialRouteOverridesFormState } from '@/app/admin/orders/[id]/route-overrides-form-state';

export interface RouteOverrideEditorSize {
  id: string;
  code: string;
}

export interface RouteOverrideEditorStep {
  stepId: string;
  rowNumber: number;
  operationName: string;
  operationCode: string;
  /** Способ оплаты по справочнику операции (дефолт). */
  pricingMode: PricingMode | null;
  timeNormMode: 'FIXED' | 'BY_SIZE' | null;
  /** Дефолты операции — для placeholder / валидации. */
  fixedRate: number | null;
  timeNormSec: number | null;
  ratesBySize: Record<string, number>;
  timeNormsBySize: Record<string, number>;
  /** Текущие переопределения заказа. */
  pricingModeOverride: PricingMode | null;
  rateOverride: number | null;
  timeNormSecOverride: number | null;
  sizeOverrides: Record<string, { rate: number | null; seconds: number | null }>;
}

interface Props {
  orderId: string;
  sizes: RouteOverrideEditorSize[];
  steps: RouteOverrideEditorStep[];
  /** Серверная read-only таблица — показывается вне режима правки. */
  children: React.ReactNode;
}

type FieldMap = Record<string, string>;
type ModeMap = Record<string, PricingMode>;

const MODE_LABELS: Record<PricingMode, string> = {
  SALARY_ONLY: 'Оклад',
  FIXED: 'Сделка',
  BY_SIZE: 'Сделка по размерам',
};
const MODE_OPTIONS: PricingMode[] = ['SALARY_ONLY', 'FIXED', 'BY_SIZE'];

const rateKey = (stepId: string, sizeId?: string) =>
  sizeId ? `r:${stepId}:${sizeId}` : `r:${stepId}`;
const timeKey = (stepId: string, sizeId?: string) =>
  sizeId ? `t:${stepId}:${sizeId}` : `t:${stepId}`;

const numToStr = (v: number | null): string =>
  v != null && Number.isFinite(v) ? String(v) : '';

/** Эффективный способ оплаты операции в заказе (override ?? дефолт). */
function effectiveMode(step: RouteOverrideEditorStep): PricingMode {
  return step.pricingModeOverride ?? step.pricingMode ?? 'SALARY_ONLY';
}

function buildInitialModes(steps: RouteOverrideEditorStep[]): ModeMap {
  const out: ModeMap = {};
  for (const s of steps) out[s.stepId] = effectiveMode(s);
  return out;
}

function buildInitial(
  steps: RouteOverrideEditorStep[],
  sizes: RouteOverrideEditorSize[],
): FieldMap {
  // Инициализируем все возможные поля (режим может меняться на лету) из
  // текущих переопределений заказа; неиспользуемые ключи игнорируются.
  const out: FieldMap = {};
  for (const step of steps) {
    out[rateKey(step.stepId)] = numToStr(step.rateOverride);
    out[timeKey(step.stepId)] = numToStr(step.timeNormSecOverride);
    for (const sz of sizes) {
      const ov = step.sizeOverrides[sz.id];
      out[rateKey(step.stepId, sz.id)] = numToStr(ov?.rate ?? null);
      out[timeKey(step.stepId, sz.id)] = numToStr(ov?.seconds ?? null);
    }
  }
  return out;
}

interface Parsed {
  value: number | null;
  invalid: boolean;
}

function parseRate(s: string | undefined): Parsed {
  const t = (s ?? '').trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return { value: null, invalid: true };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-9) {
    return { value: n, invalid: true };
  }
  return { value: n, invalid: false };
}

function parseSec(s: string | undefined): Parsed {
  const t = (s ?? '').trim();
  if (t === '') return { value: null, invalid: false };
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return { value: null, invalid: true };
  }
  return { value: n, invalid: false };
}

type StepOverrideOut = {
  stepId: string;
  pricingModeOverride?: PricingMode | null;
  rateOverride?: number | null;
  timeNormSecOverride?: number | null;
  sizeOverrides?: { sizeId: string; rate: number | null; seconds: number | null }[];
};

function buildPayload(
  values: FieldMap,
  modes: ModeMap,
  steps: RouteOverrideEditorStep[],
  sizes: RouteOverrideEditorSize[],
): { dto: UpdateOrderRouteOverridesDto; invalid: boolean } {
  let invalid = false;
  const outSteps: StepOverrideOut[] = steps.map((step) => {
    const selMode = modes[step.stepId] ?? effectiveMode(step);
    const out: StepOverrideOut = { stepId: step.stepId };
    // null — если совпадает с дефолтом операции (нет переопределения).
    out.pricingModeOverride =
      step.pricingMode != null && selMode === step.pricingMode ? null : selMode;

    if (selMode === 'FIXED') {
      const p = parseRate(values[rateKey(step.stepId)]);
      if (p.invalid) invalid = true;
      // При сделке нужна расценка, если у операции нет своей fixedRate.
      if (p.value == null && step.fixedRate == null) invalid = true;
      out.rateOverride = p.value;
    }
    if (step.timeNormMode === 'FIXED') {
      const p = parseSec(values[timeKey(step.stepId)]);
      if (p.invalid) invalid = true;
      out.timeNormSecOverride = p.value;
    }
    if (selMode === 'BY_SIZE' || step.timeNormMode === 'BY_SIZE') {
      out.sizeOverrides = sizes.map((sz) => {
        let rate: number | null = null;
        let seconds: number | null = null;
        if (selMode === 'BY_SIZE') {
          const p = parseRate(values[rateKey(step.stepId, sz.id)]);
          if (p.invalid) invalid = true;
          if (p.value == null && step.ratesBySize[sz.id] == null) invalid = true;
          rate = p.value;
        }
        if (step.timeNormMode === 'BY_SIZE') {
          const p = parseSec(values[timeKey(step.stepId, sz.id)]);
          if (p.invalid) invalid = true;
          seconds = p.value;
        }
        return { sizeId: sz.id, rate, seconds };
      });
    }
    return out;
  });
  return { dto: { steps: outSteps }, invalid };
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={pending || disabled}
      data-testid="order-route-overrides-save"
    >
      {pending ? 'Сохраняем…' : 'Сохранить всё'}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width: 90,
  padding: '2px 6px',
  fontSize: '0.78rem',
};

export function OrderRouteOverridesEditor({
  orderId,
  sizes,
  steps,
  children,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<FieldMap>(() =>
    buildInitial(steps, sizes),
  );
  const [modes, setModes] = useState<ModeMap>(() => buildInitialModes(steps));
  const [state, formAction] = useFormState(
    saveOrderRouteOverridesAction.bind(null, orderId),
    initialRouteOverridesFormState,
  );

  // По успешному сохранению — выйти из режима правки (server action уже
  // ревалидировал страницу, серверная таблица перечитает снимок).
  useEffect(() => {
    if (state.ok && state.doneToken) setEditing(false);
  }, [state.ok, state.doneToken]);

  const built = useMemo(
    () => buildPayload(values, modes, steps, sizes),
    [values, modes, steps, sizes],
  );

  const setField = (key: string, val: string) =>
    setValues((prev) => ({ ...prev, [key]: val }));
  const setMode = (stepId: string, mode: PricingMode) =>
    setModes((prev) => ({ ...prev, [stepId]: mode }));

  const startEditing = () => {
    setValues(buildInitial(steps, sizes));
    setModes(buildInitialModes(steps));
    setEditing(true);
  };

  if (!editing) {
    return (
      <div data-testid="order-route-overrides-section">
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginBottom: 8,
          }}
        >
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={startEditing}
            disabled={steps.length === 0}
            title="Изменить способ оплаты, расценки и нормы операций в рамках этого заказа"
            data-testid="order-route-overrides-edit"
          >
            <Pencil size={14} strokeWidth={1.6} aria-hidden /> Редактировать
            маршрут заказа
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="order-route-overrides-editor"
      data-testid="order-route-overrides-editor"
    >
      <input type="hidden" name="payload" value={JSON.stringify(built.dto)} />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          marginBottom: 10,
        }}
      >
        <strong>Редактирование маршрута заказа</strong>
        <span className="admin-muted" style={{ fontSize: '0.78rem' }}>
          Способ оплаты, расценки и нормы действуют только в этом заказе и не
          меняют справочник операций.
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((step) => {
          const selMode = modes[step.stepId] ?? effectiveMode(step);
          const showSizeGrid =
            selMode === 'BY_SIZE' || step.timeNormMode === 'BY_SIZE';

          return (
            <div
              key={step.stepId}
              data-operation-code={step.operationCode}
              data-pricing-mode={selMode}
              style={{
                border: '1px solid var(--admin-border, #e5e7eb)',
                borderRadius: 8,
                padding: '8px 10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ minWidth: 22, fontWeight: 600 }}>
                  {step.rowNumber}
                </span>
                <span style={{ flex: '1 1 150px', fontWeight: 500 }}>
                  {step.operationName}
                </span>

                {/* Способ оплаты: Оклад / Сделка / Сделка по размерам */}
                <label
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                    Оплата
                  </span>
                  <select
                    value={selMode}
                    onChange={(e) =>
                      setMode(step.stepId, e.target.value as PricingMode)
                    }
                    style={{ padding: '2px 6px', fontSize: '0.78rem' }}
                    aria-label={`Способ оплаты операции ${step.operationName}`}
                  >
                    {MODE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>

                {/* Цена (только для сделки FIXED) */}
                {selMode === 'FIXED' && (
                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                      Цена
                    </span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      style={inputStyle}
                      value={values[rateKey(step.stepId)] ?? ''}
                      placeholder={
                        step.fixedRate != null ? String(step.fixedRate) : '—'
                      }
                      onChange={(e) =>
                        setField(rateKey(step.stepId), e.target.value)
                      }
                      aria-label={`Расценка операции ${step.operationName}, ₽/шт`}
                    />
                    <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                      ₽/шт
                    </span>
                  </label>
                )}

                {/* Норма времени FIXED (отдельная ось от оплаты) */}
                {step.timeNormMode === 'FIXED' && (
                  <label
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                      Норма
                    </span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step="1"
                      style={inputStyle}
                      value={values[timeKey(step.stepId)] ?? ''}
                      placeholder={
                        step.timeNormSec != null ? String(step.timeNormSec) : '—'
                      }
                      onChange={(e) =>
                        setField(timeKey(step.stepId), e.target.value)
                      }
                      aria-label={`Норма времени операции ${step.operationName}, сек/шт`}
                    />
                    <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                      сек/шт
                      {step.timeNormSec != null && (
                        <> · по умолч. {formatDurationSec(step.timeNormSec)}</>
                      )}
                    </span>
                  </label>
                )}
              </div>

              {/* Поразмерная под-сетка: расценка (если сделка по размерам)
                  и/или норма (если timeNormMode = BY_SIZE). */}
              {showSizeGrid && (
                <div
                  style={{
                    marginTop: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <span className="admin-muted" style={{ fontSize: '0.72rem' }}>
                    По размерам (пусто = ставка/норма операции):
                  </span>
                  {sizes.map((sz) => (
                    <div
                      key={sz.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{ minWidth: 48, fontSize: '0.78rem', fontWeight: 500 }}
                      >
                        {sz.code}
                      </span>
                      {selMode === 'BY_SIZE' && (
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="0.01"
                            style={inputStyle}
                            value={values[rateKey(step.stepId, sz.id)] ?? ''}
                            placeholder={
                              step.ratesBySize[sz.id] != null
                                ? String(step.ratesBySize[sz.id])
                                : '—'
                            }
                            onChange={(e) =>
                              setField(rateKey(step.stepId, sz.id), e.target.value)
                            }
                            aria-label={`Расценка ${step.operationName} для ${sz.code}, ₽/шт`}
                          />
                          <span
                            className="admin-muted"
                            style={{ fontSize: '0.72rem' }}
                          >
                            ₽/шт
                          </span>
                        </label>
                      )}
                      {step.timeNormMode === 'BY_SIZE' && (
                        <label
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            step="1"
                            style={inputStyle}
                            value={values[timeKey(step.stepId, sz.id)] ?? ''}
                            placeholder={
                              step.timeNormsBySize[sz.id] != null
                                ? String(step.timeNormsBySize[sz.id])
                                : '—'
                            }
                            onChange={(e) =>
                              setField(timeKey(step.stepId, sz.id), e.target.value)
                            }
                            aria-label={`Норма ${step.operationName} для ${sz.code}, сек/шт`}
                          />
                          <span
                            className="admin-muted"
                            style={{ fontSize: '0.72rem' }}
                          >
                            сек/шт
                          </span>
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {built.invalid && (
        <div
          role="alert"
          style={{ color: '#dc2626', fontSize: '0.78rem', marginTop: 8 }}
        >
          Проверьте значения: при переводе на сделку задайте расценку; расценка
          ≥ 0 (до 2 знаков), норма — целое число секунд ≥ 0.
        </div>
      )}
      {state.error && (
        <div
          role="alert"
          style={{ color: '#dc2626', fontSize: '0.78rem', marginTop: 8 }}
        >
          {state.error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <SaveButton disabled={built.invalid} />
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={() => {
            setValues(buildInitial(steps, sizes));
            setModes(buildInitialModes(steps));
            setEditing(false);
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
