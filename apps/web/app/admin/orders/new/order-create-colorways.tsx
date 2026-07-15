'use client';

/**
 * Редактор «Расцветки» для формы создания заказа (`/admin/orders/new`,
 * фича `FEATURE_COLORWAYS`). Контролируемый компонент: список расцветок,
 * у каждой — цвет + своя техкарта материалов + количества по размерам.
 * Родитель (`admin-create-order-form`) из этого списка считает агрегат
 * `qty[<sizeId>]` (Σ по цветам) для существующего пути создания
 * `OrderItem` и сериализует расцветки в `variantsJson`.
 *
 * Размеры-колонки = размеры выбранного лекала (`availableSizes`) плюс
 * доп.размеры из справочника (`allSizes`), которые менеджер добавил
 * кнопкой «+» (сверх лекала — бэкенд не валидирует размеры позиций по
 * лекалу). Свотч подхватывает цвет уже во время ввода (префикс основы).
 *
 * Ничего не сабмитит сам — только зовёт `onChange`. Скрытые input-ы
 * рисует родитель.
 */

import { useState } from 'react';
import { Palette, Plus, Trash2, X } from 'lucide-react';
import type { SizeDto } from '@sewing/shared/sizes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';

export interface ColorwayDraft {
  color: string;
  techCardId: string | null;
  sizes: Record<string, number>;
}

const DEFAULT_SWATCH = '#b7c3d0';

// Основы названий цветов → hex. Матчим по префиксу основы (в обе
// стороны), чтобы свотч подхватывал цвет уже во время набора:
// «крас» → красный, «сер» → серый. Более специфичные основы (серебр,
// сирен, салат) идут РАНЬШЕ коротких (сер, син), чтобы выигрывать.
const COLOR_STEMS: ReadonlyArray<readonly [string, string]> = [
  ['бел', '#f2f2f0'],
  ['черн', '#222222'],
  ['красн', '#d23b3b'],
  ['оранж', '#e8823a'],
  ['желт', '#e8b73a'],
  ['зелен', '#2e9e4a'],
  ['голуб', '#5cb3e8'],
  ['фиолет', '#8a5cd1'],
  ['сирен', '#b39ddb'],
  ['розов', '#e87ba8'],
  ['малин', '#c2185b'],
  ['бордов', '#7b1f2b'],
  ['корич', '#8a5a2b'],
  ['беж', '#e3d3b3'],
  ['бирюз', '#1fb6a6'],
  ['салат', '#9ccc65'],
  ['мятн', '#a5e0c8'],
  ['хаки', '#7a7a45'],
  ['золот', '#d4af37'],
  ['серебр', '#c9ccd1'],
  ['син', '#2f7fd1'],
  ['сер', '#8a8a86'],
];

function swatchHex(name: string): string {
  const q = name.trim().toLowerCase().replace(/ё/g, 'е');
  if (!q) return DEFAULT_SWATCH;
  for (const [stem, hex] of COLOR_STEMS) {
    // «красный» начинается с основы «красн» ИЛИ короткий ввод «крас»
    // является префиксом основы — оба случая распознаём на лету.
    if (q.startsWith(stem) || stem.startsWith(q)) return hex;
  }
  return DEFAULT_SWATCH;
}

/** Ширина ячейки количества под число, чтобы цифры не обрезались. */
function qtyWidth(n: number): string {
  const digits = Math.max(2, String(n).length);
  return `${digits + 1.5}ch`;
}

export function makeEmptyColorway(): ColorwayDraft {
  return { color: '', techCardId: null, sizes: {} };
}

