'use client';

/**
 * `OrderRouteOverridesEditor` — режим «Редактировать маршрут заказа» в
 * блоке «Операции» карточки заказа. Позволяет менеджеру переопределить
 * **в рамках этого заказа** (не меняя справочник операций и шаблон):
 *   - способ оплаты операции: Оклад ⇄ Сделка ⇄ Сделка по размерам;
 *   - расценку (₽/шт) — для сделки;
 *   - норму времени (сек/шт) — FIXED одно значение или BY_SIZE поразмерно;
 *   - СТОРОННИЕ УСЛУГИ: метку «на стороне», цену размещения (₽/шт) и —
 *     если подрядчику отдан не весь тираж — объём по размерам.
 *
 * Вне режима редактирования рендерится `children` — обычная серверная
 * таблица операций. По кнопке вся таблица заменяется формой с инпутами и
 * одной кнопкой «Сохранить всё». Сабмит идёт через server action
 * `saveOrderRouteOverridesAction` → `PUT /orders/:id/route-overrides`.
 *
 * Пустой инпут = «без переопределения» (берётся дефолт операции,
 * показанный в placeholder). При переводе операции на сделку расценку
 * нужно задать, если у операции нет своей (`fixedRate`/поразмерной) —
 * иначе сохранение заблокировано. Исключение — операция, целиком ушедшая
 * на сторону: своя ставка по ней не нужна вовсе, требовать её значило бы
 * запереть форму на ровном месте. Источник истины — снимок маршрута
 * заказа; справочник операции не меняется.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { Pencil } from 'lucide-react';
import type { PricingMode } from '@sewing/shared/operations';
import {
  ROUTE_STEP_OUTSOURCED_QTY_MAX,
  type UpdateOrderRouteOverridesDto,
} from '@sewing/shared/routes';
import { saveOrderRouteOverridesAction } from '@/app/admin/orders/[id]/route-overrides-actions';
import { initialRouteOverridesFormState } from '@/app/admin/orders/[id]/route-overrides-form-state';

export interface RouteOverrideEditorSize {
  id: string;
  code: string;
  /**
   * План по размеру, шт — сумма всех строк заказа с этим размером (в
   * многовариантном заказе размер живёт в нескольких изделиях). Нужен
   * как потолок объёма, отдаваемого на сторону.
   */
  qtyPlan: number;
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
  /**
   * СТОРОННИЕ УСЛУГИ: операцию (частью или целиком) выполняет подрядчик.
   * Метка только про деньги — плановое время, доска, паспорта и ЗП её не
   * читают (решение владельца 10.09.2026).
   */
  outsourced: boolean;
  /** Цена стороннего размещения за одно изделие (₽) или `null`. */
  outsourcePriceRub: number | null;
  sizeOverrides: Record<
    string,
    {
      rate: number | null;
      seconds: number | null;
      /**
       * Сколько штук размера отдано подрядчику. `null` — объём по
       * размеру не расписан; если не расписан ни один размер, а метка
       * стоит — на стороне вся операция.
       */
      outsourcedQty: number | null;
    }
  >;
}

interface Props {
  orderId: string;
  sizes: RouteOverrideEditorSize[];
  steps: RouteOverrideEditorStep[];
  /**
   * Серверная read-only таблица — показывается вне режима правки. Не нужна
   * встроенному варианту (`embedded`), где редактор и так открыт.
   */
  children?: React.ReactNode;
  /**
   * `embedded` — редактор сразу открыт и рисуется без кнопки
   * «Редактировать маршрут заказа»: так он живёт вкладкой «Расценки» в
   * окне правки маршрута, где режим правки задаёт само окно. По умолчанию
   * `inline` — обёртка вокруг read-only таблицы во вкладке «Операции».
   */
  variant?: 'inline' | 'embedded';
  /** `embedded`: закрыть окно (кнопка «Отмена»). */
  onCancel?: () => void;
  /** `embedded`: успешное сохранение — окно закрывает вызывающая сторона. */
  onSaved?: () => void;
}

