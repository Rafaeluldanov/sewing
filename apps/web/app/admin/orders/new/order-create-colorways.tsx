'use client';

/**
 * Редактор «Расцветки» для формы создания заказа (`/admin/orders/new`,
 * фича `FEATURE_COLORWAYS`). Контролируемый компонент: список расцветок,
 * у каждой — цвет + своя техкарта материалов + количества по доступным
 * размерам лекала. Родитель (`admin-create-order-form`) из этого списка
 * считает агрегат `qty[<sizeId>]` (Σ по цветам) для существующего пути
 * создания `OrderItem` и сериализует расцветки в `variantsJson`.
 *
 * Ничего не сабмитит сам — только зовёт `onChange`. Скрытые input-ы
 * рисует родитель.
 */

import { Palette, Plus, Trash2 } from 'lucide-react';
import type { SizeDto } from '@sewing/shared/sizes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';

export interface ColorwayDraft {
  color: string;
  techCardId: string | null;
  sizes: Record<string, number>;
}

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

export function makeEmptyColorway(): ColorwayDraft {
  return { color: '', techCardId: null, sizes: {} };
}

export function OrderColorwaysFieldset({
  availableSizes,
  techCards,
  value,
  onChange,
}: {
  availableSizes: SizeDto[];
  techCards: TechCardTemplateSummaryDto[];
  value: ColorwayDraft[];
  onChange: (next: ColorwayDraft[]) => void;
}) {
  const patch = (idx: number, upd: Partial<ColorwayDraft>): void =>
    onChange(value.map((c, i) => (i === idx ? { ...c, ...upd } : c)));

  const setQty = (idx: number, sizeId: string, qty: number): void =>
    onChange(
      value.map((c, i) =>
        i === idx ? { ...c, sizes: { ...c.sizes, [sizeId]: qty } } : c,
      ),
    );

  const add = (): void => onChange([...value, makeEmptyColorway()]);
  const remove = (idx: number): void =>
    onChange(value.filter((_, i) => i !== idx));

  const noPattern = availableSizes.length === 0;

  const totalsBySize = availableSizes.map((s) => ({
    ...s,
    total: value.reduce((sum, c) => sum + (c.sizes[s.id] || 0), 0),
  }));
  const grandTotal = totalsBySize.reduce((a, s) => a + s.total, 0);

  return (
    <div className="cwf">
      <Styles />
      <div className="cwf-head">
        <span className="cwf-title">
          <Palette size={16} strokeWidth={1.8} aria-hidden /> Расцветки
          <span className="cwf-badge">{value.length}</span>
        </span>
        <button
          type="button"
          className="admin-btn admin-btn--ghost cwf-add"
          onClick={add}
          disabled={noPattern}
        >
          <Plus size={14} strokeWidth={2} aria-hidden /> Добавить цвет
        </button>
      </div>

      {noPattern ? (
        <p className="admin-muted cwf-empty">
          Выберите номенклатуру — тогда появятся её размеры для ввода по цветам.
        </p>
      ) : (
        <>
          <div className="cwf-cards">
            {value.map((c, idx) => {
              const rowTotal = availableSizes.reduce(
                (s, sz) => s + (c.sizes[sz.id] || 0),
                0,
              );
              return (
                <div
                  key={idx}
                  className="cwf-card"
                  style={{ ['--cwf-accent' as string]: swatchHex(c.color) }}
                >
                  <div className="cwf-card__head">
                    <span
                      className="cwf-swatch"
                      style={{ background: swatchHex(c.color) }}
                    />
                    <input
                      className="cwf-input cwf-input--name"
                      value={c.color}
                      onChange={(e) => patch(idx, { color: e.target.value })}
                      placeholder="Цвет (напр. красный)"
                      maxLength={60}
                    />
                    {value.length > 1 && (
                      <button
                        type="button"
                        className="cwf-icon"
                        aria-label="Убрать цвет"
                        onClick={() => remove(idx)}
                      >
                        <Trash2 size={14} strokeWidth={1.8} aria-hidden />
                      </button>
                    )}
                  </div>

                  <select
                    className="cwf-input cwf-tech"
                    value={c.techCardId ?? ''}
                    onChange={(e) =>
                      patch(idx, { techCardId: e.target.value || null })
                    }
                  >
                    <option value="">Техкарта: по умолчанию заказа</option>
                    {techCards.map((t) => (
                      <option key={t.id} value={t.id}>
                        Техкарта: {t.name}
                      </option>
                    ))}
                  </select>

                  <div className="cwf-sizes">
                    {availableSizes.map((s) => (
                      <label key={s.id} className="cwf-size">
                        <span>{s.code}</span>
                        <input
                          type="number"
                          min={0}
                          value={c.sizes[s.id] ?? 0}
                          onChange={(e) =>
                            setQty(
                              idx,
                              s.id,
                              Math.max(0, Math.trunc(+e.target.value || 0)),
                            )
                          }
                        />
                      </label>
                    ))}
                    <span className="cwf-rowtotal">Σ {rowTotal}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="cwf-totals">
            <span className="admin-muted">Итого по размерам:</span>
            {totalsBySize
              .filter((s) => s.total > 0)
              .map((s) => (
                <span key={s.id} className="cwf-chip">
                  {s.code} <b>{s.total}</b>
                </span>
              ))}
            <span className="cwf-chip cwf-chip--total">
              Всего <b>{grandTotal}</b>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Styles() {
  return (
    <style>{`
.cwf { display:flex; flex-direction:column; gap:12px; }
.cwf * { box-sizing:border-box; }
.cwf-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.cwf-title { display:inline-flex; align-items:center; gap:7px; font-weight:700; }
.cwf-badge { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 6px; border-radius:999px; background:var(--color-bg-muted); color:var(--color-fg-muted); font-size:11px; font-weight:700; }
.cwf-add { padding:5px 10px; font-size:13px; }
.cwf-empty { margin:0; font-size:0.9rem; }
.cwf-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:10px; }
.cwf-card { position:relative; border:1px solid var(--color-border); border-radius:10px; padding:10px 10px 8px; display:flex; flex-direction:column; gap:9px; background:var(--color-bg-card); overflow:hidden; }
.cwf-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--cwf-accent); }
.cwf-card__head { display:flex; align-items:center; gap:8px; }
.cwf-swatch { width:24px; height:24px; border-radius:6px; border:1px solid rgba(0,0,0,.15); flex:none; }
.cwf-input { width:100%; padding:6px 8px; border:1px solid var(--color-border-strong); border-radius:7px; font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwf-input:focus { outline:none; border-color:var(--color-accent); }
.cwf-input--name { font-weight:700; }
.cwf-tech { font-size:12.5px; color:var(--color-fg-muted); }
.cwf-icon { flex:none; margin-left:auto; display:inline-flex; padding:6px; border-radius:6px; border:1px solid transparent; background:none; color:var(--color-fg-subtle); cursor:pointer; }
.cwf-icon:hover { color:var(--color-danger); background:var(--color-danger-soft); }
.cwf-sizes { display:flex; flex-wrap:wrap; gap:6px; align-items:flex-end; }
.cwf-size { display:flex; flex-direction:column; align-items:center; gap:2px; }
.cwf-size span { font-size:10.5px; font-weight:700; color:var(--color-fg-muted); }
.cwf-size input { width:46px; padding:5px; text-align:center; border:1px solid var(--color-border-strong); border-radius:6px; font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwf-size input:focus { outline:none; border-color:var(--color-accent); }
.cwf-rowtotal { align-self:center; margin-left:4px; font-size:12px; font-weight:700; color:var(--color-fg-strong); }
.cwf-totals { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.cwf-chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; background:var(--color-bg-muted); font-size:12px; }
.cwf-chip--total { background:var(--color-bg-tint); color:var(--color-fg-strong); }
`}</style>
  );
}