export function OrderColorwaysFieldset({
  availableSizes,
  allSizes,
  techCards,
  value,
  onChange,
  initialExtraSizeIds,
}: {
  /** Размеры выбранного лекала — базовые колонки. */
  availableSizes: SizeDto[];
  /** Все размеры справочника — источник для кнопки «+» (доп. размеры). */
  allSizes: SizeDto[];
  techCards: TechCardTemplateSummaryDto[];
  value: ColorwayDraft[];
  onChange: (next: ColorwayDraft[]) => void;
  /**
   * Доп. размеры (сверх лекала), которые нужно показать колонками сразу
   * при монтировании. Нужно форме РЕДАКТИРОВАНИЯ: сид расцветок может
   * содержать размеры вне лекала (менеджер добавил их при создании) —
   * иначе их колонки не появились бы и введённые количества «повисли» бы
   * в агрегате без ячейки. Форма создания prop не передаёт (пустой сид).
   */
  initialExtraSizeIds?: string[];
}) {
  // Доп. размеры (сверх лекала), добавленные менеджером кнопкой «+».
  const [extraSizeIds, setExtraSizeIds] = useState<string[]>(
    () => initialExtraSizeIds ?? [],
  );
  const [addOpen, setAddOpen] = useState(false);

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

  const availableIdSet = new Set(availableSizes.map((s) => s.id));

  // Отображаемые колонки = размеры лекала + выбранные доп.размеры,
  // отсортированы по `sortOrder`.
  const extraSizes = allSizes.filter(
    (s) => extraSizeIds.includes(s.id) && !availableIdSet.has(s.id),
  );
  const displayedSizes = [...availableSizes, ...extraSizes].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const displayedIdSet = new Set(displayedSizes.map((s) => s.id));

  // Кандидаты для «+»: размеры справочника, которых ещё нет в колонках.
  const remainingSizes = allSizes.filter((s) => !displayedIdSet.has(s.id));

  const addSize = (sizeId: string): void => {
    setExtraSizeIds((prev) => (prev.includes(sizeId) ? prev : [...prev, sizeId]));
    setAddOpen(false);
  };
  // Удаление доп.размера снимает и его колонку, и введённые по нему
  // количества во всех расцветках (иначе «висячее» qty осталось бы в
  // агрегате).
  const removeExtraSize = (sizeId: string): void => {
    setExtraSizeIds((prev) => prev.filter((id) => id !== sizeId));
    onChange(
      value.map((c) => {
        if (!(sizeId in c.sizes)) return c;
        const { [sizeId]: _drop, ...rest } = c.sizes;
        return { ...c, sizes: rest };
      }),
    );
  };

  const noPattern = availableSizes.length === 0;

  const totalsBySize = displayedSizes.map((s) => ({
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
          {/* Управление колонками-размерами: доп.размеры (сверх лекала)
              показываем как снимаемые чипы, «+» добавляет из справочника. */}
          <div className="cwf-sizebar">
            {extraSizes.length > 0 && (
              <>
                <span className="cwf-sizebar__label">Доп. размеры:</span>
                {extraSizes.map((s) => (
                  <span key={s.id} className="cwf-sizetag">
                    {s.code}
                    <button
                      type="button"
                      className="cwf-sizetag__x"
                      aria-label={`Убрать размер ${s.code}`}
                      onClick={() => removeExtraSize(s.id)}
                    >
                      <X size={11} strokeWidth={2.4} aria-hidden />
                    </button>
                  </span>
                ))}
              </>
            )}
            {remainingSizes.length > 0 && (
              <div className="cwf-addsize">
                <button
                  type="button"
                  className="cwf-addsize__btn"
                  aria-label="Добавить размер"
                  aria-expanded={addOpen}
                  onClick={() => setAddOpen((o) => !o)}
                >
                  <Plus size={14} strokeWidth={2.2} aria-hidden />
                  <span className="cwf-addsize__txt">размер</span>
                </button>
                {addOpen && (
                  <div className="cwf-addsize__menu" role="menu">
                    {remainingSizes.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        role="menuitem"
                        onClick={() => addSize(s.id)}
                      >
                        {s.code}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="cwf-cards">
            {value.map((c, idx) => {
              const rowTotal = displayedSizes.reduce(
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
                    <option value="">Техкарта: не выбрана</option>
                    {techCards.map((t) => (
                      <option key={t.id} value={t.id}>
                        Техкарта: {t.name}
                      </option>
                    ))}
                  </select>

                  <div className="cwf-sizes">
                    {displayedSizes.map((s) => {
                      const qty = c.sizes[s.id] ?? 0;
                      return (
                        <label key={s.id} className="cwf-size">
                          <span>{s.code}</span>
                          <input
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={qty}
                            style={{ width: qtyWidth(qty) }}
                            onChange={(e) =>
                              setQty(
                                idx,
                                s.id,
                                Math.max(0, Math.trunc(+e.target.value || 0)),
                              )
                            }
                          />
                        </label>
                      );
                    })}
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
.cwf-sizebar { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.cwf-sizebar__label { font-size:12px; font-weight:700; color:var(--color-fg-muted); }
.cwf-sizetag { display:inline-flex; align-items:center; gap:3px; padding:2px 4px 2px 8px; border-radius:999px; background:var(--color-bg-muted); font-size:12px; font-weight:700; }
.cwf-sizetag__x { display:inline-flex; padding:1px; border:none; border-radius:999px; background:none; color:var(--color-fg-subtle); cursor:pointer; line-height:0; }
.cwf-sizetag__x:hover { color:var(--color-danger); }
.cwf-addsize { position:relative; display:inline-flex; }
.cwf-addsize__btn { display:inline-flex; align-items:center; gap:3px; padding:3px 9px 3px 6px; border:1px dashed var(--color-border-strong); border-radius:999px; background:var(--color-bg-card); color:var(--color-fg-muted); font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
.cwf-addsize__btn:hover { border-color:var(--color-accent); color:var(--color-fg); }
.cwf-addsize__txt { font-size:12px; }
.cwf-addsize__menu { position:absolute; top:calc(100% + 4px); left:0; z-index:20; display:flex; flex-wrap:wrap; gap:4px; max-width:240px; padding:6px; border:1px solid var(--color-border); border-radius:9px; background:var(--color-bg-card); box-shadow:0 6px 20px rgba(0,0,0,.14); }
.cwf-addsize__menu button { min-width:34px; padding:4px 8px; border:1px solid var(--color-border-strong); border-radius:6px; background:var(--color-bg-card); color:var(--color-fg); font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
.cwf-addsize__menu button:hover { border-color:var(--color-accent); background:var(--color-bg-muted); }
.cwf-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:10px; }
.cwf-card { position:relative; border:1px solid var(--color-border); border-radius:10px; padding:10px 10px 8px; display:flex; flex-direction:column; gap:9px; background:var(--color-bg-card); overflow:hidden; }
.cwf-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--cwf-accent); }
.cwf-card__head { display:flex; align-items:center; gap:8px; }
.cwf-swatch { width:24px; height:24px; border-radius:6px; border:1px solid rgba(0,0,0,.15); flex:none; transition:background .12s ease; }
.cwf-input { width:100%; padding:6px 8px; border:1px solid var(--color-border-strong); border-radius:7px; font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwf-input:focus { outline:none; border-color:var(--color-accent); }
.cwf-input--name { font-weight:700; }
.cwf-tech { font-size:12.5px; color:var(--color-fg-muted); }
.cwf-icon { flex:none; margin-left:auto; display:inline-flex; padding:6px; border-radius:6px; border:1px solid transparent; background:none; color:var(--color-fg-subtle); cursor:pointer; }
.cwf-icon:hover { color:var(--color-danger); background:var(--color-danger-soft); }
.cwf-sizes { display:flex; flex-wrap:wrap; gap:6px; align-items:flex-end; }
.cwf-size { display:flex; flex-direction:column; align-items:center; gap:2px; }
.cwf-size span { font-size:10.5px; font-weight:700; color:var(--color-fg-muted); }
.cwf-size input { min-width:38px; max-width:96px; padding:5px 6px; text-align:center; border:1px solid var(--color-border-strong); border-radius:6px; font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwf-size input:focus { outline:none; border-color:var(--color-accent); }
.cwf-size input::-webkit-outer-spin-button, .cwf-size input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.cwf-size input[type=number] { -moz-appearance:textfield; appearance:textfield; }
.cwf-rowtotal { align-self:center; margin-left:4px; font-size:12px; font-weight:700; color:var(--color-fg-strong); }
.cwf-totals { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
.cwf-chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; background:var(--color-bg-muted); font-size:12px; }
.cwf-chip--total { background:var(--color-bg-tint); color:var(--color-fg-strong); }
`}</style>
  );
}
