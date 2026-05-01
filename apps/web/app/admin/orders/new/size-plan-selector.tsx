'use client';

/**
 * SizePlanSelector — компактный блок «4. План по размерам» для
 * страницы `/admin/orders/new` (этап «Номенклатура = Лекала»,
 * polish-итерация модалки размеров; см.
 * `docs/recon-soft-integration.md §«Номенклатура = Лекала»`).
 *
 * Зачем компонент:
 *   - до этой итерации блок размеров рендерил `AdminSizeGrid` сразу
 *     по всему справочнику `Size` — видимая «простыня» инпутов на
 *     половину высоты экрана. Это плохо смотрится для номенклатуры,
 *     у которой DXF готов только по 2-3 размерам.
 *   - теперь по умолчанию рендерится только summary («Итого: X шт.»
 *     + чипсы по выбранным размерам) + одна кнопка
 *     «Выбрать размеры». Полный набор инпутов открывается в
 *     модалке.
 *
 * Контракт со страницей (родителем):
 *   - `allSizes` — все размеры из справочника `Size` (нужны, чтобы
 *     родитель смог отрендерить hidden inputs `qty[<sizeId>]` для
 *     любого sizeId, который backend знает; недоступные размеры
 *     уходят как `0`).
 *   - `availableSizes` — подмножество `allSizes`, у которых в
 *     выбранной номенклатуре есть активный `PatternSizeFile`. Только
 *     эти размеры рендерим в модалке. Если массив пуст, модалка
 *     недоступна и в summary показывается подсказка.
 *   - `quantities` — текущее состояние `Record<sizeId, number>`,
 *     которое родитель держит у себя; компонент его не
 *     модифицирует напрямую, а вызывает `onQuantitiesChange` при
 *     сохранении модалки.
 *   - `selectedPatternName` / `selectedPatternArticle` — для
 *     заголовка модалки («Размеры номенклатуры — <имя> · <артикул>»).
 *     Если переданы оба, рисуем подзаголовок; иначе только
 *     заголовок.
 *
 * FormData-контракт сохраняется на стороне родителя:
 *   родительский компонент рисует hidden inputs
 *   `qty[<sizeId>]` для **всех** `allSizes`, value берёт из
 *   `quantities` (отсутствующие ключи = 0). `createOrderAction` в
 *   `apps/web/app/orders/actions.ts` молча пропускает qty <= 0,
 *   так что недоступные размеры безопасно уходят нулями.
 *
 * UX модалки:
 *   - открытие по кнопке «Выбрать размеры» / «Изменить размеры»;
 *   - изменения внутри модалки живут во временном `draftQuantities`,
 *     `Сохранить` пушит их наружу через `onQuantitiesChange`;
 *   - `Очистить` ставит 0 для всех `availableSizes` (только в
 *     драфте, до Сохранить);
 *   - `Отмена` и `Esc` закрывают без применения;
 *   - клик по backdrop тоже закрывает (как «Отмена»);
 *   - `Enter` внутри input — переход к следующему;
 *   - `min=0`, `step=1`, отрицательные / NaN отбрасываются.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Pencil, Plus, Ruler, X } from 'lucide-react';
import type { SizeDto } from '@sewing/shared/orders';

export interface SizePlanSelectorProps {
  /**
   * Все размеры справочника `Size`. Нужны только для отображения
   * порядка чипсов в summary; доступность определяется
   * `availableSizes`.
   */
  allSizes: readonly SizeDto[];
  /**
   * Только те размеры, у которых у выбранной номенклатуры есть
   * активный DXF (`PatternSizeFile.status = 'ACTIVE'`). Источник —
   * `PatternListItemDto.sizes` (см.
   * `apps/api/src/modules/patterns/patterns.service.ts::list`).
   */
  availableSizes: readonly SizeDto[];
  /** Текущие количества по `sizeId`. Отсутствие ключа = 0. */
  quantities: Record<string, number>;
  /**
   * Колбэк после нажатия «Сохранить» в модалке. Получает новый
   * `Record<sizeId, number>` (без нулевых значений — родитель не
   * хранит мусор; нули он сам подставит при рендере hidden inputs).
   */
  onQuantitiesChange: (next: Record<string, number>) => void;
  /**
   * Имя выбранной номенклатуры (для заголовка модалки). Если
   * `null` — модалка не открывается, подсказка «Сначала выберите
   * номенклатуру».
   */
  selectedPatternName?: string | null;
  /** Артикул выбранной номенклатуры — субтитр модалки. */
  selectedPatternArticle?: string | null;
}

