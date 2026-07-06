'use client';

/**
 * Блок «Расцветки» карточки заказа (фича `FEATURE_COLORWAYS`).
 *
 * Реальный редактор поверх API `/api/orders/:id/colorways`: у заказа
 * одна или несколько расцветок, каждая — цвет + своя техкарта
 * материалов + поразмерный план. Пишет через server actions
 * (`colorways-actions.ts`), состояние обновляет из возвращаемого
 * полного `OrderColorwaysDto`.
 *
 * На первом срезе это аддитивная надстройка над заказом: `OrderItem`
 * остаётся агрегатом, сведение поразмерного плана по цветам в
 * производство/раскрой — поздняя фаза. Блок это честно проговаривает
 * в подсказке внизу.
 */

import { useMemo, useState, useTransition } from 'react';
import { Palette, Plus, Trash2, Save, Info, Loader2 } from 'lucide-react';
import type { OrderColorwaysDto } from '@sewing/shared';
import {
  createColorwayAction,
  updateColorwayAction,
  deleteColorwayAction,
} from '@/app/admin/orders/[id]/colorways-actions';

// Декоративный свотч по названию цвета (источник истины — имя-строка).
const COLOR_HEX: Record<string, string> = {
  'белый': '#f2f2f0', 'белая': '#f2f2f0',
  'чёрный': '#222', 'черный': '#222', 'чёрная': '#222', 'черная': '#222',
  'красный': '#d23b3b', 'красная': '#d23b3b',
  'жёлтый': '#e8b73a', 'желтый': '#e8b73a', 'жёлтая': '#e8b73a', 'желтая': '#e8b73a',
  'синий': '#2f7fd1', 'синяя': '#2f7fd1',
  'зелёный': '#2e9e4a', 'зеленый': '#2e9e4a', 'зелёная': '#2e9e4a', 'зеленая': '#2e9e4a',
  'серый': '#8a8a86', 'серая': '#8a8a86',
};
function swatchHex(name: string): string {
  return COLOR_HEX[name.trim().toLowerCase()] ?? '#b7c3d0';
}

interface DraftSize { sizeId: string; qtyPlan: number }
interface Draft { color: string; techCardId: string | null; sizes: DraftSize[] }

function toDraft(v: OrderColorwaysDto['variants'][number]): Draft {
  return {
    color: v.color,
    techCardId: v.techCardId,
    sizes: v.sizes.map((s) => ({ sizeId: s.sizeId, qtyPlan: s.qtyPlan })),
  };
}

