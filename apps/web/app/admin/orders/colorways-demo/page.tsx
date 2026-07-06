'use client';

/**
 * ДЕМО-страница «Расцветки в заказе» — визуальный прототип фичи
 * «разные цвета для разных размеров, у каждого цвета своя техкарта».
 *
 * Это НЕ продовый экран и НЕ подключён к API: чистый presentation-слой
 * с локальным моковым состоянием, чтобы согласовать вид до реализации.
 * Показывает две новые поверхности:
 *   1. Карточка заказа → блок «Расцветки» (colorway = цвет + своя
 *      техкарта материалов + поразмерный план);
 *   2. Раскрой → многоцветный настил (общий маркер, цвет на рулоне,
 *      паспорт выпускается per-roll и красится в цвет рулона).
 *
 * Маршрут: /admin/orders/colorways-demo
 */

import { useMemo, useState } from 'react';
import {
  Palette,
  Scissors,
  Plus,
  Trash2,
  Layers,
  Info,
  ArrowRight,
} from 'lucide-react';
import { AdminPageShell } from '@/components/admin';

// ---------- Моковые справочники ----------

interface SizeDef {
  id: string;
  code: string;
}
const SIZES: SizeDef[] = [
  { id: 's', code: 'S' },
  { id: 'm', code: 'M' },
  { id: 'l', code: 'L' },
  { id: 'xl', code: 'XL' },
];

const TECH_CARDS = [
  'Хлопок 160 · гладкое крашение',
  'Хлопок 160 · реактивное крашение',
  'Кулирка 180 · пигмент',
];

interface Colorway {
  id: string;
  name: string;
  hex: string;
  techCard: string;
  qty: Record<string, number>;
}

interface Roll {
  id: string;
  colorwayId: string;
  layers: number;
}

let uid = 0;
const nextId = () => `id${++uid}`;

// ---------- Начальное состояние демо ----------

const INITIAL_COLORWAYS: Colorway[] = [
  {
    id: 'red',
    name: 'Красный',
    hex: '#d23b3b',
    techCard: TECH_CARDS[1],
    qty: { s: 20, m: 40, l: 30, xl: 10 },
  },
  {
    id: 'yellow',
    name: 'Жёлтый',
    hex: '#e8b73a',
    techCard: TECH_CARDS[0],
    qty: { s: 10, m: 20, l: 15, xl: 5 },
  },
];

const INITIAL_MARKER: Record<string, number> = { s: 1, m: 2, l: 1, xl: 1 };

const INITIAL_ROLLS: Roll[] = [
  { id: 'r1', colorwayId: 'red', layers: 20 },
  { id: 'r2', colorwayId: 'yellow', layers: 10 },
];

export default function ColorwaysDemoPage() {
  const [view, setView] = useState<'order' | 'cutting'>('order');
  const [colorways, setColorways] = useState<Colorway[]>(INITIAL_COLORWAYS);
  const [marker, setMarker] = useState<Record<string, number>>(INITIAL_MARKER);
  const [rolls, setRolls] = useState<Roll[]>(INITIAL_ROLLS);

  return (
    <AdminPageShell
      icon={<Palette size={22} strokeWidth={1.6} aria-hidden />}
      title="Расцветки в заказе"
      subtitle="Демо · разные цвета для разных размеров, у каждого цвета своя техкарта"
    >
      <div className="cw-demo">
        <DemoStyles />

        <div className="cw-callout cw-callout--info">
          <Info size={18} strokeWidth={1.8} aria-hidden />
          <div>
            <strong>Прототип, не подключён к API.</strong> Числа считаются
            вживую. Маршрут заказа остаётся один — по цвету различается только
            техкарта материалов и цвет паспорта.
          </div>
        </div>

        <div className="cw-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={view === 'order'}
            className={`cw-tab ${view === 'order' ? 'is-active' : ''}`}
            onClick={() => setView('order')}
          >
            <Palette size={16} strokeWidth={1.8} aria-hidden /> Карточка заказа ·
            Расцветки
          </button>
          <button
            role="tab"
            aria-selected={view === 'cutting'}
            className={`cw-tab ${view === 'cutting' ? 'is-active' : ''}`}
            onClick={() => setView('cutting')}
          >
            <Scissors size={16} strokeWidth={1.8} aria-hidden /> Раскрой ·
            Многоцветный настил
          </button>
        </div>

        {view === 'order' ? (
          <OrderColorwaysView
            colorways={colorways}
            setColorways={setColorways}
          />
        ) : (
          <CuttingView
            colorways={colorways}
            marker={marker}
            setMarker={setMarker}
            rolls={rolls}
            setRolls={setRolls}
          />
        )}
      </div>
    </AdminPageShell>
  );
}

