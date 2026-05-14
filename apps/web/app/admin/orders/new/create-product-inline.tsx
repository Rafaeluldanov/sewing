'use client';

/**
 * Inline-форма «Создать изделие» внутри блока «Изделие» на
 * `/admin/orders/new`.
 *
 * Семантика: это **локальная** форма — кнопка «Сохранить изделие»
 * НЕ отправляет на backend. Она собирает данные нового изделия в
 * структурированный объект `SavedInlineProductPayload` и передаёт его
 * родителю через колбэк `onSave`. Родитель хранит объект в state,
 * сериализует в hidden input `newProductCalculationJson` и шлёт в
 * составе обычного `createOrderAction` (FormData) при клике херо-кнопки
 * «Создать заказ».
 *
 * Поля inline-формы (две вкладки):
 *   - «Сделать расчет» (default): селект группы номенклатуры (опц.),
 *     селект техкарты (опц.), таблица «Размерная матрица и расход»,
 *     поле «Стоимость разработки лекала». Все поля опциональны —
 *     можно сохранить изделие минимальным.
 *   - «Отправить изделие конструктору» — заглушка.
 *
 * Inline-create category / tech-card открываются в `DraggableWindow`-ах
 * (`create-category-window.tsx`, `create-tech-card-window.tsx`).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { Plus, X } from 'lucide-react';
import type {
  CompatibleTechCardDto,
  CompatibleTechCardsResponseDto,
  PatternCategoryDto,
  PatternCategoryListItemDto,
  PatternCategoryParameterDto,
} from '@sewing/shared/pattern-categories';
import type { SizeDto } from '@sewing/shared/orders';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import {
  loadCompatibleTechCardsAction,
  loadPatternCategoryDetailAction,
} from './inline-product-actions';
import { CreateCategoryWindow } from './create-category-window';
import {
  CreateTechCardWindow,
  type PrefilledMaterialLineSeed,
} from './create-tech-card-window';

/**
 * Локальный «снимок» сохранённого inline-изделия. Хранится в state
 * родительской формы и сериализуется в hidden input при сабмите заказа.
 * Поля `categoryName` / `techCardName` / `sizeCodes` нужны только для
 * UI-резюме «Изделие №1» — backend их игнорирует и читает только
 * `categoryId / techCardId / patternDevelopmentCostRub / sizes`.
 */
export interface SavedInlineProductPayload {
  categoryId: string | null;
  categoryName: string | null;
  techCardId: string | null;
  techCardName: string | null;
  patternDevelopmentCostRub: string | null;
  sizes: Array<{
    sizeId: string;
    sizeCode: string;
    qtyPlan: number;
    areas: Array<{ roleKey: string; label: string; areaM2: string }>;
  }>;
}

interface SizeRowState {
  key: string;
  sizeId: string;
  qtyPlan: string;
  areas: Record<string, string>;
}

type TabId = 'calculate' | 'constructor';

interface Props {
  /** Активные группы номенклатуры. */
  initialCategories: PatternCategoryListItemDto[];
  /** Активные техкарты. */
  initialTechCards: TechCardTemplateSummaryDto[];
  /** Справочник размеров. */
  sizes: SizeDto[];
  /**
   * Активные номенклатуры — нужны селектy «Подтянуть номенклатуры»
   * внутри `CreateTechCardWindow`. Если в проекте нет ни одной,
   * массив пуст — модалка просто покажет disabled-сообщение.
   */
  initialPatterns?: PatternListItemDto[];
  /** Колбэк локального сохранения. Родитель кладёт payload в state. */
  onSave: (payload: SavedInlineProductPayload) => void;
  /** Колбэк выхода из inline-режима (например, «Назад»). */
  onCancel: () => void;
  /**
   * Предзаполнение формы (режим «Редактировать»). Если задано,
   * inline-форма стартует с этими значениями.
   */
  initialValue?: SavedInlineProductPayload | null;
}