export function OrderColorwaysBlock({
  orderId,
  initial,
}: {
  orderId: string;
  initial: OrderColorwaysDto;
}) {
  const [data, setData] = useState<OrderColorwaysDto>(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(data.variants.map((v) => [v.id, toDraft(v)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sizeCode = useMemo(
    () => new Map(data.sizes.map((s) => [s.id, s.code])),
    [data.sizes],
  );

  function applyResult(
    r: { ok: boolean; error?: string; data?: OrderColorwaysDto },
  ): void {
    if (r.ok && r.data) {
      setData(r.data);
      setDrafts(
        Object.fromEntries(r.data.variants.map((v) => [v.id, toDraft(v)])),
      );
      setError(null);
    } else {
      setError(r.error ?? 'Ошибка');
    }
    setBusyId(null);
  }

  function patchDraft(vid: string, upd: Partial<Draft>): void {
    setDrafts((prev) => ({ ...prev, [vid]: { ...prev[vid], ...upd } }));
  }
  function setQty(vid: string, sizeId: string, qty: number): void {
    setDrafts((prev) => {
      const d = prev[vid];
      const exists = d.sizes.some((s) => s.sizeId === sizeId);
      const sizes = exists
        ? d.sizes.map((s) => (s.sizeId === sizeId ? { ...s, qtyPlan: qty } : s))
        : [...d.sizes, { sizeId, qtyPlan: qty }];
      return { ...prev, [vid]: { ...d, sizes } };
    });
  }
  function addSize(vid: string, sizeId: string): void {
    if (!sizeId) return;
    setDrafts((prev) => {
      const d = prev[vid];
      if (d.sizes.some((s) => s.sizeId === sizeId)) return prev;
      return { ...prev, [vid]: { ...d, sizes: [...d.sizes, { sizeId, qtyPlan: 0 }] } };
    });
  }
  function removeSize(vid: string, sizeId: string): void {
    setDrafts((prev) => ({
      ...prev,
      [vid]: { ...prev[vid], sizes: prev[vid].sizes.filter((s) => s.sizeId !== sizeId) },
    }));
  }

  function saveVariant(vid: string): void {
    const d = drafts[vid];
    setBusyId(vid);
    startTransition(async () => {
      applyResult(
        await updateColorwayAction(orderId, vid, {
          color: d.color,
          techCardId: d.techCardId,
          sizes: d.sizes,
        }),
      );
    });
  }
  function addColorway(): void {
    setBusyId('__new__');
    startTransition(async () => {
      applyResult(
        await createColorwayAction(orderId, {
          color: 'новый цвет',
          techCardId: null,
          sizes: [],
        }),
      );
    });
  }
  function removeColorway(vid: string): void {
    setBusyId(vid);
    startTransition(async () => {
      applyResult(await deleteColorwayAction(orderId, vid));
    });
  }

  // Итог по размерам (по всем расцветкам, из черновиков — вживую).
  const totalsBySize = useMemo(() => {
    const acc = new Map<string, number>();
    for (const d of Object.values(drafts)) {
      for (const s of d.sizes) {
        if (s.qtyPlan > 0) acc.set(s.sizeId, (acc.get(s.sizeId) ?? 0) + s.qtyPlan);
      }
    }
    return [...acc.entries()].sort(
      (a, b) =>
        data.sizes.findIndex((s) => s.id === a[0]) -
        data.sizes.findIndex((s) => s.id === b[0]),
    );
  }, [drafts, data.sizes]);
  const grandTotal = totalsBySize.reduce((a, [, q]) => a + q, 0);

  const canDelete = data.variants.length > 1;

  return (
    <section className="cwl">
      <BlockStyles />
      <header className="cwl-head">
        <h2>
          <Palette size={18} strokeWidth={1.8} aria-hidden /> Расцветки
          <span className="cwl-badge">{data.variants.length}</span>
        </h2>
        <button
          type="button"
          className="admin-btn admin-btn--primary"
          onClick={addColorway}
          disabled={pending}
        >
          {pending && busyId === '__new__' ? (
            <Loader2 size={15} className="cwl-spin" aria-hidden />
          ) : (
            <Plus size={15} strokeWidth={2} aria-hidden />
          )}{' '}
          Добавить расцветку
        </button>
      </header>

      {error && <div className="cwl-error">{error}</div>}

      <div className="cwl-grid">
        {data.variants.map((v) => {
          const d = drafts[v.id];
          if (!d) return null;
          const rowTotal = d.sizes.reduce((a, s) => a + (s.qtyPlan || 0), 0);
          const usedSizeIds = new Set(d.sizes.map((s) => s.sizeId));
          const addable = data.sizes.filter((s) => !usedSizeIds.has(s.id));
          const busy = pending && busyId === v.id;
          return (
            <article
              key={v.id}
              className="cwl-card"
              style={{ ['--cwl-accent' as string]: swatchHex(d.color) }}
            >
              <div className="cwl-card__head">
                <span className="cwl-swatch" style={{ background: swatchHex(d.color) }} />
                <input
                  className="cwl-input cwl-input--name"
                  value={d.color}
                  onChange={(e) => patchDraft(v.id, { color: e.target.value })}
                  placeholder="Цвет"
                />
                <button
                  type="button"
                  className="cwl-icon"
                  aria-label="Удалить расцветку"
                  disabled={!canDelete || pending}
                  title={canDelete ? 'Удалить расцветку' : 'Нельзя удалить последнюю расцветку'}
                  onClick={() => removeColorway(v.id)}
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden />
                </button>
              </div>

              <label className="cwl-field">
                <span className="cwl-label">Техкарта материалов</span>
                <select
                  className="cwl-input"
                  value={d.techCardId ?? ''}
                  onChange={(e) =>
                    patchDraft(v.id, { techCardId: e.target.value || null })
                  }
                >
                  <option value="">— по умолчанию заказа —</option>
                  {data.techCards.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>

              <div className="cwl-field">
                <span className="cwl-label">План по размерам, шт</span>
                <div className="cwl-sizes">
                  {d.sizes.map((s) => (
                    <div key={s.sizeId} className="cwl-size">
                      <span className="cwl-size__code">{sizeCode.get(s.sizeId) ?? '—'}</span>
                      <input
                        type="number"
                        min={0}
                        value={s.qtyPlan}
                        onChange={(e) =>
                          setQty(v.id, s.sizeId, Math.max(0, +e.target.value || 0))
                        }
                      />
                      <button
                        type="button"
                        className="cwl-size__x"
                        aria-label="Убрать размер"
                        onClick={() => removeSize(v.id, s.sizeId)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {addable.length > 0 && (
                    <select
                      className="cwl-add-size"
                      value=""
                      onChange={(e) => addSize(v.id, e.target.value)}
                    >
                      <option value="">＋ размер</option>
                      {addable.map((s) => (
                        <option key={s.id} value={s.id}>{s.code}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <footer className="cwl-card__foot">
                <span className="cwl-muted">
                  Σ {rowTotal} шт ·{' '}
                  {d.techCardId
                    ? (data.techCards.find((t) => t.id === d.techCardId)?.name ?? 'своя техкарта')
                    : 'техкарта заказа'}
                </span>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost cwl-save"
                  onClick={() => saveVariant(v.id)}
                  disabled={pending}
                >
                  {busy ? (
                    <Loader2 size={14} className="cwl-spin" aria-hidden />
                  ) : (
                    <Save size={14} strokeWidth={1.8} aria-hidden />
                  )}{' '}
                  Сохранить
                </button>
              </footer>
            </article>
          );
        })}
      </div>

      {totalsBySize.length > 0 && (
        <div className="cwl-totals">
          <span className="cwl-muted">Итого по размерам:</span>
          {totalsBySize.map(([sid, q]) => (
            <span key={sid} className="cwl-chip">
              {sizeCode.get(sid) ?? '—'} <b>{q}</b>
            </span>
          ))}
          <span className="cwl-chip cwl-chip--total">Всего <b>{grandTotal}</b></span>
        </div>
      )}

      <div className="cwl-note">
        <Info size={16} strokeWidth={1.8} aria-hidden />
        <span>
          Первый срез: расцветки хранятся отдельно от плана заказа
          (аддитивно). Цвет паспортов и поразмерный крой по цветам —
          следующая фаза. Фича под флагом <code>FEATURE_COLORWAYS</code>.
        </span>
      </div>
    </section>
  );
}

function BlockStyles() {
  return (
    <style>{`
.cwl { display: flex; flex-direction: column; gap: 14px; background: var(--color-bg-card);
  border: 1px solid var(--color-border); border-radius: var(--admin-radius-card,12px);
  box-shadow: var(--admin-shadow-soft); padding: 16px 18px; }
.cwl * { box-sizing: border-box; }
.cwl-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cwl-head h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; }
.cwl-badge { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px;
  padding:0 6px; border-radius:999px; background:var(--color-bg-muted); color:var(--color-fg-muted); font-size:12px; font-weight:700; }
.cwl-error { padding:9px 12px; border-radius:8px; background:var(--color-danger-soft); color:var(--color-danger-fg); font-size:13px; }
.cwl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
.cwl-card { position:relative; border:1px solid var(--color-border); border-radius:12px; padding:12px 12px 10px;
  display:flex; flex-direction:column; gap:11px; background:var(--color-bg); overflow:hidden; }
.cwl-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--cwl-accent); }
.cwl-card__head { display:flex; align-items:center; gap:9px; }
.cwl-swatch { width:26px; height:26px; border-radius:7px; border:1px solid rgba(0,0,0,.15); flex:none; }
.cwl-input { width:100%; padding:6px 9px; border:1px solid var(--color-border-strong); border-radius:8px;
  font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwl-input:focus { outline:none; border-color:var(--color-accent); }
.cwl-input--name { font-weight:700; }
.cwl-icon { flex:none; margin-left:auto; display:inline-flex; padding:6px; border-radius:7px; border:1px solid transparent;
  background:none; color:var(--color-fg-subtle); cursor:pointer; }
.cwl-icon:hover:not(:disabled){ color:var(--color-danger); background:var(--color-danger-soft); }
.cwl-icon:disabled { opacity:.4; cursor:not-allowed; }
.cwl-field { display:flex; flex-direction:column; gap:6px; }
.cwl-label { font-size:11px; font-weight:600; color:var(--color-fg-muted); text-transform:uppercase; letter-spacing:.02em; }
.cwl-sizes { display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
.cwl-size { display:flex; align-items:center; gap:4px; border:1px solid var(--color-border); border-radius:8px; padding:2px 4px 2px 7px; background:var(--color-bg-card); }
.cwl-size__code { font-size:11px; font-weight:700; color:var(--color-fg-muted); }
.cwl-size input { width:52px; padding:4px; text-align:center; border:1px solid transparent; border-radius:6px; font:inherit; background:transparent; color:var(--color-fg); }
.cwl-size input:focus { outline:none; border-color:var(--color-accent); background:var(--color-bg); }
.cwl-size__x { border:none; background:none; color:var(--color-fg-subtle); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }
.cwl-size__x:hover { color:var(--color-danger); }
.cwl-add-size { padding:5px 7px; border:1px dashed var(--color-border-strong); border-radius:8px; font:inherit; background:var(--color-bg-card); color:var(--color-fg-muted); cursor:pointer; }
.cwl-card__foot { display:flex; align-items:center; justify-content:space-between; gap:8px; border-top:1px dashed var(--color-border); padding-top:9px; }
.cwl-muted { font-size:12.5px; color:var(--color-fg-muted); }
.cwl-save { padding:5px 10px; font-size:13px; }
.cwl-totals { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:2px; }
.cwl-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:999px; background:var(--color-bg-muted); font-size:12.5px; }
.cwl-chip--total { background:var(--color-bg-tint); color:var(--color-fg-strong); }
.cwl-note { display:flex; align-items:flex-start; gap:8px; padding:10px 12px; border-radius:9px; background:var(--color-bg-soft);
  border:1px solid var(--color-border); color:var(--color-fg-muted); font-size:12.5px; line-height:1.45; }
.cwl-note svg { flex:none; margin-top:1px; }
.cwl-note code { background:rgba(0,0,0,.06); padding:1px 5px; border-radius:5px; font-size:12px; }
.cwl-spin { animation: cwl-rot 0.8s linear infinite; }
@keyframes cwl-rot { to { transform: rotate(360deg); } }
`}</style>
  );
}
