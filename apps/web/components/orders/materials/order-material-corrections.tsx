'use client';

/**
 * `OrderMaterialCorrections` — блок «Корректировка после просчёта» во
 * вкладке «Потребности» карточки заказа.
 *
 * Этап «Корректировка материалов после просчёта» (см.
 * `apps/api/src/modules/order-extra-costs/*`,
 * `apps/api/src/modules/workshop-needs/*::createManual`,
 * `apps/web/app/orders/actions.ts`). Позволяет менеджеру уже ПОСЛЕ
 * отправки заказа на просчёт:
 *   - добавлять/править/удалять ручные строки материалов
 *     (непредвиденный расход) — системные строки техкарты при этом
 *     остаются неизменяемыми;
 *   - вести прочие / непредвиденные расходы (логистика, аутсорс, …);
 *   - пересчитать себестоимость без смены статуса заказа
 *     (`CALCULATION_DONE` / `IN_PRODUCTION`).
 *
 * Виден только менеджерам и только в статусах
 * `CALCULATION` / `CALCULATION_DONE` / `IN_PRODUCTION`.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Calculator, PackagePlus, Pencil, Plus, Receipt, Trash2, X } from 'lucide-react';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import { MATERIAL_ROLES, MATERIAL_ROLE_LABELS } from '@sewing/shared/material-roles';
import type { OrderExtraCostDto } from '@sewing/shared/order-extra-costs';
import type { OrderStatus } from '@sewing/shared/orders';
import { AdminCard, AdminSectionHeader } from '@/components/admin';
import {
  createManualWorkshopNeedAction,
  createOrderExtraCostAction,
  deleteOrderNeedAction,
  deleteOrderExtraCostAction,
  recalculateOrderCostEstimateAction,
  updateOrderNeedAction,
  updateOrderExtraCostAction,
} from '@/app/orders/actions';

interface Props {
  orderId: string;
  orderStatus: OrderStatus;
  /** Ручные строки потребности (`isManual = true`) этого заказа. */
  manualNeeds: WorkshopNeedListItemDto[];
  /** Прочие расходы заказа. */
  extraCosts: OrderExtraCostDto[];
  /** Есть ли активный (зафиксированный) расчёт — нужно ли «Пересчитать». */
  hasActiveCostEstimate: boolean;
}

function formatMoney(raw: string | number | null | undefined, currency: string): string {
  if (raw == null) return '—';
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: currency === 'USD' ? 'USD' : 'RUB',
    maximumFractionDigits: 2,
  }).format(num);
}

