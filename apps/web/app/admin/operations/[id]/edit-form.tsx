'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import {
  OPERATION_CATEGORIES,
  OPERATION_CATEGORY_LABELS,
  PRICING_MODES,
  TIME_NORM_MODES,
  TIME_NORM_MODE_LABELS,
  type OperationDetailDto,
  type PricingMode,
  type TimeNormMode,
} from '@sewing/shared/operations';
import { CheckCircle2, Plus, Save, XCircle } from 'lucide-react';
import { splitSeconds } from '@/lib/operations-time-norm';
import { updateOperationAction } from '../actions';
import {
  initialUpdateOperationState,
  type UpdateOperationState,
} from '../form-state';

const PRICING_LABEL: Record<PricingMode, string> = {
  FIXED: 'Фиксированная ставка',
  BY_SIZE: 'По размерам (для оверлока)',
  SALARY_ONLY: 'Окладная (без сдельной ставки)',
};

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="admin-btn admin-btn--primary" disabled={pending}>
      <Save size={16} strokeWidth={1.6} aria-hidden />
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

interface Props {
  operation: OperationDetailDto;
}

/**
 * Форма редактирования операции на `/admin/operations/[id]`.
 *
 * Логика UX (см. `docs/screens.md §10c`):
 *
 *   - meta (`name`, `category`, `isActive`) — всегда видно;
 *   - переключатель `pricingMode` (FIXED | BY_SIZE | SALARY_ONLY)
 *     перерисовывает блок ставок:
 *       * FIXED       → одно поле «Ставка за единицу»;
 *       * BY_SIZE     → таблица «размер → ставка», заранее
 *         подставлена текущими значениями. Кнопка «Заполнить всем
 *         одну ставку» — bulk-helper для типового кейса оверлока.
 *       * SALARY_ONLY → явная пометка «сдельная ставка не используется»;
 *   - один Save шлёт всё в `PATCH /api/operations/:id`. Backend
 *     атомарно меняет `pricingMode`, `fixedRate` и таблицу
 *     `OperationRateBySize` в одной транзакции (см. ADR-0017).
 *
 * `code` менеджер не меняет — это управленческий ID, на который
 * завязаны pipeline и сиды (`prisma/seed.ts`). Если очень надо —
 * заводите новую операцию и деактивируете старую.
 */