// ==========================================================
// ВКЛАДКА 1 — Расцветки в карточке заказа
// ==========================================================

function OrderColorwaysView({
  colorways,
  setColorways,
}: {
  colorways: Colorway[];
  setColorways: React.Dispatch<React.SetStateAction<Colorway[]>>;
}) {
  const totalsBySize = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const s of SIZES) {
      acc[s.id] = colorways.reduce((sum, c) => sum + (c.qty[s.id] || 0), 0);
    }
    return acc;
  }, [colorways]);

  const grandTotal = useMemo(
    () => Object.values(totalsBySize).reduce((a, b) => a + b, 0),
    [totalsBySize],
  );

  const patch = (id: string, upd: Partial<Colorway>) =>
    setColorways((prev) =>
      prev.map((c) => (c.id === id ? { ...c, ...upd } : c)),
    );

  const patchQty = (id: string, sizeId: string, value: number) =>
    setColorways((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, qty: { ...c.qty, [sizeId]: value } } : c,
      ),
    );

  const addColorway = () =>
    setColorways((prev) => [
      ...prev,
      {
        id: nextId(),
        name: 'Новый цвет',
        hex: '#6b8fb5',
        techCard: TECH_CARDS[0],
        qty: Object.fromEntries(SIZES.map((s) => [s.id, 0])),
      },
    ]);

  const removeColorway = (id: string) =>
    setColorways((prev) => prev.filter((c) => c.id !== id));

  return (
    <section className="cw-card">
      <header className="cw-section-head">
        <h2>
          <Palette size={18} strokeWidth={1.8} aria-hidden /> Расцветки
          <span className="cw-badge">{colorways.length}</span>
        </h2>
        <button className="admin-btn admin-btn--primary" onClick={addColorway}>
          <Plus size={16} strokeWidth={2} aria-hidden /> Добавить расцветку
        </button>
      </header>

      <div className="cw-colorways">
        {colorways.map((c) => {
          const rowTotal = SIZES.reduce((s, sz) => s + (c.qty[sz.id] || 0), 0);
          return (
            <article
              key={c.id}
              className="cw-colorway"
              style={{ ['--cw-accent' as string]: c.hex }}
            >
              <div className="cw-colorway__head">
                <label className="cw-swatch" title="Цвет расцветки">
                  <input
                    type="color"
                    value={c.hex}
                    onChange={(e) => patch(c.id, { hex: e.target.value })}
                  />
                  <span style={{ background: c.hex }} />
                </label>
                <input
                  className="cw-input cw-input--name"
                  value={c.name}
                  onChange={(e) => patch(c.id, { name: e.target.value })}
                />
                <button
                  className="cw-icon-btn"
                  aria-label="Удалить расцветку"
                  onClick={() => removeColorway(c.id)}
                >
                  <Trash2 size={16} strokeWidth={1.8} aria-hidden />
                </button>
              </div>

              <div className="cw-field">
                <span className="cw-field__label">Техкарта материалов</span>
                <select
                  className="cw-input"
                  value={c.techCard}
                  onChange={(e) => patch(c.id, { techCard: e.target.value })}
                >
                  {TECH_CARDS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              <div className="cw-field">
                <span className="cw-field__label">План по размерам, шт</span>
                <div className="cw-size-grid">
                  {SIZES.map((s) => (
                    <label key={s.id} className="cw-size-cell">
                      <span>{s.code}</span>
                      <input
                        type="number"
                        min={0}
                        value={c.qty[s.id] ?? 0}
                        onChange={(e) =>
                          patchQty(c.id, s.id, Math.max(0, +e.target.value || 0))
                        }
                      />
                    </label>
                  ))}
                  <div className="cw-size-cell cw-size-cell--total">
                    <span>Σ</span>
                    <b>{rowTotal}</b>
                  </div>
                </div>
              </div>

              <footer className="cw-colorway__foot">
                <ArrowRight size={14} strokeWidth={1.8} aria-hidden />
                Свой снимок материалов из «{c.techCard}» ·{' '}
                {rowTotal} шт · цвет «{c.name}»
              </footer>
            </article>
          );
        })}
      </div>

      <div className="cw-totals">
        <span className="cw-totals__label">Итого по размерам</span>
        <div className="cw-size-grid">
          {SIZES.map((s) => (
            <div key={s.id} className="cw-size-cell cw-size-cell--ro">
              <span>{s.code}</span>
              <b>{totalsBySize[s.id]}</b>
            </div>
          ))}
          <div className="cw-size-cell cw-size-cell--total">
            <span>Всего</span>
            <b>{grandTotal}</b>
          </div>
        </div>
      </div>

      <div className="cw-callout cw-callout--muted">
        <Info size={18} strokeWidth={1.8} aria-hidden />
        <div>
          Модель: <code>OrderVariant</code> = цвет + <code>techCardId</code> +
          поразмерный план. Один размер (напр. M) живёт в нескольких расцветках
          с разным количеством. Маршрут операций общий на заказ.
        </div>
      </div>
    </section>
  );
}

