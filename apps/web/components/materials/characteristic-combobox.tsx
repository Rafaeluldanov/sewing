'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  normalizeMaterialCharacteristicOptionValue,
  type MaterialCharacteristicOptionDto,
} from '@sewing/shared/material-characteristic-options';
import {
  addCharacteristicOptionAction,
  loadCharacteristicOptionsAction,
  removeCharacteristicOptionAction,
} from './characteristic-options-actions';

/**
 * Поле «Характеристика» строки материала: ввод + выбор из пополняемого
 * списка.
 *
 * Заменяет собой убранное поле «Подтип» (решение пользователя 29.07.2026,
 * макет `docs/mockups/tech-card-characteristic-combobox-mockup.html`).
 * Значения бывшего подтипа теперь просто первые пункты этого списка, и
 * рядом с ними живут значения, которые менеджеры дописали сами.
 *
 * Ключевое поведение:
 *   - клик по пустому полю показывает ВЕСЬ список роли (не нужно угадывать
 *     первую букву), набор текста фильтрует список;
 *   - совпадений нет → внизу жёлтая строка «+ Добавить «…» в список»: это
 *     единственный способ пополнить справочник (пополнение «молча при
 *     сохранении» сознательно не делаем — список зарастал бы опечатками);
 *   - пользовательские значения помечены «своё» и убираются крестиком;
 *     техкарты, где значение уже проставлено, при этом не меняются.
 *
 * Набранный, но не добавленный в список текст всё равно уходит в строку
 * техкарты — поле остаётся обычным текстовым вводом, список лишь
 * подсказывает.
 *
 * Справочник грузится ОДИН раз на вкладку (модульный кэш ниже): строк
 * материала в техкарте бывает полтора десятка, и дёргать API на каждый
 * фокус было бы расточительно.
 */

interface Props {
  /** Роль материала строки — от неё зависит список. Пустая → без списка. */
  roleKey: string;
  value: string;
  /** Каждое нажатие клавиши (для форм, где state живёт снаружи). */
  onChange?: (value: string) => void;
  /**
   * Значение «зафиксировано»: выбор из списка, добавление, Enter, blur.
   * Для экранов, которые сохраняют по факту, а не по каждому символу
   * (спецификация заказа).
   */
  onCommit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** `name` для submit-а внутри обычной HTML-формы. */
  name?: string;
  id?: string;
  required?: boolean;
  maxLength?: number;
  /** Отдать наружу текст ошибки справочника (кнопка/строка формы). */
  onError?: (message: string | null) => void;
}

/**
 * Модульный кэш справочника: обещание первого запроса. Все комбобоксы
 * страницы разделяют одну загрузку. Сбрасывается при добавлении/удалении,
 * чтобы соседние поля увидели свежий список.
 */
let optionsCache: Promise<MaterialCharacteristicOptionDto[]> | null = null;
/** Подписчики на обновление кэша — соседние поля перерисовываются. */
const subscribers = new Set<(o: MaterialCharacteristicOptionDto[]) => void>();

function loadOptions(): Promise<MaterialCharacteristicOptionDto[]> {
  if (!optionsCache) {
    optionsCache = loadCharacteristicOptionsAction().then((r) =>
      r.ok && r.options ? r.options : [],
    );
  }
  return optionsCache;
}

function publish(next: MaterialCharacteristicOptionDto[]): void {
  optionsCache = Promise.resolve(next);
  for (const fn of subscribers) fn(next);
}