let __rowSeq = 0;
function nextRowKey(): string {
  __rowSeq += 1;
  return `row_${Date.now().toString(36)}_${__rowSeq}`;
}

function rowsFromInitial(
  initial: SavedInlineProductPayload | null | undefined,
): SizeRowState[] {
  if (!initial) return [];
  return initial.sizes.map((s) => {
    const areas: Record<string, string> = {};
    for (const a of s.areas) areas[a.roleKey] = a.areaM2;
    return {
      key: nextRowKey(),
      sizeId: s.sizeId,
      qtyPlan: String(s.qtyPlan),
      areas,
    };
  });
}

export function CreateProductInline({
  initialCategories,
  initialTechCards,
  sizes,
  onSave,
  onCancel,
  initialValue = null,
  initialPatterns = [],
}: Props) {
  const [tab, setTab] = useState<TabId>('calculate');

  const [categories, setCategories] =
    useState<PatternCategoryListItemDto[]>(initialCategories);
  const [techCards, setTechCards] =
    useState<TechCardTemplateSummaryDto[]>(initialTechCards);

  const [categoryId, setCategoryId] = useState<string>(
    initialValue?.categoryId ?? '',
  );
  const [techCardId, setTechCardId] = useState<string>(
    initialValue?.techCardId ?? '',
  );
  const [categoryDetail, setCategoryDetail] =
    useState<PatternCategoryDto | null>(null);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [compatibility, setCompatibility] =
    useState<CompatibleTechCardsResponseDto | null>(null);

  const [rows, setRows] = useState<SizeRowState[]>(() =>
    rowsFromInitial(initialValue),
  );
  const [devCost, setDevCost] = useState<string>(
    initialValue?.patternDevelopmentCostRub ?? '',
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [showCategoryWindow, setShowCategoryWindow] = useState(false);
  const [showTechCardWindow, setShowTechCardWindow] = useState(false);

  const sortedSizes = useMemo(
    () => [...sizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [sizes],
  );

  const areaParameters = useMemo<PatternCategoryParameterDto[]>(() => {
    if (!categoryDetail) return [];
    return categoryDetail.parameters
      .filter(
        (p) => p.inputType === 'AREA_M2_BY_SIZE' && p.status === 'ACTIVE',
      )
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [categoryDetail]);

  useEffect(() => {
    // При смене категории сбрасываем выбранную техкарту, грузим
    // карточку категории + список совместимых техкарт.
    if (initialValue && initialValue.categoryId === categoryId) {
      // На первом монтировании при редактировании НЕ сбрасываем
      // techCardId — он пришёл из initialValue.
    } else {
      setTechCardId('');
    }
    setCompatibility(null);
    if (!categoryId) {
      setCategoryDetail(null);
      return;
    }
    let cancelled = false;
    setCategoryLoading(true);
    Promise.all([
      loadPatternCategoryDetailAction(categoryId),
      loadCompatibleTechCardsAction(categoryId),
    ])
      .then(([cat, compat]) => {
        if (cancelled) return;
        if ('error' in cat) setCategoryDetail(null);
        else setCategoryDetail(cat);
        if ('error' in compat) setCompatibility(null);
        else setCompatibility(compat);
      })
      .finally(() => {
        if (!cancelled) setCategoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  useEffect(() => {
    setRows((prev) =>
      prev.map((row) => {
        const next: Record<string, string> = {};
        for (const p of areaParameters) {
          next[p.roleKey] = row.areas[p.roleKey] ?? '';
        }
        return { ...row, areas: next };
      }),
    );
  }, [areaParameters]);

  const addRow = useCallback(() => {
    setRows((prev) => {
      const used = new Set(prev.map((r) => r.sizeId));
      const next = sortedSizes.find((s) => !used.has(s.id));
      const areas: Record<string, string> = {};
      for (const p of areaParameters) areas[p.roleKey] = '';
      return [
        ...prev,
        {
          key: nextRowKey(),
          sizeId: next?.id ?? '',
          qtyPlan: '',
          areas,
        },
      ];
    });
  }, [sortedSizes, areaParameters]);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }, []);

  const updateRowSize = useCallback((key: string, sizeId: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, sizeId } : r)),
    );
  }, []);

  const updateRowQty = useCallback((key: string, qty: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, qtyPlan: qty } : r)),
    );
  }, []);

  const updateRowArea = useCallback(
    (key: string, roleKey: string, value: string) => {
      setRows((prev) =>
        prev.map((r) =>
          r.key === key
            ? { ...r, areas: { ...r.areas, [roleKey]: value } }
            : r,
        ),
      );
    },
    [],
  );

  const activeCompatibility = useMemo<
    Map<string, CompatibleTechCardDto>
  >(() => {
    const m = new Map<string, CompatibleTechCardDto>();
    if (!compatibility) return m;
    for (const t of compatibility.techCards) m.set(t.id, t);
    return m;
  }, [compatibility]);

  const techCardSeedLines = useMemo<PrefilledMaterialLineSeed[]>(() => {
    return areaParameters.map((p) => ({
      name: p.label,
      materialRole: p.roleKey,
      fabricType: p.label,
      unit: 'кг',
      qtyPerUnit: '1.0000',
    }));
  }, [areaParameters]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Локальная валидация — построчно. Пустые строки пропускаем.
    const sizesPayload: SavedInlineProductPayload['sizes'] = [];
    for (const row of rows) {
      if (!row.sizeId) continue;
      const qty = Number(row.qtyPlan);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
        setSubmitError(
          'Если размер выбран, укажите количество — целое число > 0',
        );
        return;
      }
      const areas: SavedInlineProductPayload['sizes'][number]['areas'] = [];
      for (const p of areaParameters) {
        const v = (row.areas[p.roleKey] ?? '').trim();
        if (v === '') continue;
        const n = Number(v.replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) {
          setSubmitError(`«${p.label}» должен быть числом > 0`);
          return;
        }
        areas.push({ roleKey: p.roleKey, label: p.label, areaM2: v });
      }
      const sizeCode =
        sortedSizes.find((s) => s.id === row.sizeId)?.code ?? row.sizeId;
      sizesPayload.push({
        sizeId: row.sizeId,
        sizeCode,
        qtyPlan: qty,
        areas,
      });
    }

    const categoryName = categoryId
      ? (categories.find((c) => c.id === categoryId)?.name ?? null)
      : null;
    const techCardName = techCardId
      ? (techCards.find((t) => t.id === techCardId)?.name ?? null)
      : null;

    onSave({
      categoryId: categoryId === '' ? null : categoryId,
      categoryName,
      techCardId: techCardId === '' ? null : techCardId,
      techCardName,
      patternDevelopmentCostRub:
        devCost.trim() === '' ? null : devCost.trim().replace(',', '.'),
      sizes: sizesPayload,
    });
  }

  return (
    <div className="cpi">
      <div className="cpi-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'calculate'}
          className={`cpi-tab ${tab === 'calculate' ? 'cpi-tab--active' : ''}`}
          onClick={() => setTab('calculate')}
        >
          Сделать расчет
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'constructor'}
          className={`cpi-tab ${tab === 'constructor' ? 'cpi-tab--active' : ''}`}
          onClick={() => setTab('constructor')}
        >
          Отправить изделие конструктору
        </button>
      </div>

      {tab === 'calculate' && (
        // type="button" на submit, чтобы родительский <form action=
        // createOrderAction> не перехватил submit формы заказа — у нас
        // тут локальное сохранение через onSave.
        <div className="cpi-form">
          {/* Группа номенклатуры — опциональна. */}
          <div className="cpi-field">
            <label htmlFor="cpi-category">Группа номенклатуры</label>
            <div className="cpi-inline-row">
              <select
                id="cpi-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <option value="">— не указана —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={() => setShowCategoryWindow(true)}
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить группу
                номенклатуры
              </button>
            </div>
            <span className="cpi-muted">
              Без выбора группы изделие всё равно можно сохранить —
              таблица расхода материалов появится после выбора группы
              с параметрами «Площадь по размерам».
            </span>
          </div>

          {/* Техкарта — опциональна. */}
          <div className="cpi-field">
            <label htmlFor="cpi-techcard">Техкарта</label>
            <div className="cpi-inline-row">
              <select
                id="cpi-techcard"
                value={techCardId}
                onChange={(e) => setTechCardId(e.target.value)}
                disabled={categoryLoading}
              >
                <option value="">— не выбрана —</option>
                {techCards
                  .filter((tc) => tc.isActive)
                  .map((tc) => {
                    const c = activeCompatibility.get(tc.id);
                    const lvl = c?.compatibility;
                    const suffix = lvl
                      ? lvl === 'FULL'
                        ? ' · ✓ совместима'
                        : lvl === 'PARTIAL'
                          ? ' · ⚠ покрывает не все материалы'
                          : ' · ✕ не совместима'
                      : '';
                    return (
                      <option key={tc.id} value={tc.id}>
                        {tc.name}
                        {suffix}
                      </option>
                    );
                  })}
              </select>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={() => setShowTechCardWindow(true)}
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить
                техкарту
              </button>
            </div>
            {compatibility && techCardId &&
              (() => {
                const c = activeCompatibility.get(techCardId);
                if (!c || c.missingRoleKeys.length === 0) return null;
                return (
                  <div className="cpi-warn">
                    Техкарта не покрывает:{' '}
                    {c.missingRoleKeys.join(', ')}. При сохранении заказа
                    backend вернёт ошибку
                    TECH_CARD_NOT_COMPATIBLE_WITH_CATEGORY.
                  </div>
                );
              })()}
          </div>

          {/* Таблица «Размерная матрица и расход». */}
          <div className="cpi-section">
            <header className="cpi-section__header">
              <h3>Размерная матрица и расход</h3>
              <button
                type="button"
                className="cpi-btn cpi-btn--ghost"
                onClick={addRow}
                disabled={
                  sortedSizes.length === 0 ||
                  rows.length >= Math.max(sortedSizes.length, 1)
                }
                title={
                  sortedSizes.length === 0
                    ? 'Справочник размеров пуст'
                    : undefined
                }
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden /> Добавить
                размер
              </button>
            </header>
            {sortedSizes.length === 0 ? (
              <p className="cpi-muted">
                Справочник размеров пуст — добавьте размеры в
                `/admin/sizes`, прежде чем заводить заказ.
              </p>
            ) : rows.length === 0 ? (
              <p className="cpi-muted">
                Нажмите «Добавить размер», чтобы заполнить план тиража
                {areaParameters.length > 0
                  ? ' и расход материалов на 1 изделие.'
                  : '.'}
              </p>
            ) : (
              <div className="cpi-table-wrap">
                <table className="cpi-table">
                  <thead>
                    <tr>
                      <th>Размер</th>
                      <th>Количество, шт</th>
                      {areaParameters.map((p) => (
                        <th key={p.id}>{p.label}, м²/шт</th>
                      ))}
                      <th aria-label="actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <select
                            value={row.sizeId}
                            onChange={(e) =>
                              updateRowSize(row.key, e.target.value)
                            }
                          >
                            <option value="">—</option>
                            {sortedSizes.map((s) => {
                              const taken = rows.some(
                                (r) =>
                                  r.sizeId === s.id && r.key !== row.key,
                              );
                              return (
                                <option
                                  key={s.id}
                                  value={s.id}
                                  disabled={taken}
                                >
                                  {s.code}
                                </option>
                              );
                            })}
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={row.qtyPlan}
                            onChange={(e) =>
                              updateRowQty(row.key, e.target.value)
                            }
                          />
                        </td>
                        {areaParameters.map((p) => (
                          <td key={p.id}>
                            <input
                              type="text"
                              inputMode="decimal"
                              placeholder="0.0000"
                              value={row.areas[p.roleKey] ?? ''}
                              onChange={(e) =>
                                updateRowArea(
                                  row.key,
                                  p.roleKey,
                                  e.target.value,
                                )
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            className="cpi-icon-btn"
                            aria-label="Удалить строку"
                            onClick={() => removeRow(row.key)}
                          >
                            <X size={14} strokeWidth={1.7} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {categoryId && areaParameters.length === 0 && (
              <p className="cpi-muted">
                У группы нет активных параметров «Площадь по размерам» —
                колонок расхода не будет. Можно заполнить только тираж
                по размерам; расход материалов на 1 изделие добавится
                позже в карточке лекала.
              </p>
            )}
          </div>

          {/* Стоимость разработки лекала. */}
          <div className="cpi-field">
            <label htmlFor="cpi-dev-cost">
              Стоимость разработки лекала, ₽
            </label>
            <input
              id="cpi-dev-cost"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={devCost}
              onChange={(e) => setDevCost(e.target.value)}
            />
            <span className="cpi-muted">
              Управленческая метрика — в текущий расчёт себестоимости и
              потребности цеха не входит.
            </span>
          </div>

          {submitError && (
            <div className="cpi-error" role="alert">
              {submitError}
            </div>
          )}

          <footer className="cpi-footer">
            <button
              type="button"
              className="cpi-btn cpi-btn--ghost"
              onClick={onCancel}
            >
              Отмена
            </button>
            {/* Локальное сохранение: тип "button" + ручной onClick,
                чтобы не сабмитить родительский <form action={createOrderAction}>. */}
            <button
              type="button"
              className="cpi-btn cpi-btn--primary"
              onClick={onSubmit}
            >
              Сохранить изделие
            </button>
          </footer>
        </div>
      )}

      {tab === 'constructor' && (
        <div className="cpi-stub">
          <p>
            Заявка конструктору пока недоступна — модель отправки лекала на
            разработку появится отдельной задачей.
          </p>
          <p className="cpi-muted">
            На MVP используйте вкладку «Сделать расчет».
          </p>
          <button
            type="button"
            className="cpi-btn cpi-btn--ghost"
            onClick={onCancel}
          >
            Вернуться
          </button>
        </div>
      )}

      {showCategoryWindow && (
        <CreateCategoryWindow
          onCancel={() => setShowCategoryWindow(false)}
          onCreated={(cat) => {
            setCategories((prev) => [
              ...prev.filter((c) => c.id !== cat.id),
              {
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                iconKey: cat.iconKey,
                iconImageUrl: cat.iconImageUrl,
                iconOriginalFileName: cat.iconOriginalFileName,
                sortOrder: cat.sortOrder,
                status: cat.status,
                description: cat.description,
                parametersCount: cat.parameters.length,
                patternsCount: 0,
                createdAt: cat.createdAt,
                updatedAt: cat.updatedAt,
              },
            ]);
            setCategoryId(cat.id);
            setShowCategoryWindow(false);
          }}
        />
      )}

      {showTechCardWindow && (
        <CreateTechCardWindow
          patternCategoryId={categoryId || null}
          prefilledMaterialLines={techCardSeedLines}
          patternItems={initialPatterns.map((p) => ({
            id: p.id,
            name: p.name,
            article: p.article,
          }))}
          patternCategories={categories.map((c) => ({
            id: c.id,
            name: c.name,
          }))}
          suggestedCode={
            categoryDetail
              ? `${categoryDetail.slug.toUpperCase()}-${Date.now()
                  .toString(36)
                  .toUpperCase()
                  .slice(-4)}`
              : ''
          }
          suggestedName={
            categoryDetail ? `Техкарта · ${categoryDetail.name}` : ''
          }
          onCancel={() => setShowTechCardWindow(false)}
          onCreated={(tc) => {
            setTechCards((prev) => [
              ...prev.filter((t) => t.id !== tc.id),
              {
                id: tc.id,
                code: tc.code,
                name: tc.name,
                isActive: tc.isActive,
                patternCategoryId: tc.patternCategoryId ?? null,
                materialLinesCount: tc.materialLines.length,
                outsourceLinesCount: tc.outsourceLines.length,
                createdAt: tc.createdAt,
                updatedAt: tc.updatedAt,
              },
            ]);
            setTechCardId(tc.id);
            if (categoryId) {
              loadCompatibleTechCardsAction(categoryId).then((compat) => {
                if (!('error' in compat)) setCompatibility(compat);
              });
            }
            setShowTechCardWindow(false);
          }}
        />
      )}

      <style>{`
        .cpi { display: flex; flex-direction: column; gap: 12px; }
        .cpi-tabs {
          display: flex; gap: 4px;
          border-bottom: 1px solid #e2e8f0;
          margin-bottom: 8px;
        }
        .cpi-tab {
          background: transparent; border: none;
          padding: 8px 12px; font-size: 0.9rem;
          color: #475569; cursor: pointer;
          border-bottom: 2px solid transparent;
        }
        .cpi-tab--active { color: #0f172a; border-bottom-color: #2563eb; }
        .cpi-form { display: flex; flex-direction: column; gap: 14px; }
        .cpi-field { display: flex; flex-direction: column; gap: 4px; }
        .cpi-field > label { font-size: 0.85rem; font-weight: 600; color: #1f2937; }
        .cpi-field > input, .cpi-field > select, .cpi-field > textarea {
          padding: 6px 8px; border: 1px solid #cbd5e1;
          border-radius: 6px; font-size: 0.92rem; background: #fff;
        }
        .cpi-inline-row { display: flex; gap: 8px; }
        .cpi-inline-row > select { flex: 1; min-width: 0; }
        .cpi-btn {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 6px 10px; border-radius: 6px; font-size: 0.85rem;
          cursor: pointer; border: 1px solid transparent;
        }
        .cpi-btn--primary { background: #2563eb; color: #fff; border-color: #2563eb; }
        .cpi-btn--primary:hover { background: #1d4ed8; }
        .cpi-btn--ghost { background: #f8fafc; color: #1f2937; border-color: #cbd5e1; }
        .cpi-btn--ghost:hover { background: #e2e8f0; }
        .cpi-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .cpi-icon-btn {
          background: transparent; border: none; cursor: pointer;
          padding: 4px; border-radius: 4px; color: #475569;
        }
        .cpi-icon-btn:hover { background: #f1f5f9; }
        .cpi-muted { color: #64748b; font-size: 0.82rem; margin: 0; }
        .cpi-section { display: flex; flex-direction: column; gap: 8px; }
        .cpi-section__header {
          display: flex; justify-content: space-between; align-items: center;
        }
        .cpi-section__header h3 { margin: 0; font-size: 0.95rem; color: #0f172a; }
        .cpi-table-wrap { overflow-x: auto; }
        .cpi-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
        .cpi-table th, .cpi-table td {
          border: 1px solid #e2e8f0; padding: 4px 6px;
          text-align: left; vertical-align: middle;
        }
        .cpi-table input, .cpi-table select {
          width: 100%; padding: 4px 6px;
          border: 1px solid #cbd5e1; border-radius: 4px;
          background: #fff; font-size: 0.88rem;
        }
        .cpi-warn {
          background: #fef3c7; color: #92400e;
          border: 1px solid #fde68a;
          padding: 6px 8px; border-radius: 6px; font-size: 0.85rem;
        }
        .cpi-error {
          background: #fee2e2; color: #991b1b;
          border: 1px solid #fecaca;
          padding: 6px 8px; border-radius: 6px; font-size: 0.88rem;
        }
        .cpi-footer {
          display: flex; justify-content: flex-end; gap: 8px;
          border-top: 1px solid #e2e8f0; padding-top: 12px;
        }
        .cpi-stub { padding: 8px; color: #475569; display: flex; flex-direction: column; gap: 8px; }
      `}</style>
    </div>
  );
}