type FieldMap = Record<string, string>;
type ModeMap = Record<string, PricingMode>;
/** Метки «операция на стороне» по шагам маршрута. */
type FlagMap = Record<string, boolean>;

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
/** Цена стороннего размещения по операции, ₽/шт. */
const outPriceKey = (stepId: string) => `op:${stepId}`;
/** Объём этого размера, отданный подрядчику, шт. */
const outQtyKey = (stepId: string, sizeId: string) => `oq:${stepId}:${sizeId}`;

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

function buildInitialFlags(steps: RouteOverrideEditorStep[]): FlagMap {
  const out: FlagMap = {};
  for (const s of steps) out[s.stepId] = s.outsourced;
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
    out[outPriceKey(step.stepId)] = numToStr(step.outsourcePriceRub);
    for (const sz of sizes) {
      const ov = step.sizeOverrides[sz.id];
      out[rateKey(step.stepId, sz.id)] = numToStr(ov?.rate ?? null);
      out[timeKey(step.stepId, sz.id)] = numToStr(ov?.seconds ?? null);
      out[outQtyKey(step.stepId, sz.id)] = numToStr(ov?.outsourcedQty ?? null);
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

/**
 * Объём размера, отдаваемый подрядчику: формат тот же, что у нормы
 * времени (целое ≥ 0), плюс потолок «не больше плана этого размера».
 * Потолок проверяет и бэкенд (400), но кнопка не должна отправлять
 * заведомо плохое — менеджер увидит подсветку сразу, а не после сабмита.
 */
function parseOutQty(s: string | undefined, qtyPlan: number): Parsed {
  const p = parseSec(s);
  if (p.invalid || p.value == null) return p;
  if (p.value > qtyPlan || p.value > ROUTE_STEP_OUTSOURCED_QTY_MAX) {
    return { value: p.value, invalid: true };
  }
  return p;
}

type StepOverrideOut = {
  stepId: string;
  pricingModeOverride?: PricingMode | null;
  rateOverride?: number | null;
  timeNormSecOverride?: number | null;
  outsourced?: boolean;
  outsourcePriceRub?: number | null;
  sizeOverrides?: {
    sizeId: string;
    rate: number | null;
    seconds: number | null;
    outsourcedQty: number | null;
  }[];
};

function buildPayload(
  values: FieldMap,
  modes: ModeMap,
  flags: FlagMap,
  steps: RouteOverrideEditorStep[],
  sizes: RouteOverrideEditorSize[],
): { dto: UpdateOrderRouteOverridesDto; invalid: boolean } {
  let invalid = false;
  const outSteps: StepOverrideOut[] = steps.map((step) => {
    const selMode = modes[step.stepId] ?? effectiveMode(step);
    const isOut = flags[step.stepId] ?? step.outsourced;
    const out: StepOverrideOut = { stepId: step.stepId };
    // null — если совпадает с дефолтом операции (нет переопределения).
    out.pricingModeOverride =
      step.pricingMode != null && selMode === step.pricingMode ? null : selMode;

    // Объём на сторону разбираем ПЕРВЫМ: от него зависит, нужна ли шагу
    // своя расценка. «Метка есть, поразмерных количеств нет» = на стороне
    // ВЕСЬ тираж операции (ПРАВИЛО РАСЧЁТА), своя ставка тогда в план не
    // берётся вовсе — требовать её значило бы запереть форму.
    const outQtyBySize = new Map<string, number | null>();
    let hasOutQty = false;
    if (isOut) {
      for (const sz of sizes) {
        const p = parseOutQty(
          values[outQtyKey(step.stepId, sz.id)],
          sz.qtyPlan,
        );
        if (p.invalid) invalid = true;
        if (p.value != null) hasOutQty = true;
        outQtyBySize.set(sz.id, p.value);
      }
    }

    if (selMode === 'FIXED') {
      const p = parseRate(values[rateKey(step.stepId)]);
      if (p.invalid) invalid = true;
      // При сделке нужна расценка, если у операции нет своей fixedRate —
      // ⛔ в том числе у операции, целиком отданной подрядчику: метка
      // меняет только деньги плана, шаг остаётся в маршруте, и приёмщик
      // закрывает его сканом на возврате партии. Сделка без расценки этот
      // скан роняет (`OperationRateMissingException`), см. гард
      // `ORDER_ROUTE_OVERRIDE_RATE_REQUIRED` на бэкенде.
      if (p.value == null && step.fixedRate == null) {
        invalid = true;
      }
      out.rateOverride = p.value;
    }
    if (step.timeNormMode === 'FIXED') {
      const p = parseSec(values[timeKey(step.stepId)]);
      if (p.invalid) invalid = true;
      out.timeNormSecOverride = p.value;
    }

    // Метку и цену шлём, только когда подряд при чём: у обычной правки
    // расценки состав payload-а остаётся прежним. Снятую метку (`false`)
    // отправить обязаны — не переданное поле бэкенд трактует как
    // «не менять», и подряд остался бы включённым.
    if (isOut || step.outsourced) {
      out.outsourced = isOut;
      if (isOut) {
        const p = parseRate(values[outPriceKey(step.stepId)]);
        if (p.invalid) invalid = true;
        // Пустая цена законна: план посчитает размещение как 0 и вернёт
        // предупреждение — сохранить метку без цены менеджеру можно.
        out.outsourcePriceRub = p.value;
      } else {
        // Явный null: выключенный подряд не должен всплыть ценой при
        // повторном включении метки.
        out.outsourcePriceRub = null;
      }
    }

    const hadOutQty = Object.values(step.sizeOverrides).some(
      (o) => o.outsourcedQty != null,
    );
    const bySizeFields =
      selMode === 'BY_SIZE' || step.timeNormMode === 'BY_SIZE';
    // Поразмерный набор нужен не только BY_SIZE-режимам: объём на
    // сторону живёт в тех же строках. И наоборот — если объём уже
    // проставлен в снимке, набор надо слать даже ради его снятия, иначе
    // replace-all на бэкенде до этих строк просто не доберётся.
    // Набор уезжает replace-all, поэтому у шага с подрядом поле, которого
    // в форме сейчас нет (режим не поразмерный), переносим из снимка —
    // иначе строка с одним объёмом стёрла бы заведённые ранее поразмерные
    // ставки/нормы. Когда подряд ни при чём, поведение прежнее: поле не
    // показано — значит null.
    const keepHidden = isOut || step.outsourced;
    if (bySizeFields || hasOutQty || hadOutQty) {
      out.sizeOverrides = sizes.map((sz) => {
        const stored = step.sizeOverrides[sz.id];
        let rate: number | null = keepHidden ? (stored?.rate ?? null) : null;
        let seconds: number | null = keepHidden
          ? (stored?.seconds ?? null)
          : null;
        if (selMode === 'BY_SIZE') {
          const p = parseRate(values[rateKey(step.stepId, sz.id)]);
          if (p.invalid) invalid = true;
          // Поразмерная сделка — та же причина, что у FIXED выше: ставка
          // нужна и по отданному подрядчику размеру, иначе скан возврата
          // упадёт.
          if (p.value == null && step.ratesBySize[sz.id] == null) {
            invalid = true;
          }
          rate = p.value;
        }
        if (step.timeNormMode === 'BY_SIZE') {
          const p = parseSec(values[timeKey(step.stepId, sz.id)]);
          if (p.invalid) invalid = true;
          seconds = p.value;
        }
        return {
          sizeId: sz.id,
          rate,
          seconds,
          outsourcedQty: outQtyBySize.get(sz.id) ?? null,
        };
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
  width: '100%',
  padding: '3px 6px',
  fontSize: '0.8rem',
};

/**
 * Подсветка поля, значение которого бэкенд заведомо отобьёт (объём на
 * сторону больше плана размера). Кнопка в этот момент и так заблокирована
 * — подсветка показывает, КАКАЯ из строк виновата.
 */
const invalidInputStyle: React.CSSProperties = {
  borderColor: '#dc2626',
  background: '#fef2f2',
};

// Единая раскладка колонок строки операции: № · Операция · Оплата ·
// Цена · Норма · На стороне. Одинаковый шаблон в шапке и в строках
// выравнивает поля по столбцам (фикс-ширины + одна гибкая колонка
// имени). Последняя колонка держит чекбокс подряда и цену размещения —
// узкое окно правки маршрута (1040px) такую строку ещё вмещает.
const GRID_COLS = '30px minmax(140px, 1fr) 188px 116px 116px 168px';
const headerTitleStyle: React.CSSProperties = {
  fontSize: '0.7rem',
};

export function OrderRouteOverridesEditor({
  orderId,
  sizes,
  steps,
  children,
  variant = 'inline',
  onCancel,
  onSaved,
}: Props) {
  const embedded = variant === 'embedded';
  const [editing, setEditing] = useState(embedded);
  const [values, setValues] = useState<FieldMap>(() =>
    buildInitial(steps, sizes),
  );
  const [modes, setModes] = useState<ModeMap>(() => buildInitialModes(steps));
  const [flags, setFlags] = useState<FlagMap>(() => buildInitialFlags(steps));
  const [state, formAction] = useFormState(
    saveOrderRouteOverridesAction.bind(null, orderId),
    initialRouteOverridesFormState,
  );

  // По успешному сохранению — выйти из режима правки (server action уже
  // ревалидировал страницу, серверная таблица перечитает снимок). Во
  // встроенном варианте выходить некуда: закрывает окно вызывающая сторона.
  useEffect(() => {
    if (!state.ok || !state.doneToken) return;
    if (embedded) onSaved?.();
    else setEditing(false);
  }, [state.ok, state.doneToken, embedded, onSaved]);

  const built = useMemo(
    () => buildPayload(values, modes, flags, steps, sizes),
    [values, modes, flags, steps, sizes],
  );

  const setField = (key: string, val: string) =>
    setValues((prev) => ({ ...prev, [key]: val }));
  const setMode = (stepId: string, mode: PricingMode) =>
    setModes((prev) => ({ ...prev, [stepId]: mode }));
  const setFlag = (stepId: string, on: boolean) =>
    setFlags((prev) => ({ ...prev, [stepId]: on }));

  const startEditing = () => {
    setValues(buildInitial(steps, sizes));
    setModes(buildInitialModes(steps));
    setFlags(buildInitialFlags(steps));
    setEditing(true);
  };

  if (!editing && !embedded) {
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
          меняют справочник операций. Метка «На стороне» меняет только деньги:
          по отданному объёму в план идёт цена размещения вместо своей
          стоимости, а плановое время, доска и ЗП остаются как были.
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLS,
          columnGap: 12,
          rowGap: 8,
          alignItems: 'center',
        }}
      >
        {/* Шапка столбцов — единицы измерения тут, чтобы ячейки строк
            оставались голыми инпутами и ровно вставали в столбцы. */}
        <div />
        <div className="admin-muted" style={headerTitleStyle}>
          Операция
        </div>
        <div className="admin-muted" style={headerTitleStyle}>
          Оплата
        </div>
        <div className="admin-muted" style={headerTitleStyle}>
          Цена, ₽/шт
        </div>
        <div className="admin-muted" style={headerTitleStyle}>
          Норма, сек/шт
        </div>
        <div className="admin-muted" style={headerTitleStyle}>
          На стороне
        </div>

        {steps.map((step, i) => {
          const selMode = modes[step.stepId] ?? effectiveMode(step);
          const showSizeGrid =
            selMode === 'BY_SIZE' || step.timeNormMode === 'BY_SIZE';
          const isOut = flags[step.stepId] ?? step.outsourced;

          return (
            <Fragment key={step.stepId}>
              {/* Разделитель между операциями (на всю ширину). */}
              {i > 0 && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    borderTop: '1px solid var(--admin-border, #eef0f3)',
                  }}
                />
              )}

              {/* № */}
              <div style={{ fontWeight: 600, textAlign: 'right' }}>
                {step.rowNumber}
              </div>

              {/* Операция */}
              <div
                data-operation-code={step.operationCode}
                data-pricing-mode={selMode}
                style={{ fontWeight: 500, minWidth: 0 }}
              >
                {step.operationName}
              </div>

              {/* Оплата */}
              <select
                value={selMode}
                onChange={(e) =>
                  setMode(step.stepId, e.target.value as PricingMode)
                }
                style={{ width: '100%', padding: '3px 6px', fontSize: '0.8rem' }}
                aria-label={`Способ оплаты операции ${step.operationName}`}
              >
                {MODE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>

              {/* Цена */}
              <div>
                {selMode === 'FIXED' ? (
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
                ) : (
                  <span className="admin-muted" style={{ fontSize: '0.74rem' }}>
                    {selMode === 'BY_SIZE' ? 'по размерам ↓' : '—'}
                  </span>
                )}
              </div>

              {/* Норма */}
              <div>
                {step.timeNormMode === 'FIXED' ? (
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
                ) : (
                  <span className="admin-muted" style={{ fontSize: '0.74rem' }}>
                    {step.timeNormMode === 'BY_SIZE' ? 'по размерам ↓' : '—'}
                  </span>
                )}
              </div>

              {/* На стороне: метка подряда + цена размещения. Цена
                  показывается только под включённой меткой — без неё это
                  поле ни на что не влияет и только путало бы. */}
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                data-outsourced={isOut ? '1' : '0'}
              >
                <input
                  type="checkbox"
                  checked={isOut}
                  onChange={(e) => setFlag(step.stepId, e.target.checked)}
                  aria-label={`Операция ${step.operationName} делается на стороне`}
                  title="Операцию (полностью или частью тиража) выполняет подрядчик: вместо своей стоимости в план идёт цена размещения"
                  data-testid={`order-route-overrides-outsourced-${step.stepId}`}
                />
                {isOut ? (
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    style={{ ...inputStyle, minWidth: 0 }}
                    value={values[outPriceKey(step.stepId)] ?? ''}
                    placeholder="Цена, ₽/шт"
                    onChange={(e) =>
                      setField(outPriceKey(step.stepId), e.target.value)
                    }
                    title="Цена размещения, ₽/шт"
                    aria-label={`Цена размещения операции ${step.operationName}, ₽/шт`}
                    data-testid={`order-route-overrides-outsource-price-${step.stepId}`}
                  />
                ) : (
                  <span className="admin-muted" style={{ fontSize: '0.74rem' }}>
                    —
                  </span>
                )}
              </div>

              {/* Поразмерная под-сетка (на всю ширину строки): расценка
                  (если сделка по размерам) и/или норма (BY_SIZE). */}
              {showSizeGrid && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    paddingLeft: 42,
                    paddingTop: 2,
                    paddingBottom: 2,
                  }}
                >
                  <div
                    className="admin-muted"
                    style={{ fontSize: '0.72rem', marginBottom: 4 }}
                  >
                    По размерам (пусто = ставка/норма операции):
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '56px 116px 116px',
                      columnGap: 12,
                      rowGap: 4,
                      alignItems: 'center',
                    }}
                  >
                    <div className="admin-muted" style={headerTitleStyle}>
                      Размер
                    </div>
                    <div className="admin-muted" style={headerTitleStyle}>
                      {selMode === 'BY_SIZE' ? 'Цена, ₽/шт' : ''}
                    </div>
                    <div className="admin-muted" style={headerTitleStyle}>
                      {step.timeNormMode === 'BY_SIZE' ? 'Норма, сек/шт' : ''}
                    </div>
                    {sizes.map((sz) => (
                      <Fragment key={sz.id}>
                        <div style={{ fontWeight: 500, fontSize: '0.78rem' }}>
                          {sz.code}
                        </div>
                        <div>
                          {selMode === 'BY_SIZE' ? (
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
                                setField(
                                  rateKey(step.stepId, sz.id),
                                  e.target.value,
                                )
                              }
                              aria-label={`Расценка ${step.operationName} для ${sz.code}, ₽/шт`}
                            />
                          ) : null}
                        </div>
                        <div>
                          {step.timeNormMode === 'BY_SIZE' ? (
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
                                setField(
                                  timeKey(step.stepId, sz.id),
                                  e.target.value,
                                )
                              }
                              aria-label={`Норма ${step.operationName} для ${sz.code}, сек/шт`}
                            />
                          ) : null}
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* Объём на сторону — компактная сетка «размер · план · на
                  сторону». Пустая сетка означает «подрядчику отдана вся
                  операция» (ПРАВИЛО РАСЧЁТА), поэтому подпись объясняет
                  пустоту: иначе её читают как «ничего не отдано». */}
              {isOut && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    paddingLeft: 42,
                    paddingTop: 2,
                    paddingBottom: 2,
                  }}
                  data-testid={`order-route-overrides-outsource-sizes-${step.stepId}`}
                >
                  <div
                    className="admin-muted"
                    style={{ fontSize: '0.72rem', marginBottom: 4 }}
                  >
                    Объём на сторону, шт (пусто = вся операция на стороне):
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '56px 64px 96px',
                      columnGap: 12,
                      rowGap: 4,
                      alignItems: 'center',
                    }}
                  >
                    <div className="admin-muted" style={headerTitleStyle}>
                      Размер
                    </div>
                    <div className="admin-muted" style={headerTitleStyle}>
                      План
                    </div>
                    <div className="admin-muted" style={headerTitleStyle}>
                      На сторону
                    </div>
                    {sizes.map((sz) => {
                      const qty = parseOutQty(
                        values[outQtyKey(step.stepId, sz.id)],
                        sz.qtyPlan,
                      );
                      return (
                        <Fragment key={sz.id}>
                          <div style={{ fontWeight: 500, fontSize: '0.78rem' }}>
                            {sz.code}
                          </div>
                          <div
                            className="admin-muted"
                            style={{ fontSize: '0.78rem' }}
                          >
                            {sz.qtyPlan.toLocaleString('ru-RU')}
                          </div>
                          <div>
                            <input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={sz.qtyPlan}
                              step="1"
                              style={
                                qty.invalid
                                  ? { ...inputStyle, ...invalidInputStyle }
                                  : inputStyle
                              }
                              value={
                                values[outQtyKey(step.stepId, sz.id)] ?? ''
                              }
                              placeholder="—"
                              onChange={(e) =>
                                setField(
                                  outQtyKey(step.stepId, sz.id),
                                  e.target.value,
                                )
                              }
                              aria-invalid={qty.invalid || undefined}
                              aria-label={`Объём на сторону ${step.operationName} для ${sz.code}, шт (план ${sz.qtyPlan})`}
                              data-testid={`order-route-overrides-outsource-qty-${step.stepId}-${sz.id}`}
                            />
                          </div>
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
            </Fragment>
          );
        })}
      </div>

      {built.invalid && (
        <div
          role="alert"
          style={{ color: '#dc2626', fontSize: '0.78rem', marginTop: 8 }}
        >
          Проверьте значения: при переводе на сделку задайте расценку; расценка
          ≥ 0 (до 2 знаков), норма — целое число секунд ≥ 0; объём на сторону —
          целое число штук, не больше плана размера.
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
            setFlags(buildInitialFlags(steps));
            if (embedded) onCancel?.();
            else setEditing(false);
          }}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}