export function OperationEditForm({ operation }: Props) {
  const [pricingMode, setPricingMode] = useState<PricingMode>(
    operation.pricingMode,
  );
  const [bulkValue, setBulkValue] = useState<string>('');
  const [rateInputs, setRateInputs] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const r of operation.ratesBySize) {
      initial[r.sizeId] = r.rate.toFixed(2);
    }
    return initial;
  });

  // --- Норма времени (отдельная ось, см. recon §10) ---
  const [timeNormMode, setTimeNormMode] = useState<TimeNormMode>(
    operation.timeNormMode,
  );
  const fixedSplit = useMemo(
    () => splitSeconds(operation.timeNormSec),
    [operation.timeNormSec],
  );
  const [fixedMin, setFixedMin] = useState<string>(
    operation.timeNormSec !== null && operation.timeNormSec > 0
      ? String(fixedSplit.minutes)
      : '',
  );
  const [fixedSec, setFixedSec] = useState<string>(
    operation.timeNormSec !== null && operation.timeNormSec > 0
      ? String(fixedSplit.seconds)
      : '',
  );
  const [bulkTimeMin, setBulkTimeMin] = useState<string>('');
  const [bulkTimeSec, setBulkTimeSec] = useState<string>('');
  const [timeMinInputs, setTimeMinInputs] = useState<Record<string, string>>(
    () => {
      const initial: Record<string, string> = {};
      for (const r of operation.timeNormsBySize) {
        const sp = splitSeconds(r.seconds);
        initial[r.sizeId] = String(sp.minutes);
      }
      return initial;
    },
  );
  const [timeSecInputs, setTimeSecInputs] = useState<Record<string, string>>(
    () => {
      const initial: Record<string, string> = {};
      for (const r of operation.timeNormsBySize) {
        const sp = splitSeconds(r.seconds);
        initial[r.sizeId] = String(sp.seconds);
      }
      return initial;
    },
  );

  // --- Плановая окладная стоимость (см. ТЗ «Плановая стоимость
  // окладных операций»). Отдельная ось — поле полезно для
  // pricingMode = SALARY_ONLY, но допустимо и для других. ---
  const initialSalaryRub =
    operation.salaryPlanRubPerShift !== null
      ? Number(operation.salaryPlanRubPerShift).toFixed(2)
      : '';
  const initialSalaryHours = (() => {
    const secs = operation.salaryPlanShiftSeconds;
    if (secs == null || !Number.isFinite(secs) || secs <= 0) return '8';
    const hours = secs / 3600;
    return Number.isInteger(hours) ? String(hours) : hours.toFixed(2);
  })();

  const update = updateOperationAction.bind(null, operation.id);
  const [state, formAction] = useFormState<UpdateOperationState, FormData>(
    update,
    initialUpdateOperationState,
  );

  const sizesById = useMemo(() => {
    const map = new Map<string, { code: string; sortOrder: number }>();
    for (const s of operation.sizes) {
      map.set(s.id, { code: s.code, sortOrder: s.sortOrder });
    }
    return map;
  }, [operation.sizes]);

  function setBulkAll() {
    if (bulkValue.trim().length === 0) return;
    const next: Record<string, string> = {};
    for (const s of operation.sizes) next[s.id] = bulkValue.trim();
    setRateInputs(next);
  }

  function applyTimeBulkAll() {
    const min = bulkTimeMin.trim();
    const sec = bulkTimeSec.trim();
    if (min.length === 0 && sec.length === 0) return;
    const nextMin: Record<string, string> = {};
    const nextSec: Record<string, string> = {};
    for (const s of operation.sizes) {
      nextMin[s.id] = min;
      nextSec[s.id] = sec;
    }
    setTimeMinInputs(nextMin);
    setTimeSecInputs(nextSec);
  }

  return (
    <form action={formAction} className="admin-form">
      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="op-name">Название</label>
          <input
            id="op-name"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={operation.name}
            required
            autoComplete="off"
          />
        </div>

        <div className="admin-field">
          <label htmlFor="op-category">Категория</label>
          <select
            id="op-category"
            name="category"
            defaultValue={operation.category}
          >
            {OPERATION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {OPERATION_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        <div className="admin-field admin-field--inline">
          <input
            id="op-is-active"
            type="checkbox"
            name="isActive"
            defaultChecked={operation.isActive}
          />
          <label htmlFor="op-is-active">Активна</label>
        </div>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="op-pricing-mode">Тип тарифа</label>
          <select
            id="op-pricing-mode"
            name="pricingMode"
            value={pricingMode}
            onChange={(e) => setPricingMode(e.target.value as PricingMode)}
          >
            {PRICING_MODES.map((m) => (
              <option key={m} value={m}>
                {PRICING_LABEL[m]}
              </option>
            ))}
          </select>
        </div>

        {pricingMode === 'FIXED' && (
          <div className="admin-field">
            <label htmlFor="op-fixed-rate">Ставка за единицу, ₽</label>
            <input
              id="op-fixed-rate"
              name="fixedRate"
              type="text"
              inputMode="decimal"
              defaultValue={
                operation.fixedRate !== null
                  ? operation.fixedRate.toFixed(2)
                  : ''
              }
              placeholder="напр. 12.50"
              required
              autoComplete="off"
            />
          </div>
        )}
      </div>

      {pricingMode === 'BY_SIZE' && (
        <div
          className="section-card"
          style={{
            background: 'var(--admin-primary-soft)',
            padding: 'var(--admin-space-md)',
            borderRadius: '10px',
          }}
        >
          <div className="section-header" style={{ marginBottom: '0.5rem' }}>
            <h2 className="admin-section-title" style={{ margin: 0 }}>
              Ставки по размерам
            </h2>
            <span className="admin-muted" style={{ fontSize: '0.85rem' }}>
              {operation.ratesBySize.length} / {sizesById.size}
            </span>
          </div>
          <p className="admin-muted" style={{ marginTop: 0, fontSize: '0.88rem' }}>
            Пустые поля = «нет ставки», строка будет удалена.
          </p>

          <div className="admin-actions-row" style={{ marginBottom: '0.75rem', justifyContent: 'flex-start' }}>
            <input
              type="text"
              inputMode="decimal"
              placeholder="напр. 15.00"
              value={bulkValue}
              onChange={(e) => setBulkValue(e.target.value)}
              style={{ width: 160 }}
            />
            <button
              type="button"
              className="admin-btn"
              onClick={setBulkAll}
              disabled={bulkValue.trim().length === 0}
            >
              <Plus size={14} strokeWidth={1.6} aria-hidden />
              Заполнить всем
            </button>
          </div>

          {operation.sizes.length === 0 ? (
            <div className="admin-muted" style={{ fontSize: '0.88rem' }}>
              В справочнике размеров нет строк — добавьте их, чтобы задать ставки.
            </div>
          ) : (
            <div className="rate-table-grid">
              {operation.sizes.map((s) => (
                <label key={s.id} className="rate-cell">
                  <span className="rate-cell__size">{s.code}</span>
                  <input
                    name={`rate-${s.id}`}
                    type="text"
                    inputMode="decimal"
                    value={rateInputs[s.id] ?? ''}
                    onChange={(e) =>
                      setRateInputs((prev) => ({
                        ...prev,
                        [s.id]: e.target.value,
                      }))
                    }
                    placeholder="—"
                    className="rate-cell__input"
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        Норма времени — отдельная ось от тарифа: операция может быть
        SALARY_ONLY (без сдельной ставки), но с плановой нормой времени
        (см. `docs/operation-time-norms-recon.md §10`).
        Хранится в БД в секундах; в UI вводим «минуты + секунды».
      */}
      <div
        className="section-card"
        style={{
          background: 'var(--admin-bg-soft, #f6f7f9)',
          padding: 'var(--admin-space-md)',
          borderRadius: '10px',
        }}
      >
        <div className="section-header" style={{ marginBottom: '0.5rem' }}>
          <h2 className="admin-section-title" style={{ margin: 0 }}>
            Норма времени
          </h2>
        </div>

        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="op-time-norm-mode">Режим</label>
            <select
              id="op-time-norm-mode"
              name="timeNormMode"
              value={timeNormMode}
              onChange={(e) =>
                setTimeNormMode(e.target.value as TimeNormMode)
              }
            >
              {TIME_NORM_MODES.map((m) => (
                <option key={m} value={m}>
                  {TIME_NORM_MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </div>

          {timeNormMode === 'FIXED' && (
            <>
              <div className="admin-field">
                <label htmlFor="op-time-norm-min">Минуты</label>
                <input
                  id="op-time-norm-min"
                  name="timeNormMin"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={fixedMin}
                  onChange={(e) => setFixedMin(e.target.value)}
                  placeholder="0"
                  autoComplete="off"
                />
              </div>
              <div className="admin-field">
                <label htmlFor="op-time-norm-sec">Секунды</label>
                <input
                  id="op-time-norm-sec"
                  name="timeNormSecPart"
                  type="number"
                  min={0}
                  max={59}
                  step={1}
                  inputMode="numeric"
                  value={fixedSec}
                  onChange={(e) => setFixedSec(e.target.value)}
                  placeholder="0"
                  autoComplete="off"
                />
              </div>
            </>
          )}
        </div>

        {timeNormMode === 'BY_SIZE' && (
          <div style={{ marginTop: '0.5rem' }}>
            <p
              className="admin-muted"
              style={{ marginTop: 0, fontSize: '0.88rem' }}
            >
              Пустые поля = «норма не задана для этого размера».
            </p>

            <div className="operation-time-bulk-row">
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                placeholder="мин"
                value={bulkTimeMin}
                onChange={(e) => setBulkTimeMin(e.target.value)}
                style={{ width: 90 }}
                aria-label="Минуты для bulk-fill"
              />
              <input
                type="number"
                min={0}
                max={59}
                step={1}
                inputMode="numeric"
                placeholder="сек"
                value={bulkTimeSec}
                onChange={(e) => setBulkTimeSec(e.target.value)}
                style={{ width: 90 }}
                aria-label="Секунды для bulk-fill"
              />
              <button
                type="button"
                className="admin-btn"
                onClick={applyTimeBulkAll}
                disabled={
                  bulkTimeMin.trim().length === 0 &&
                  bulkTimeSec.trim().length === 0
                }
              >
                <Plus size={14} strokeWidth={1.6} aria-hidden />
                Заполнить всем размерам
              </button>
            </div>

            {operation.sizes.length === 0 ? (
              <div className="admin-muted" style={{ fontSize: '0.88rem' }}>
                В справочнике размеров нет строк — добавьте их, чтобы
                задать нормы времени.
              </div>
            ) : (
              <div className="operation-time-size-grid">
                {operation.sizes.map((s) => (
                  <div key={s.id} className="operation-time-size-card">
                    <span className="operation-time-size-card__size">
                      {s.code}
                    </span>
                    <div className="operation-time-size-card__inputs">
                      <input
                        name={`timeNormMin-${s.id}`}
                        type="number"
                        min={0}
                        step={1}
                        inputMode="numeric"
                        value={timeMinInputs[s.id] ?? ''}
                        onChange={(e) =>
                          setTimeMinInputs((prev) => ({
                            ...prev,
                            [s.id]: e.target.value,
                          }))
                        }
                        placeholder="мин"
                        aria-label={`Минуты, размер ${s.code}`}
                      />
                      <input
                        name={`timeNormSec-${s.id}`}
                        type="number"
                        min={0}
                        max={59}
                        step={1}
                        inputMode="numeric"
                        value={timeSecInputs[s.id] ?? ''}
                        onChange={(e) =>
                          setTimeSecInputs((prev) => ({
                            ...prev,
                            [s.id]: e.target.value,
                          }))
                        }
                        placeholder="сек"
                        aria-label={`Секунды, размер ${s.code}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        Плановая окладная стоимость — отдельная ось от тарифа и
        нормы времени. Используется только для расчёта **плановой**
        себестоимости окладных операций (pricingMode = SALARY_ONLY)
        в `OrderOperationPlanService`. На фактическую зарплату
        сотрудников (`Employee.salaryPerShift`, `SalaryEntry`,
        `OperationEntry`) поле не влияет.
      */}
      <div
        className="section-card"
        style={{
          background: 'var(--admin-bg-soft, #f6f7f9)',
          padding: 'var(--admin-space-md)',
          borderRadius: '10px',
        }}
      >
        <div className="section-header" style={{ marginBottom: '0.5rem' }}>
          <h2 className="admin-section-title" style={{ margin: 0 }}>
            Плановая окладная стоимость
          </h2>
        </div>
        <p
          className="admin-muted"
          style={{ marginTop: 0, fontSize: '0.85rem' }}
        >
          Используется только для плановой себестоимости окладных
          операций. Фактическая зарплата сотрудников не меняется.
          {pricingMode !== 'SALARY_ONLY' && (
            <> Актуально для окладных операций (SALARY_ONLY).</>
          )}
        </p>

        <div className="admin-form-grid">
          <div className="admin-field">
            <label htmlFor="op-salary-plan-rub">Стоимость смены, ₽</label>
            <input
              id="op-salary-plan-rub"
              name="salaryPlanRubPerShift"
              type="text"
              inputMode="decimal"
              defaultValue={initialSalaryRub}
              placeholder="напр. 3200"
              autoComplete="off"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="op-salary-plan-hours">
              Длительность смены, ч
            </label>
            <input
              id="op-salary-plan-hours"
              name="salaryPlanShiftHours"
              type="number"
              min={0.25}
              step={0.25}
              max={48}
              inputMode="decimal"
              defaultValue={initialSalaryHours}
              placeholder="8"
              autoComplete="off"
            />
          </div>
        </div>
      </div>

      {/*
        Признак «операция выпускает готовую продукцию» (см.
        `prisma/schema.prisma::Operation.producesFinishedGoods`,
        `apps/api/src/modules/finished-goods/finished-goods.service.ts::recordPassportOutputInTx`).
        При включении прохождение этой операции по паспорту создаёт
        `FinishedGoodsMovement PRODUCTION_RECEIPT IN` на склад
        `Order.finishedGoodsWarehouseId`. Идемпотентно по
        `sourceKey = PACKED_PASSPORT:<passportId>` — последующая упаковка
        дубль не создаст. Не путать с категорией `PACKING` —
        категория про UI/группировку, признак про выпуск.
      */}
      <div
        className="admin-form-section"
        style={{
          marginTop: '1rem',
          padding: '0.75rem 1rem',
          border: '1px solid var(--admin-border)',
          borderRadius: 'var(--admin-radius)',
          background: 'var(--admin-surface-alt)',
        }}
      >
        <div className="admin-field admin-field--inline">
          <input
            id="op-produces-finished-goods"
            type="checkbox"
            name="producesFinishedGoods"
            defaultChecked={operation.producesFinishedGoods}
          />
          <label
            htmlFor="op-produces-finished-goods"
            style={{ display: 'grid', gap: '0.18rem' }}
          >
            <strong>Выпускает готовую продукцию</strong>
            <span className="admin-muted" style={{ fontSize: '0.82rem' }}>
              Если включено, при успешном прохождении этой операции по
              паспорту будет создан приход готовой продукции на склад
              выпуска заказа.
            </span>
          </label>
        </div>

        {/*
          Признак «коробочная упаковка» (см.
          `prisma/schema.prisma::Operation.boxPacking`,
          `apps/api/src/modules/packing/packing.service.ts::assertPackingActor`).
          Единственный источник истины для разводки упаковщика: какой
          терминал показать на `/packing`, кого пустить к ручкам коробок
          и какой шаг маршрута считать упаковочным в
          `PackingService.addPassport` (там же гейт QC_PASSED/WTO_PASSED).
          Раньше различали по категории `PACKING` — и вторая операция
          этой категории, «Распаковка» (приёмка сырья ПЕРВЫМ шагом
          маршрута), открывала окно коробок и валилась 409
          `PASSPORT_NOT_QC_PASSED`. Ось независима от соседнего
          `producesFinishedGoods`: тот про финансовый выпуск
          (`FinishedGoodsMovement`), этот — про физические коробки.
        */}
        <div
          className="admin-field admin-field--inline"
          style={{ marginTop: '0.75rem' }}
        >
          <input
            id="op-box-packing"
            type="checkbox"
            name="boxPacking"
            defaultChecked={operation.boxPacking}
          />
          <label
            htmlFor="op-box-packing"
            style={{ display: 'grid', gap: '0.18rem' }}
          >
            <strong>Упаковка в коробки</strong>
            <span className="admin-muted" style={{ fontSize: '0.82rem' }}>
              Терминал упаковщика откроет окно коробок только на этой
              операции. Операции упаковщика без галочки (приёмка,
              распаковка сырья) работают как обычная операция: скан
              паспорта → завершить.
            </span>
          </label>
        </div>
      </div>

      <div className="admin-actions-row">
        <SaveButton />
      </div>

      {state.successMessage && (
        <div
          role="status"
          className="admin-muted"
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            color: 'var(--admin-success, #166534)',
            fontSize: '0.9rem',
          }}
        >
          <CheckCircle2 size={16} strokeWidth={1.6} aria-hidden />
          <span>{state.successMessage}</span>
        </div>
      )}
      {state.error && (
        <div
          role="alert"
          style={{
            display: 'inline-flex',
            gap: 8,
            alignItems: 'center',
            color: 'var(--admin-danger, #b91c1c)',
            fontSize: '0.9rem',
          }}
        >
          <XCircle size={16} strokeWidth={1.6} aria-hidden />
          <span>
            {state.error}
            {state.errorRequestId && (
              <span className="admin-muted" style={{ marginLeft: 8 }}>
                req: <code>{state.errorRequestId}</code>
              </span>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