// ==========================================================
// ВКЛАДКА 2 — Многоцветный настил на раскрое
// ==========================================================

function CuttingView({
  colorways,
  marker,
  setMarker,
  rolls,
  setRolls,
}: {
  colorways: Colorway[];
  marker: Record<string, number>;
  setMarker: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  rolls: Roll[];
  setRolls: React.Dispatch<React.SetStateAction<Roll[]>>;
}) {
  const colorwayById = useMemo(
    () => Object.fromEntries(colorways.map((c) => [c.id, c])),
    [colorways],
  );

  // Выпуск = Σ по рулонам цвета: layers × perLayerQty[size]
  const output = useMemo(() => {
    const acc: Record<string, Record<string, number>> = {};
    for (const c of colorways) acc[c.id] = {};
    for (const roll of rolls) {
      if (!acc[roll.colorwayId]) acc[roll.colorwayId] = {};
      for (const s of SIZES) {
        acc[roll.colorwayId][s.id] =
          (acc[roll.colorwayId][s.id] || 0) +
          roll.layers * (marker[s.id] || 0);
      }
    }
    return acc;
  }, [rolls, marker, colorways]);

  const usedColorways = colorways.filter((c) =>
    rolls.some((r) => r.colorwayId === c.id),
  );

  const patchRoll = (id: string, upd: Partial<Roll>) =>
    setRolls((prev) => prev.map((r) => (r.id === id ? { ...r, ...upd } : r)));

  const addRoll = () =>
    setRolls((prev) => [
      ...prev,
      { id: nextId(), colorwayId: colorways[0]?.id ?? '', layers: 0 },
    ]);

  const removeRoll = (id: string) =>
    setRolls((prev) => prev.filter((r) => r.id !== id));

  return (
    <section className="cw-card">
      <header className="cw-section-head">
        <h2>
          <Scissors size={18} strokeWidth={1.8} aria-hidden /> Расклад 1 ·
          настил
        </h2>
        <span className="admin-muted">
          Один стол · один маркер · разноцветные рулоны в стопке
        </span>
      </header>

      {/* Маркер — общий для всех цветов */}
      <div className="cw-field">
        <span className="cw-field__label">
          Маркер (раскладка): штук размера в одном слое — общий на все цвета
        </span>
        <div className="cw-size-grid">
          {SIZES.map((s) => (
            <label key={s.id} className="cw-size-cell">
              <span>{s.code}</span>
              <input
                type="number"
                min={0}
                value={marker[s.id] ?? 0}
                onChange={(e) =>
                  setMarker((prev) => ({
                    ...prev,
                    [s.id]: Math.max(0, +e.target.value || 0),
                  }))
                }
              />
            </label>
          ))}
        </div>
      </div>

      {/* Рулоны — каждый один цвет */}
      <div className="cw-field">
        <div className="cw-rolls-head">
          <span className="cw-field__label">
            Рулоны в настиле — цвет + число слоёв
          </span>
          <button className="admin-btn admin-btn--ghost" onClick={addRoll}>
            <Plus size={15} strokeWidth={2} aria-hidden /> Добавить рулон
          </button>
        </div>

        <div className="cw-rolls">
          {rolls.map((roll, i) => {
            const cw = colorwayById[roll.colorwayId];
            const rollTotal = SIZES.reduce(
              (s, sz) => s + roll.layers * (marker[sz.id] || 0),
              0,
            );
            return (
              <div
                key={roll.id}
                className="cw-roll"
                style={{ ['--cw-accent' as string]: cw?.hex ?? '#999' }}
              >
                <span className="cw-roll__dot" />
                <span className="cw-roll__ord">Рулон {i + 1}</span>
                <select
                  className="cw-input cw-input--sm"
                  value={roll.colorwayId}
                  onChange={(e) =>
                    patchRoll(roll.id, { colorwayId: e.target.value })
                  }
                >
                  {colorways.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <label className="cw-layers">
                  <Layers size={14} strokeWidth={1.8} aria-hidden />
                  <input
                    type="number"
                    min={0}
                    value={roll.layers}
                    onChange={(e) =>
                      patchRoll(roll.id, {
                        layers: Math.max(0, +e.target.value || 0),
                      })
                    }
                  />
                  <span>слоёв</span>
                </label>
                <span className="cw-roll__out">→ {rollTotal} шт</span>
                <button
                  className="cw-icon-btn"
                  aria-label="Удалить рулон"
                  onClick={() => removeRoll(roll.id)}
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Матрица выпуска: цвет × размер */}
      <div className="cw-field">
        <span className="cw-field__label">
          Выпуск паспортов = слои × маркер (план vs факт по цвету и размеру)
        </span>
        <div className="cw-matrix-wrap">
          <table className="cw-matrix">
            <thead>
              <tr>
                <th>Цвет</th>
                {SIZES.map((s) => (
                  <th key={s.id}>{s.code}</th>
                ))}
                <th>Σ</th>
              </tr>
            </thead>
            <tbody>
              {usedColorways.map((c) => {
                const rowOut = output[c.id] || {};
                const rowTotal = SIZES.reduce(
                  (s, sz) => s + (rowOut[sz.id] || 0),
                  0,
                );
                return (
                  <tr key={c.id}>
                    <td>
                      <span
                        className="cw-dot"
                        style={{ background: c.hex }}
                      />
                      {c.name}
                    </td>
                    {SIZES.map((s) => {
                      const out = rowOut[s.id] || 0;
                      const plan = c.qty[s.id] || 0;
                      const cls =
                        out === plan
                          ? 'is-ok'
                          : out > plan
                            ? 'is-over'
                            : 'is-under';
                      return (
                        <td key={s.id} className={`cw-cell ${cls}`}>
                          <b>{out}</b>
                          <small>/ {plan}</small>
                        </td>
                      );
                    })}
                    <td className="cw-cell">
                      <b>{rowTotal}</b>
                    </td>
                  </tr>
                );
              })}
              {usedColorways.length === 0 && (
                <tr>
                  <td colSpan={SIZES.length + 2} className="admin-muted">
                    Добавьте рулон, чтобы увидеть выпуск.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="cw-legend">
          <span>
            <i className="cw-lg is-ok" /> план сходится
          </span>
          <span>
            <i className="cw-lg is-under" /> недобор
          </span>
          <span>
            <i className="cw-lg is-over" /> перекрой
          </span>
        </div>
      </div>

      <div className="cw-callout cw-callout--muted">
        <Info size={18} strokeWidth={1.8} aria-hidden />
        <div>
          Модель: <code>CuttingTaskRoll.variantId</code> — рулон несёт цвет,
          маркер (<code>perLayerQty</code>) общий на настил. Паспорт уже
          выпускается per-roll → красится в цвет рулона. Остаток плана считается
          по паре <code>(цвет, размер)</code>.
        </div>
      </div>
    </section>
  );
}

// ==========================================================
// Стили демо (scoped через .cw-demo, на токенах дизайн-системы)
// ==========================================================

function DemoStyles() {
  return (
    <style>{`
.cw-demo { display: flex; flex-direction: column; gap: var(--admin-space-lg, 18px); }
.cw-demo * { box-sizing: border-box; }

.cw-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--color-border); }
.cw-tab {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 10px 14px; border: none; background: none; cursor: pointer;
  font: inherit; font-weight: 600; color: var(--color-fg-muted);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.cw-tab:hover { color: var(--color-fg); }
.cw-tab.is-active { color: var(--color-fg-strong); border-bottom-color: var(--color-accent); }

.cw-card {
  background: var(--color-bg-card); border: 1px solid var(--color-border);
  border-radius: var(--admin-radius-card, 12px); box-shadow: var(--admin-shadow-soft);
  padding: 18px 20px; display: flex; flex-direction: column; gap: 18px;
}
.cw-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cw-section-head h2 { display: flex; align-items: center; gap: 8px; font-size: 18px; margin: 0; }
.cw-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 22px; height: 22px; padding: 0 6px; border-radius: var(--admin-radius-pill, 999px);
  background: var(--color-bg-muted); color: var(--color-fg-muted); font-size: 12px; font-weight: 700;
}

.cw-colorways { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.cw-colorway {
  position: relative; border: 1px solid var(--color-border); border-radius: 12px;
  padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 12px;
  background: var(--color-bg); overflow: hidden;
}
.cw-colorway::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--cw-accent); }
.cw-colorway__head { display: flex; align-items: center; gap: 10px; }
.cw-swatch { position: relative; width: 30px; height: 30px; flex: none; cursor: pointer; }
.cw-swatch input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.cw-swatch span { display: block; width: 30px; height: 30px; border-radius: 8px; border: 1px solid rgba(0,0,0,.15); }

.cw-input {
  width: 100%; padding: 7px 9px; border: 1px solid var(--color-border-strong);
  border-radius: 8px; font: inherit; background: var(--color-bg-card); color: var(--color-fg);
}
.cw-input:focus { outline: none; border-color: var(--color-accent); }
.cw-input--name { font-weight: 700; }
.cw-input--sm { width: auto; min-width: 120px; padding: 5px 8px; }

.cw-icon-btn {
  flex: none; margin-left: auto; display: inline-flex; padding: 7px; border-radius: 8px;
  border: 1px solid transparent; background: none; color: var(--color-fg-subtle); cursor: pointer;
}
.cw-icon-btn:hover { color: var(--color-danger); background: var(--color-danger-soft); }

.cw-field { display: flex; flex-direction: column; gap: 7px; }
.cw-field__label { font-size: 12px; font-weight: 600; color: var(--color-fg-muted); text-transform: uppercase; letter-spacing: .02em; }

.cw-size-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.cw-size-cell { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.cw-size-cell span { font-size: 11px; font-weight: 700; color: var(--color-fg-muted); }
.cw-size-cell input {
  width: 58px; padding: 6px; text-align: center; border: 1px solid var(--color-border-strong);
  border-radius: 8px; font: inherit; background: var(--color-bg-card); color: var(--color-fg);
}
.cw-size-cell input:focus { outline: none; border-color: var(--color-accent); }
.cw-size-cell--ro b, .cw-size-cell--total b {
  display: inline-flex; align-items: center; justify-content: center;
  width: 58px; height: 33px; border-radius: 8px; background: var(--color-bg-muted); font-size: 15px;
}
.cw-size-cell--total b { background: var(--color-bg-tint); color: var(--color-fg-strong); }

.cw-colorway__foot {
  display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--color-fg-muted);
  border-top: 1px dashed var(--color-border); padding-top: 10px;
}

.cw-totals { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 4px 2px; }
.cw-totals__label { font-weight: 700; }

.cw-callout {
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 10px;
  font-size: 13.5px; line-height: 1.45;
}
.cw-callout svg { flex: none; margin-top: 1px; }
.cw-callout code { background: rgba(0,0,0,.06); padding: 1px 5px; border-radius: 5px; font-size: 12.5px; }
.cw-callout--info { background: var(--color-accent-soft); color: var(--color-accent-fg); }
.cw-callout--info code { background: rgba(255,255,255,.55); }
.cw-callout--muted { background: var(--color-bg-soft); color: var(--color-fg-muted); border: 1px solid var(--color-border); }

/* Раскрой */
.cw-rolls-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cw-rolls { display: flex; flex-direction: column; gap: 8px; }
.cw-roll {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px; flex-wrap: wrap;
  border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg);
}
.cw-roll__dot { width: 12px; height: 12px; border-radius: 50%; background: var(--cw-accent); flex: none; border: 1px solid rgba(0,0,0,.15); }
.cw-roll__ord { font-weight: 700; min-width: 72px; }
.cw-layers { display: inline-flex; align-items: center; gap: 6px; color: var(--color-fg-muted); font-size: 13px; }
.cw-layers input {
  width: 64px; padding: 5px 7px; text-align: center; border: 1px solid var(--color-border-strong);
  border-radius: 8px; font: inherit; background: var(--color-bg-card); color: var(--color-fg);
}
.cw-roll__out { margin-left: auto; font-weight: 700; color: var(--color-fg-strong); }

.cw-matrix-wrap { overflow-x: auto; }
.cw-matrix { width: 100%; border-collapse: collapse; font-size: 14px; }
.cw-matrix th, .cw-matrix td { padding: 9px 12px; text-align: center; border-bottom: 1px solid var(--color-border); }
.cw-matrix th:first-child, .cw-matrix td:first-child { text-align: left; white-space: nowrap; }
.cw-matrix thead th { font-size: 11px; text-transform: uppercase; color: var(--color-fg-muted); letter-spacing: .03em; }
.cw-dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%; margin-right: 7px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.15); }
.cw-cell b { font-size: 15px; }
.cw-cell small { color: var(--color-fg-subtle); margin-left: 3px; }
.cw-cell.is-ok b { color: var(--color-ok-fg); }
.cw-cell.is-over b { color: var(--color-danger-fg); }
.cw-cell.is-under b { color: var(--color-warn-fg); }

.cw-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12.5px; color: var(--color-fg-muted); }
.cw-legend span { display: inline-flex; align-items: center; gap: 6px; }
.cw-lg { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.cw-lg.is-ok { background: var(--color-ok); }
.cw-lg.is-over { background: var(--color-danger); }
.cw-lg.is-under { background: var(--color-warn); }
`}</style>
  );
}