function toPositiveInt(input: string): number {
  if (input.trim() === '') return 0;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function ru(n: number): string {
  return n.toLocaleString('ru-RU');
}

export function SizePlanSelector({
  allSizes,
  availableSizes,
  quantities,
  onQuantitiesChange,
  selectedPatternName,
  selectedPatternArticle,
}: SizePlanSelectorProps) {
  const titleId = useId();

  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, number>>({});

  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  const hasPattern = Boolean(selectedPatternName);
  const hasAvailable = availableSizes.length > 0;
  const canOpen = hasPattern && hasAvailable;

  // Чипсы summary: только те размеры с qty>0, в каноническом порядке
  // справочника `Size` (sortOrder).
  const summaryChips = useMemo(() => {
    const sorted = [...allSizes].sort((a, b) => a.sortOrder - b.sortOrder);
    return sorted
      .filter((s) => (quantities[s.id] ?? 0) > 0)
      .map((s) => ({ id: s.id, code: s.code, qty: quantities[s.id] ?? 0 }));
  }, [allSizes, quantities]);

  const total = useMemo(
    () =>
      Object.values(quantities).reduce(
        (sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0),
        0,
      ),
    [quantities],
  );

  const sortedAvailable = useMemo(
    () => [...availableSizes].sort((a, b) => a.sortOrder - b.sortOrder),
    [availableSizes],
  );

  const openModal = useCallback(() => {
    if (!canOpen) return;
    // Затягиваем текущие количества как стартовый драфт. Размеры,
    // которых нет в `availableSizes`, в модалку не попадают.
    const initialDraft: Record<string, number> = {};
    for (const s of sortedAvailable) {
      const v = quantities[s.id];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        initialDraft[s.id] = v;
      }
    }
    setDraft(initialDraft);
    setIsOpen(true);
  }, [canOpen, sortedAvailable, quantities]);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    // Возвращаем фокус на кнопку, открывшую модалку (a11y).
    requestAnimationFrame(() => {
      openButtonRef.current?.focus();
    });
  }, []);

  const saveAndClose = useCallback(() => {
    const cleaned: Record<string, number> = {};
    for (const s of sortedAvailable) {
      const v = draft[s.id];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        cleaned[s.id] = Math.floor(v);
      }
    }
    onQuantitiesChange(cleaned);
    closeModal();
  }, [draft, onQuantitiesChange, sortedAvailable, closeModal]);

  const clearDraft = useCallback(() => {
    setDraft({});
    // Фокус на первый input — после очистки удобно сразу начать ввод.
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    });
  }, []);

  const handleDraftChange = useCallback(
    (sizeId: string) => (e: ChangeEvent<HTMLInputElement>) => {
      const value = toPositiveInt(e.target.value);
      setDraft((prev) => {
        if (value > 0) {
          if (prev[sizeId] === value) return prev;
          return { ...prev, [sizeId]: value };
        }
        if (!prev[sizeId]) return prev;
        const next = { ...prev };
        delete next[sizeId];
        return next;
      });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (index: number) => (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        // Никогда не сабмитим внешнюю форму по Enter из модалки —
        // менеджер вводит несколько полей подряд, случайный submit
        // ломает работу. Переход к следующему/предыдущему input —
        // по Enter / Shift+Enter (как в старом AdminSizeGrid).
        e.preventDefault();
        const direction = e.shiftKey ? -1 : 1;
        const nextIdx = index + direction;
        const nextEl = inputRefs.current[nextIdx];
        if (nextEl && !nextEl.disabled) {
          nextEl.focus();
          nextEl.select();
        }
        return;
      }
    },
    [],
  );

  // Esc / focus-trap-light: пока модалка открыта, ловим Esc на
  // window и закрываем без сохранения. Полноценный focus-trap не
  // делаем — контента в модалке мало, навигация Tab по умолчанию
  // справляется.
  useEffect(() => {
    if (!isOpen) return;
    function onKey(ev: globalThis.KeyboardEvent) {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        setIsOpen(false);
        requestAnimationFrame(() => {
          openButtonRef.current?.focus();
        });
      }
    }
    document.addEventListener('keydown', onKey);
    // Автофокус в первый input при открытии — стандартный UX модалок.
    requestAnimationFrame(() => {
      firstInputRef.current?.focus();
      firstInputRef.current?.select();
    });
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  const draftTotal = useMemo(
    () =>
      Object.values(draft).reduce(
        (sum, v) => sum + (Number.isFinite(v) && v > 0 ? v : 0),
        0,
      ),
    [draft],
  );

  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // Клик именно по backdrop, а не по контенту модалки.
      if (e.target === e.currentTarget) {
        setIsOpen(false);
        requestAnimationFrame(() => {
          openButtonRef.current?.focus();
        });
      }
    },
    [],
  );

  const buttonLabel = total > 0 ? 'Изменить размеры' : 'Выбрать размеры';
  const ButtonIcon = total > 0 ? Pencil : Plus;

  // Разные подсказки в зависимости от состояния:
  //   - нет лекала → «Сначала выберите номенклатуру»
  //   - лекало есть, но нет активных DXF → подсказка про DXF
  //   - всё ок, но qty=0 → «Размеры не выбраны»
  let hint: string;
  if (!hasPattern) {
    hint = 'Сначала выберите номенклатуру';
  } else if (!hasAvailable) {
    hint =
      'У выбранной номенклатуры нет активных размеров. Загрузите DXF по размерам в карточке номенклатуры.';
  } else if (total === 0) {
    hint = 'Заполните количество хотя бы в одном размере.';
  } else {
    hint = `Выбрано размеров: ${summaryChips.length}`;
  }

  return (
    <div className="admin-size-plan" data-size-plan="true">
      <div className="admin-size-plan__summary">
        {total === 0 ? (
          <p className="admin-size-plan__empty-title">Размеры не выбраны</p>
        ) : (
          <p className="admin-size-plan__count">
            Выбрано размеров: <strong>{summaryChips.length}</strong>
          </p>
        )}
        {(total > 0 || !hasPattern || !hasAvailable) && (
          <p className="admin-size-plan__hint">{hint}</p>
        )}
        {total === 0 && hasPattern && hasAvailable && (
          <p className="admin-size-plan__hint admin-size-plan__hint--muted">
            {hint}
          </p>
        )}
        {summaryChips.length > 0 && (
          <ul
            className="admin-size-plan__chips"
            aria-label="Выбранные размеры"
          >
            {summaryChips.map((c) => (
              <li key={c.id} className="admin-size-plan__chip">
                <span className="admin-size-plan__chip-code">{c.code}</span>
                <span className="admin-size-plan__chip-sep" aria-hidden>
                  —
                </span>
                <span className="admin-size-plan__chip-qty">
                  {ru(c.qty)} шт.
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="admin-size-plan__actions">
        <button
          ref={openButtonRef}
          type="button"
          className="admin-btn admin-btn--primary admin-size-plan__open-btn"
          onClick={openModal}
          disabled={!canOpen}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
        >
          <ButtonIcon size={16} strokeWidth={1.7} aria-hidden />
          {buttonLabel}
        </button>
      </div>

      {isOpen && (
        <div
          className="admin-size-plan-modal__backdrop"
          onMouseDown={handleBackdropClick}
          data-size-plan-modal="true"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="admin-size-plan-modal"
          >
            <header className="admin-size-plan-modal__header">
              <span
                className="admin-order-card__icon admin-order-card__icon--violet"
                aria-hidden
              >
                <Ruler size={18} strokeWidth={1.7} />
              </span>
              <div className="admin-size-plan-modal__titles">
                <h3 id={titleId} className="admin-size-plan-modal__title">
                  Размеры номенклатуры
                </h3>
                {selectedPatternName && (
                  <p className="admin-size-plan-modal__subtitle">
                    {selectedPatternName}
                    {selectedPatternArticle ? (
                      <>
                        {' · '}
                        <span className="admin-size-plan-modal__article">
                          {selectedPatternArticle}
                        </span>
                      </>
                    ) : null}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="admin-size-plan-modal__close"
                onClick={closeModal}
                aria-label="Закрыть"
              >
                <X size={18} strokeWidth={1.8} aria-hidden />
              </button>
            </header>

            <div className="admin-size-plan-modal__body">
              {sortedAvailable.length === 0 ? (
                <p className="admin-muted" style={{ margin: 0 }}>
                  У номенклатуры нет активных размеров.
                </p>
              ) : (
                <ul className="admin-size-plan-modal__rows">
                  {sortedAvailable.map((s, idx) => {
                    const v = draft[s.id] ?? 0;
                    return (
                      <li
                        key={s.id}
                        className={
                          'admin-size-plan-modal__row' +
                          (v > 0 ? ' admin-size-plan-modal__row--active' : '')
                        }
                      >
                        <label
                          className="admin-size-plan-modal__row-label"
                          htmlFor={`size-plan-input-${s.id}`}
                        >
                          {s.code}
                        </label>
                        <input
                          ref={(el) => {
                            inputRefs.current[idx] = el;
                            if (idx === 0) firstInputRef.current = el;
                          }}
                          id={`size-plan-input-${s.id}`}
                          type="number"
                          min={0}
                          step={1}
                          inputMode="numeric"
                          className="admin-size-plan-modal__row-input"
                          value={v === 0 ? '' : String(v)}
                          onChange={handleDraftChange(s.id)}
                          onKeyDown={handleKeyDown(idx)}
                          placeholder="0"
                          aria-label={`Количество для размера ${s.code}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="admin-size-plan-modal__footer">
              <span className="admin-size-plan-modal__total">
                Итого в драфте: <strong>{ru(draftTotal)} шт.</strong>
              </span>
              <div className="admin-size-plan-modal__footer-actions">
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={clearDraft}
                  disabled={sortedAvailable.length === 0}
                >
                  Очистить
                </button>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={closeModal}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="admin-btn admin-btn--primary"
                  onClick={saveAndClose}
                  disabled={sortedAvailable.length === 0}
                >
                  Сохранить
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