export function CharacteristicCombobox({
  roleKey,
  value,
  onChange,
  onCommit,
  disabled,
  placeholder,
  name,
  id,
  required,
  maxLength = 120,
  onError,
}: Props) {
  const autoId = useId();
  const inputId = id ?? `mcbx-${autoId}`;
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<MaterialCharacteristicOptionDto[] | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Значение может смениться снаружи (подтянули строки из номенклатуры,
  // сервер вернул свежий снимок) — draft обязан за ним следовать.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Подписка на общий кэш: сосед добавил значение — видим его сразу.
  useEffect(() => {
    const fn = (next: MaterialCharacteristicOptionDto[]) => setAll(next);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);

  // Закрытие по клику мимо. Внутри popup-а mousedown гасим (см. ниже),
  // поэтому выбор пункта не считается «кликом мимо».
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  function ensureLoaded(): void {
    if (all !== null) return;
    void loadOptions().then(setAll);
  }

  // Роль не задана — показываем значения ВСЕХ ролей. Это случай строки,
  // заведённой прямо в заказе: роли у неё нет, и она как раз выводится из
  // выбранной характеристики. С фильтром по пустой роли список был пуст, и
  // задать молнии её характеристику было физически нечем.
  const roleless = roleKey.trim() === '';
  const options = roleless
    ? (all ?? [])
    : (all ?? []).filter((o) => o.roleKey === roleKey);
  const query = normalizeMaterialCharacteristicOptionValue(draft);
  const visible = query
    ? options.filter((o) =>
        normalizeMaterialCharacteristicOptionValue(o.value).includes(query),
      )
    : options;
  // Пополнять справочник без роли нельзя (значение некуда положить), но своё
  // значение ввести можно — оно уедет в строку как есть.
  const canAdd =
    query.length > 0 &&
    !roleless &&
    !options.some(
      (o) => normalizeMaterialCharacteristicOptionValue(o.value) === query,
    );

  function commit(next: string): void {
    setDraft(next);
    onChange?.(next);
    onCommit?.(next);
    setOpen(false);
  }

  async function add(): Promise<void> {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const res = await addCharacteristicOptionAction({ roleKey, value: trimmed });
    setBusy(false);
    if (!res.ok || !res.option) {
      onError?.(res.error ?? 'Не удалось добавить значение в список');
      return;
    }
    onError?.(null);
    const option = res.option;
    // Бэкенд идемпотентен: то же значение могло уже быть в списке (в том
    // числе встроенным). Дубль в UI не заводим.
    const current = all ?? [];
    const exists = current.some(
      (o) =>
        o.roleKey === option.roleKey &&
        normalizeMaterialCharacteristicOptionValue(o.value) ===
          normalizeMaterialCharacteristicOptionValue(option.value),
    );
    publish(exists ? current : [...current, option]);
    commit(option.value);
  }

  async function remove(option: MaterialCharacteristicOptionDto): Promise<void> {
    if (!option.id || busy) return;
    setBusy(true);
    const res = await removeCharacteristicOptionAction(option.id);
    setBusy(false);
    if (!res.ok) {
      onError?.(res.error ?? 'Не удалось убрать значение из списка');
      return;
    }
    onError?.(null);
    publish((all ?? []).filter((o) => o.id !== option.id));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      ensureLoaded();
      setActive((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      // Enter внутри строки материала не должен сабмитить всю форму
      // техкарты — здесь он про выбор значения.
      e.preventDefault();
      if (open && visible.length > 0) commit(visible[active]?.value ?? draft);
      else if (canAdd) void add();
      else commit(draft);
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div className="mcbx" ref={boxRef}>
      <input
        id={inputId}
        name={name}
        className="mcbx__input"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        value={draft}
        disabled={disabled}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder ?? 'выберите или введите'}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange?.(e.target.value);
          setActive(0);
          setOpen(true);
          ensureLoaded();
        }}
        onFocus={() => {
          setOpen(true);
          ensureLoaded();
        }}
        onClick={() => {
          setOpen(true);
          ensureLoaded();
        }}
        onBlur={() => {
          // Текст, набранный руками и не подтверждённый «+ Добавить», —
          // обычное значение строки: фиксируем его как есть.
          if (draft !== value) onCommit?.(draft);
        }}
        onKeyDown={onKeyDown}
      />
      <span className="mcbx__caret" aria-hidden>
        ⌄
      </span>
      {open && (
        // mousedown гасим, чтобы blur инпута не закрыл список раньше,
        // чем сработает click по пункту.
        <div className="mcbx__pop" onMouseDown={(e) => e.preventDefault()}>
          {all === null ? (
            <div className="mcbx__empty">Загружаем список…</div>
          ) : (
            <>
              {visible.length > 0 && (
                <div className="mcbx__grp">Характеристики роли</div>
              )}
              {visible.map((o, i) => (
                <div
                  key={o.id ?? `builtin:${o.value}`}
                  className={`mcbx__opt${i === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o.value)}
                >
                  <span className="mcbx__opt-text">{o.value}</span>
                  {!o.isBuiltin && (
                    <>
                      <span className="mcbx__own">своё</span>
                      <button
                        type="button"
                        className="mcbx__del"
                        title="Убрать из списка"
                        aria-label={`Убрать «${o.value}» из списка`}
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(o);
                        }}
                      >
                        <X size={12} strokeWidth={2} aria-hidden />
                      </button>
                    </>
                  )}
                </div>
              ))}
              {visible.length === 0 && !canAdd && (
                <div className="mcbx__empty">
                  {roleKey ? 'Список пуст' : 'Ничего не нашлось — введите своё значение'}
                </div>
              )}
              {canAdd && (
                <button
                  type="button"
                  className="mcbx__add"
                  disabled={busy}
                  onClick={() => void add()}
                >
                  <span className="mcbx__plus" aria-hidden>
                    <Plus size={12} strokeWidth={2.4} />
                  </span>
                  Добавить «{draft.trim()}» в список
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