export function OrderMaterialCorrections({
  orderId,
  orderStatus,
  manualNeeds,
  extraCosts,
  hasActiveCostEstimate,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [editingNeedId, setEditingNeedId] = useState<string | null>(null);
  const [showCostForm, setShowCostForm] = useState(false);
  const [editingCostId, setEditingCostId] = useState<string | null>(null);
  const [usdRate, setUsdRate] = useState('');

  const showRecalc =
    hasActiveCostEstimate &&
    (orderStatus === 'CALCULATION_DONE' || orderStatus === 'IN_PRODUCTION');

  function run(action: () => Promise<{ ok?: boolean; error?: string }>, onOk?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(result.error);
        return;
      }
      onOk?.();
      router.refresh();
    });
  }

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<PackagePlus size={18} strokeWidth={1.7} aria-hidden />}
        title="Корректировка после просчёта"
        hint={
          manualNeeds.length + extraCosts.length > 0
            ? `${manualNeeds.length + extraCosts.length}`
            : undefined
        }
      />

      <p className="admin-muted" style={{ fontSize: '0.82rem', margin: '4px 0 12px' }}>
        Добавляйте материалы и расходы, которые «вылезли» уже после отправки на
        просчёт. Системные строки из техкарты при этом не меняются.
        {showRecalc
          ? ' После правок нажмите «Пересчитать себестоимость».'
          : ''}
      </p>

      {error && (
        <div className="error-box" role="alert" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      {/* --- Ручные материалы --- */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>Материалы вручную</strong>
          {!showMaterialForm && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              disabled={pending}
              onClick={() => setShowMaterialForm(true)}
            >
              <Plus size={15} strokeWidth={1.7} aria-hidden /> Добавить материал
            </button>
          )}
        </div>

        {manualNeeds.length > 0 && (
          <ul className="admin-summary-list" style={{ marginBottom: 8 }}>
            {manualNeeds.map((n) => (
              <li
                key={n.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '6px 0',
                  borderTop: '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {editingNeedId === n.id ? (
                  <ManualMaterialForm
                    disabled={pending}
                    initial={n}
                    onCancel={() => setEditingNeedId(null)}
                    onSubmit={(payload) =>
                      run(
                        () => updateOrderNeedAction(orderId, n.id, payload),
                        () => setEditingNeedId(null),
                      )
                    }
                  />
                ) : (
                  <>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{n.description}</div>
                      <div className="admin-muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
                        {n.calculatedQty} {n.unit}
                        {n.quotedPrice
                          ? ` · ${formatMoney(n.quotedPrice, n.quotedCurrency ?? 'RUB')}/${n.unit}`
                          : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        disabled={pending}
                        title="Изменить материал"
                        onClick={() => {
                          setShowMaterialForm(false);
                          setEditingNeedId(n.id);
                        }}
                      >
                        <Pencil size={15} strokeWidth={1.6} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        disabled={pending}
                        title="Удалить материал"
                        onClick={() => {
                          if (!window.confirm(`Удалить «${n.description}»?`)) return;
                          run(() => deleteOrderNeedAction(orderId, n.id));
                        }}
                      >
                        <Trash2 size={15} strokeWidth={1.6} aria-hidden />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {showMaterialForm && (
          <ManualMaterialForm
            disabled={pending}
            onCancel={() => setShowMaterialForm(false)}
            onSubmit={(payload) =>
              run(
                () => createManualWorkshopNeedAction(orderId, payload),
                () => setShowMaterialForm(false),
              )
            }
          />
        )}
      </div>

      {/* --- Прочие расходы --- */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <strong style={{ fontSize: '0.9rem' }}>Прочие расходы</strong>
          {!showCostForm && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              disabled={pending}
              onClick={() => {
                setEditingCostId(null);
                setShowCostForm(true);
              }}
            >
              <Plus size={15} strokeWidth={1.7} aria-hidden /> Добавить расход
            </button>
          )}
        </div>

        {extraCosts.length > 0 && (
          <ul className="admin-summary-list" style={{ marginBottom: 8 }}>
            {extraCosts.map((c) => (
              <li
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '6px 0',
                  borderTop: '1px solid rgba(0,0,0,0.06)',
                }}
              >
                {editingCostId === c.id ? (
                  <ExtraCostForm
                    disabled={pending}
                    initial={c}
                    onCancel={() => setEditingCostId(null)}
                    onSubmit={(payload) =>
                      run(
                        () => updateOrderExtraCostAction(orderId, c.id, payload),
                        () => setEditingCostId(null),
                      )
                    }
                  />
                ) : (
                  <>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>
                        {c.description}{' '}
                        <Receipt
                          size={13}
                          strokeWidth={1.6}
                          aria-hidden
                          style={{ opacity: 0.5, verticalAlign: 'middle' }}
                        />
                      </div>
                      <div className="admin-muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>
                        {formatMoney(c.amount, c.currency)}
                        {c.includeInCostPrice ? ' · в себестоимости' : ' · справочно'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        disabled={pending}
                        title="Изменить расход"
                        onClick={() => {
                          setShowCostForm(false);
                          setEditingCostId(c.id);
                        }}
                      >
                        <Pencil size={15} strokeWidth={1.6} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        disabled={pending}
                        title="Удалить расход"
                        onClick={() => {
                          if (!window.confirm(`Удалить «${c.description}»?`)) return;
                          run(() => deleteOrderExtraCostAction(orderId, c.id));
                        }}
                      >
                        <Trash2 size={15} strokeWidth={1.6} aria-hidden />
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {showCostForm && editingCostId === null && (
          <ExtraCostForm
            disabled={pending}
            onCancel={() => setShowCostForm(false)}
            onSubmit={(payload) =>
              run(
                () => createOrderExtraCostAction(orderId, payload),
                () => setShowCostForm(false),
              )
            }
          />
        )}
      </div>

      {/* --- Пересчёт себестоимости --- */}
      {showRecalc && (
        <div
          style={{
            marginTop: 16,
            paddingTop: 12,
            borderTop: '1px solid rgba(0,0,0,0.08)',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <input
            type="text"
            inputMode="decimal"
            placeholder="Курс USD (если есть валюта)"
            value={usdRate}
            onChange={(e) => setUsdRate(e.target.value)}
            className="admin-input"
            style={{ maxWidth: 220 }}
            disabled={pending}
          />
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            disabled={pending}
            onClick={() =>
              run(() => recalculateOrderCostEstimateAction(orderId, usdRate))
            }
            title="Пересчитать себестоимость по актуальным материалам и расходам"
          >
            <Calculator size={16} strokeWidth={1.6} aria-hidden />
            {pending ? 'Пересчитываем…' : 'Пересчитать себестоимость'}
          </button>
        </div>
      )}
    </AdminCard>
  );
}

// ---------------------------------------------------------------------------
// Inline forms
// ---------------------------------------------------------------------------

interface ManualMaterialPayload {
  description: string;
  unit: string;
  calculatedQty: string;
  materialRole: string | null;
  quotedPrice: string | null;
  quotedCurrency: string | null;
}

function ManualMaterialForm({
  disabled,
  initial,
  onCancel,
  onSubmit,
}: {
  disabled: boolean;
  initial?: WorkshopNeedListItemDto;
  onCancel: () => void;
  onSubmit: (payload: ManualMaterialPayload) => void;
}) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [qty, setQty] = useState(initial?.calculatedQty ?? '');
  const [role, setRole] = useState(initial?.materialRole ?? '');
  const [price, setPrice] = useState(initial?.quotedPrice ?? '');
  const [currency, setCurrency] = useState(initial?.quotedCurrency ?? 'RUB');

  return (
    <form
      className="admin-inline-form"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, flex: 1 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          description,
          unit,
          calculatedQty: qty,
          materialRole: role === '' ? null : role,
          quotedPrice: price.trim() === '' ? null : price.trim(),
          quotedCurrency: price.trim() === '' ? null : currency,
        });
      }}
    >
      <input
        className="admin-input"
        placeholder="Описание материала *"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
        disabled={disabled}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="admin-input"
          placeholder="Кол-во *"
          inputMode="decimal"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          disabled={disabled}
          style={{ maxWidth: 120 }}
        />
        <input
          className="admin-input"
          placeholder="Ед. изм. *"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          required
          disabled={disabled}
          style={{ maxWidth: 120 }}
        />
        <select
          className="admin-input"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          disabled={disabled}
          style={{ maxWidth: 180 }}
        >
          <option value="">Роль (необязательно)</option>
          {MATERIAL_ROLES.map((r) => (
            <option key={r} value={r}>
              {MATERIAL_ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="admin-input"
          placeholder="Цена за ед. (необязательно)"
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          disabled={disabled}
          style={{ maxWidth: 220 }}
        />
        <select
          className="admin-input"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={disabled}
          style={{ maxWidth: 100 }}
        >
          <option value="RUB">RUB</option>
          <option value="USD">USD</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="admin-btn admin-btn--primary" disabled={disabled}>
          {initial ? 'Сохранить' : 'Добавить'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onCancel}
          disabled={disabled}
        >
          <X size={15} strokeWidth={1.6} aria-hidden /> Отмена
        </button>
      </div>
    </form>
  );
}

interface ExtraCostPayload {
  description: string;
  amount: string;
  currency: string;
  includeInCostPrice: boolean;
}

function ExtraCostForm({
  disabled,
  initial,
  onCancel,
  onSubmit,
}: {
  disabled: boolean;
  initial?: OrderExtraCostDto;
  onCancel: () => void;
  onSubmit: (payload: ExtraCostPayload) => void;
}) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amount, setAmount] = useState(initial?.amount ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? 'RUB');
  const [include, setInclude] = useState(initial?.includeInCostPrice ?? true);

  return (
    <form
      className="admin-inline-form"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4, flex: 1 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ description, amount, currency, includeInCostPrice: include });
      }}
    >
      <input
        className="admin-input"
        placeholder="Описание расхода *"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required
        disabled={disabled}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="admin-input"
          placeholder="Сумма *"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          disabled={disabled}
          style={{ maxWidth: 140 }}
        />
        <select
          className="admin-input"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={disabled}
          style={{ maxWidth: 100 }}
        >
          <option value="RUB">RUB</option>
          <option value="USD">USD</option>
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}>
          <input
            type="checkbox"
            checked={include}
            onChange={(e) => setInclude(e.target.checked)}
            disabled={disabled}
          />
          В себестоимость
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="admin-btn admin-btn--primary" disabled={disabled}>
          {initial ? 'Сохранить' : 'Добавить'}
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={onCancel}
          disabled={disabled}
        >
          <X size={15} strokeWidth={1.6} aria-hidden /> Отмена
        </button>
      </div>
    </form>
  );
}
