'use client';

/**
 * `OrderApplicationsEditor` — общий клиентский редактор списка нанесений
 * (`OrderApplication`) на заказе покупателя.
 *
 * Используется:
 *   - на `/admin/orders/new` (внутри create-form): пользователь
 *     добавляет/редактирует/удаляет строки нанесения; при submit
 *     родительская форма читает hidden input `applicationsJson` и
 *     передаёт массив в `CreateOrderDto.applications`.
 *   - в карточке `/admin/orders/[id]` (DRAFT) — обёртка
 *     `OrderApplicationsForm` оборачивает этот editor в свой `<form>`
 *     с server action `saveOrderApplicationsAction` (full-replace
 *     через PUT /api/orders/:id/applications).
 *
 * Контракт hidden input:
 *   - `name="applicationsJson"`;
 *   - значение — `JSON.stringify(rows.map(rowToInput))`, где
 *     `rowToInput` — pure-функция, конвертирующая локальный
 *     контролируемый row в `OrderApplicationInput`-совместимый
 *     объект (числа из строк, пустые строки в null).
 *
 * Комплекты (этап «Комплекты нанесений»):
 *   - нанесения можно объединять в «комплект на изделие» (перёд +
 *     спина + рукав на одной модели). У комплекта одна общая
 *     «Применить к» (весь тираж / выбранные размеры) — её правка
 *     синхронизируется на все нанесения комплекта. Группировка
 *     хранится на каждом нанесении (`groupKey`/`groupLabel`),
 *     адресация (`quantity`/`sizes`) — тоже на каждом, поэтому
 *     потребность цеха даёт отдельную строку на каждый принт.
 *   - одиночные нанесения (вне комплекта) живут как раньше, со своей
 *     персональной «Применить к».
 *
 * Сворачивание (этап «Нанесение не простынёй»):
 *   - каждое нанесение и каждый комплект сворачиваются в строку-шапку
 *     «тип · место · размер · применить к»; поля прячутся. Иначе на
 *     карточке заказа три-четыре нанесения занимали весь экран.
 *   - существующие строки (из DTO) открываются свёрнутыми, только что
 *     добавленные — развёрнутыми (их пришли заполнять).
 *   - свёрнутые поля не размонтируют данные: источник правды — `rows`
 *     в state, hidden input сериализует его целиком независимо от того,
 *     что показано на экране.
 *
 * Источник правды для словарей типа/stage/статуса —
 * `@sewing/shared/order-applications`, чтобы UI-форма и backend
 * Zod-схема не разъезжались.
 */

import { ChevronDown, Copy, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ORDER_APPLICATION_STAGES,
  ORDER_APPLICATION_STAGE_LABELS,
  ORDER_APPLICATION_STATUSES,
  ORDER_APPLICATION_STATUS_LABELS,
  ORDER_APPLICATION_TYPES,
  ORDER_APPLICATION_TYPE_LABELS,
  type OrderApplicationDto,
  type OrderApplicationStage,
  type OrderApplicationStatus,
  type OrderApplicationType,
} from '@sewing/shared/order-applications';

/**
 * Адресация нанесения на один размер в UI-форме. `quantity` — строка
 * (пусто = «весь размер»).
 */
export interface ApplicationSizeRow {
  sizeId: string;
  quantity: string;
}

/**
 * Область применения нанесения:
 *   - `ORDER` — на весь тираж (опционально N штук через `quantity`);
 *   - `SIZES` — только на выбранные размеры (`sizes`), с поразмерным
 *     количеством.
 */
export type ApplicationScope = 'ORDER' | 'SIZES';

export interface ApplicationRow {
  /** Локальный ключ React (id из DTO для существующих, random для новых). */
  key: string;
  type: OrderApplicationType;
  stage: OrderApplicationStage;
  placement: string;
  widthMm: string;
  heightMm: string;
  colorsCount: string;
  /** Область применения (весь тираж / выбранные размеры). */
  scope: ApplicationScope;
  /** Количество для scope=ORDER (пусто = весь тираж). */
  quantity: string;
  /** Адресация по размерам для scope=SIZES. */
  sizes: ApplicationSizeRow[];
  unit: string;
  colorText: string;
  description: string;
  comment: string;
  fileUrl: string;
  status: OrderApplicationStatus;
  /**
   * Комплект (этап «Комплекты нанесений»): `groupKey` — стабильный id
   * комплекта (null = одиночное нанесение), `groupLabel` — его
   * название. Нанесения одного комплекта имеют одинаковые
   * `scope`/`quantity`/`sizes` (синхронизируются UI).
   */
  groupKey: string | null;
  groupLabel: string;
}

function genGroupKey(): string {
  return `kit-${Math.random().toString(36).slice(2)}`;
}

export function blankApplicationRow(): ApplicationRow {
  return {
    key: `new-${Math.random().toString(36).slice(2)}`,
    type: 'SCREEN_PRINT',
    stage: 'CUT_PARTS',
    placement: '',
    widthMm: '',
    heightMm: '',
    colorsCount: '',
    scope: 'ORDER',
    quantity: '',
    sizes: [],
    unit: 'шт',
    colorText: '',
    description: '',
    comment: '',
    fileUrl: '',
    status: 'PLANNED',
    groupKey: null,
    groupLabel: '',
  };
}

export function applicationRowFromDto(
  app: OrderApplicationDto,
): ApplicationRow {
  return {
    key: app.id,
    type: app.type,
    stage: app.stage,
    placement: app.placement ?? '',
    widthMm: app.widthMm == null ? '' : String(app.widthMm),
    heightMm: app.heightMm == null ? '' : String(app.heightMm),
    colorsCount: app.colorsCount == null ? '' : String(app.colorsCount),
    // Если у нанесения есть адресация по размерам — открываем редактор
    // в режиме SIZES; иначе «весь тираж».
    scope: app.sizes.length > 0 ? 'SIZES' : 'ORDER',
    quantity: app.quantity ?? '',
    sizes: app.sizes.map((s) => ({
      sizeId: s.sizeId,
      quantity: s.quantity ?? '',
    })),
    unit: app.unit ?? 'шт',
    colorText: app.colorText ?? '',
    description: app.description ?? '',
    comment: app.comment ?? '',
    fileUrl: app.fileUrl ?? '',
    status: app.status,
    groupKey: app.groupKey ?? null,
    groupLabel: app.groupLabel ?? '',
  };
}

/**
 * Преобразует UI-строку в payload, совместимый с
 * `OrderApplicationInputSchema`. Числовые поля переводятся в number/null,
 * пустые строки — в null. Делаем здесь, а не в server action, чтобы
 * Zod на сервере получил уже нормализованный объект и парсинг был
 * максимально предсказуем.
 */
function rowToInput(row: ApplicationRow): Record<string, unknown> {
  const trim = (v: string): string | null => {
    const s = v.trim();
    return s === '' ? null : s;
  };
  const parseInt = (v: string): number | null => {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const parseDecimalString = (v: string): string | null => {
    const s = v.trim().replace(',', '.');
    if (s === '') return null;
    return s;
  };
  // Адресация по размерам (этап «Нанесение по размерам»):
  //   - scope=SIZES → шлём только выбранные размеры (с поразмерным
  //     количеством), order-level `quantity` обнуляем;
  //   - scope=ORDER → размеров нет, шлём order-level `quantity`.
  const isSizes = row.scope === 'SIZES';
  const sizes = isSizes
    ? row.sizes
        .filter((s) => s.sizeId.trim() !== '')
        .map((s) => ({
          sizeId: s.sizeId,
          quantity: parseDecimalString(s.quantity),
        }))
    : [];
  return {
    type: row.type,
    stage: row.stage,
    placement: trim(row.placement),
    widthMm: parseInt(row.widthMm),
    heightMm: parseInt(row.heightMm),
    colorsCount: parseInt(row.colorsCount),
    quantity: isSizes ? null : parseDecimalString(row.quantity),
    sizes,
    unit: trim(row.unit) ?? undefined,
    colorText: trim(row.colorText),
    description: trim(row.description),
    comment: trim(row.comment),
    fileUrl: trim(row.fileUrl),
    status: row.status,
    // Комплект: groupLabel имеет смысл только при наличии groupKey.
    groupKey: row.groupKey,
    groupLabel: row.groupKey ? trim(row.groupLabel) : null,
  };
}

interface SizeOption {
  id: string;
  code: string;
}

interface Props {
  /**
   * Стартовое содержимое редактора. Управляющий компонент / карточка
   * заказа передаёт сюда либо `[]` (форма создания заказа), либо
   * `applications.map(applicationRowFromDto)` (DRAFT-карточка).
   */
  initial?: ApplicationRow[];
  /**
   * Имя hidden-input, через который родительская форма читает
   * сериализованные строки. По умолчанию `applicationsJson` —
   * это контракт `buildCreateDto` (`apps/web/app/orders/actions.ts`)
   * и `saveOrderApplicationsAction`
   * (`apps/web/app/admin/orders/[id]/applications-actions.ts`).
   */
  inputName?: string;
  /**
   * Если форма уже сабмитится / валится — блокируем кнопки
   * «Добавить» / «Удалить», чтобы пользователь не вмешивался в
   * процесс сохранения.
   */
  disabled?: boolean;
  /**
   * Размеры заказа для адресации нанесения «на выбранные размеры»
   * (этап «Нанесение по размерам»). В форме создания заказа — размеры
   * выбранного лекала; в DRAFT-карточке — фактические размеры заказа.
   * Если список пуст — режим «выбранные размеры» недоступен.
   */
  availableSizes?: SizeOption[];
}

export function OrderApplicationsEditor({
  initial = [],
  inputName = 'applicationsJson',
  disabled = false,
  availableSizes = [],
}: Props) {
  const [rows, setRows] = useState<ApplicationRow[]>(() => [...initial]);
  /**
   * Развёрнутые блоки: ключ строки (`row.key`) для одиночного нанесения
   * и участника комплекта, `groupKey` — для комплекта целиком. Пусто на
   * старте: пришедшие из DTO нанесения показываем свёрнутыми, а всё,
   * что добавили здесь и сейчас, раскрываем явно (см. `addSolo` и др.).
   */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const serialized = useMemo(
    () => JSON.stringify(rows.map(rowToInput)),
    [rows],
  );

  /** Все ключи сворачивания — для «Развернуть всё / Свернуть всё». */
  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    rows.forEach((r) => {
      keys.add(r.key);
      if (r.groupKey) keys.add(r.groupKey);
    });
    return [...keys];
  }, [rows]);
  const anyOpen = allKeys.some((k) => expanded.has(k));

  function isOpen(key: string): boolean {
    return expanded.has(key);
  }
  function toggleOpen(key: string): void {
    setExpanded((curr) => {
      const next = new Set(curr);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function openKeys(...keys: string[]): void {
    setExpanded((curr) => {
      const next = new Set(curr);
      keys.forEach((k) => next.add(k));
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Группировка строк в блоки для рендера: комплект (kit) или одиночное
  // нанесение (solo). Порядок — по первому появлению groupKey.
  // -------------------------------------------------------------------------
  const blocks = useMemo(() => {
    type Block =
      | { kind: 'kit'; key: string; idxs: number[] }
      | { kind: 'solo'; idx: number };
    const out: Block[] = [];
    const kitByKey = new Map<string, { kind: 'kit'; key: string; idxs: number[] }>();
    rows.forEach((r, i) => {
      if (r.groupKey) {
        let b = kitByKey.get(r.groupKey);
        if (!b) {
          b = { kind: 'kit', key: r.groupKey, idxs: [] };
          kitByKey.set(r.groupKey, b);
          out.push(b);
        }
        b.idxs.push(i);
      } else {
        out.push({ kind: 'solo', idx: i });
      }
    });
    return out;
  }, [rows]);

  // -------------------------------------------------------------------------
  // Мутаторы строк
  // -------------------------------------------------------------------------
  function updateRow(idx: number, patch: Partial<ApplicationRow>): void {
    setRows((curr) => curr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function removeRow(idx: number): void {
    setRows((curr) => curr.filter((_, i) => i !== idx));
  }
  /** Включить/выключить размер у одного нанесения (одиночное). */
  function toggleSize(idx: number, sizeId: string, on: boolean): void {
    setRows((curr) =>
      curr.map((r, i) => (i === idx ? withSizeToggled(r, sizeId, on) : r)),
    );
  }
  function setSizeQty(idx: number, sizeId: string, quantity: string): void {
    setRows((curr) =>
      curr.map((r, i) => (i === idx ? withSizeQty(r, sizeId, quantity) : r)),
    );
  }
  function addSolo(): void {
    // Строку создаём вне updater-а: её ключ нужен, чтобы сразу раскрыть
    // новое нанесение (в updater-е React мог бы вызвать фабрику дважды).
    const row = blankApplicationRow();
    setRows((curr) => [...curr, row]);
    openKeys(row.key);
  }

  // -------------------------------------------------------------------------
  // Мутаторы комплектов (применяются ко ВСЕМ нанесениям группы)
  // -------------------------------------------------------------------------
  function mapGroup(
    key: string,
    fn: (r: ApplicationRow) => ApplicationRow,
  ): void {
    setRows((curr) => curr.map((r) => (r.groupKey === key ? fn(r) : r)));
  }
  function setKitScope(key: string, scope: ApplicationScope): void {
    mapGroup(key, (r) => ({ ...r, scope }));
  }
  function setKitQuantity(key: string, quantity: string): void {
    mapGroup(key, (r) => ({ ...r, quantity }));
  }
  function setKitLabel(key: string, label: string): void {
    mapGroup(key, (r) => ({ ...r, groupLabel: label }));
  }
  function kitToggleSize(key: string, sizeId: string, on: boolean): void {
    mapGroup(key, (r) => withSizeToggled(r, sizeId, on));
  }
  function kitSetSizeQty(key: string, sizeId: string, quantity: string): void {
    mapGroup(key, (r) => withSizeQty(r, sizeId, quantity));
  }
  /** Добавить нанесение в комплект — наследует область применения. */
  function addToKit(key: string): void {
    const base = blankApplicationRow();
    setRows((curr) => {
      const first = curr.find((r) => r.groupKey === key);
      const next: ApplicationRow = first
        ? {
            ...base,
            groupKey: key,
            groupLabel: first.groupLabel,
            scope: first.scope,
            quantity: first.quantity,
            sizes: first.sizes.map((s) => ({ ...s })),
          }
        : { ...base, groupKey: key };
      const lastIdx = lastIndexOfGroup(curr, key);
      if (lastIdx < 0) return [...curr, next];
      const copy = [...curr];
      copy.splice(lastIdx + 1, 0, next);
      return copy;
    });
    openKeys(key, base.key);
  }
  /** Дублировать весь комплект (новый groupKey, копии всех нанесений). */
  function duplicateKit(key: string): void {
    const newKey = genGroupKey();
    setRows((curr) => {
      const members = curr.filter((r) => r.groupKey === key);
      if (members.length === 0) return curr;
      const label = `${members[0].groupLabel || 'Комплект'} (копия)`;
      const copies = members.map((m) => ({
        ...m,
        key: `new-${Math.random().toString(36).slice(2)}`,
        groupKey: newKey,
        groupLabel: label,
        sizes: m.sizes.map((s) => ({ ...s })),
      }));
      const lastIdx = lastIndexOfGroup(curr, key);
      const at = (lastIdx < 0 ? curr.length - 1 : lastIdx) + 1;
      const copy = [...curr];
      copy.splice(at, 0, ...copies);
      return copy;
    });
    // Копию раскрываем на уровне комплекта: её нанесения — копии уже
    // заполненных, их шапок достаточно.
    openKeys(newKey);
  }
  function removeKit(key: string): void {
    setRows((curr) => curr.filter((r) => r.groupKey !== key));
  }
  function addKit(): void {
    const newKey = genGroupKey();
    const base = blankApplicationRow();
    setRows((curr) => {
      const kitCount = new Set(
        curr.filter((r) => r.groupKey).map((r) => r.groupKey),
      ).size;
      return [
        ...curr,
        {
          ...base,
          groupKey: newKey,
          groupLabel: `Комплект ${kitCount + 1}`,
        },
      ];
    });
    openKeys(newKey, base.key);
  }

  return (
    <div
      className="admin-order-applications-editor"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <input type="hidden" name={inputName} value={serialized} />

      {rows.length === 0 && (
        <div
          className="admin-muted"
          style={{ fontSize: '0.85rem', padding: '4px 0' }}
        >
          Нанесение не добавлено.
        </div>
      )}

      {blocks.map((block) => {
        if (block.kind === 'solo') {
          const idx = block.idx;
          const row = rows[idx];
          const open = isOpen(row.key);
          return (
            <div
              key={row.key}
              className="admin-order-applications__row"
              data-open={open || undefined}
            >
              {renderRowHead(row, idx, false, open, true)}
              {open && (
                <>
                  {renderRowSelects(row, idx)}
                  <ScopeControls
                    radioName={`app-scope-${row.key}`}
                    scope={row.scope}
                    quantity={row.quantity}
                    sizes={row.sizes}
                    availableSizes={availableSizes}
                    onScope={(s) => updateRow(idx, { scope: s })}
                    onQuantity={(v) => updateRow(idx, { quantity: v })}
                    onToggleSize={(sizeId, on) => toggleSize(idx, sizeId, on)}
                    onSizeQty={(sizeId, v) => setSizeQty(idx, sizeId, v)}
                  />
                  {renderRowGrid(row, idx)}
                </>
              )}
            </div>
          );
        }

        // kit
        const first = rows[block.idxs[0]];
        const kitOpen = isOpen(block.key);
        return (
          <div
            key={block.key}
            className="admin-order-applications__kit"
            data-open={kitOpen || undefined}
          >
            <div className="admin-order-applications__kit-head">
              <button
                type="button"
                className="admin-order-applications__chev-btn"
                aria-expanded={kitOpen}
                onClick={() => toggleOpen(block.key)}
                title={kitOpen ? 'Свернуть комплект' : 'Развернуть комплект'}
              >
                <ChevronDown
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                  className="admin-order-applications__chev"
                />
              </button>
              <input
                type="text"
                className="admin-order-applications__kit-name"
                value={first.groupLabel}
                onChange={(e) => setKitLabel(block.key, e.target.value)}
                placeholder="Название комплекта (например: Перёд + спина)"
              />
              {!kitOpen && (
                <span className="admin-order-applications__row-sub">
                  Нанесений: {block.idxs.length} ·{' '}
                  {describeRowScope(first, availableSizes)}
                </span>
              )}
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={() => removeKit(block.key)}
                disabled={disabled}
                title="Удалить комплект целиком"
              >
                <Trash2 size={14} strokeWidth={1.6} aria-hidden /> Удалить
                комплект
              </button>
            </div>

            {kitOpen && (
              <>
                <ScopeControls
                  radioName={`kit-scope-${block.key}`}
                  scope={first.scope}
                  quantity={first.quantity}
                  sizes={first.sizes}
                  availableSizes={availableSizes}
                  onScope={(s) => setKitScope(block.key, s)}
                  onQuantity={(v) => setKitQuantity(block.key, v)}
                  onToggleSize={(sizeId, on) =>
                    kitToggleSize(block.key, sizeId, on)
                  }
                  onSizeQty={(sizeId, v) => kitSetSizeQty(block.key, sizeId, v)}
                />

                <div className="admin-order-applications__kit-members">
                  {block.idxs.map((idx) => {
                    const row = rows[idx];
                    const open = isOpen(row.key);
                    return (
                      <div
                        key={row.key}
                        className="admin-order-applications__kit-member"
                        data-open={open || undefined}
                      >
                        {renderRowHead(row, idx, true, open, false)}
                        {open && (
                          <>
                            {renderRowSelects(row, idx)}
                            {renderRowGrid(row, idx)}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="admin-order-applications__kit-actions">
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost"
                    onClick={() => addToKit(block.key)}
                    disabled={disabled}
                  >
                    <Plus size={14} strokeWidth={1.6} aria-hidden /> Нанесение в
                    комплект
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost"
                    onClick={() => duplicateKit(block.key)}
                    disabled={disabled}
                  >
                    <Copy size={14} strokeWidth={1.6} aria-hidden /> Дублировать
                    комплект
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}

      <div
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={addSolo}
          disabled={disabled}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden /> Добавить нанесение
        </button>
        <button
          type="button"
          className="admin-btn admin-btn--ghost"
          onClick={addKit}
          disabled={disabled}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden /> Новый комплект
        </button>
        {allKeys.length > 1 && (
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() =>
              setExpanded(anyOpen ? new Set() : new Set(allKeys))
            }
          >
            <ChevronDown
              size={14}
              strokeWidth={1.6}
              aria-hidden
              className="admin-order-applications__chev"
              style={{ transform: anyOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />{' '}
            {anyOpen ? 'Свернуть всё' : 'Развернуть всё'}
          </button>
        )}
      </div>
    </div>
  );

  // -------------------------------------------------------------------------
  // Шапка одного нанесения: шеврон + сводка (видна всегда) + удалить.
  // Свёрнутая шапка — единственное, что остаётся от нанесения на экране,
  // поэтому в ней тип и краткое описание строки.
  // -------------------------------------------------------------------------
  function renderRowHead(
    row: ApplicationRow,
    idx: number,
    inKit: boolean,
    open: boolean,
    withScope: boolean,
  ): JSX.Element {
    return (
      <div className="admin-order-applications__row-head">
        <button
          type="button"
          className="admin-order-applications__toggle"
          aria-expanded={open}
          onClick={() => toggleOpen(row.key)}
          title={open ? 'Свернуть нанесение' : 'Развернуть нанесение'}
        >
          <ChevronDown
            size={16}
            strokeWidth={2}
            aria-hidden
            className="admin-order-applications__chev"
          />
          <span className="admin-order-applications__row-title">
            {ORDER_APPLICATION_TYPE_LABELS[row.type]}
          </span>
          <span className="admin-order-applications__row-sub">
            {summarizeRow(row, availableSizes, withScope)}
          </span>
        </button>
        <div className="admin-order-applications__row-actions">
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={() => removeRow(idx)}
            title={
              inKit ? 'Убрать нанесение из комплекта' : 'Удалить нанесение'
            }
            disabled={disabled}
          >
            <Trash2 size={14} strokeWidth={1.6} aria-hidden />{' '}
            {inKit ? 'Убрать' : 'Удалить'}
          </button>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Рендер полей одного нанесения (без блока «Применить к»).
  // -------------------------------------------------------------------------
  function renderRowSelects(row: ApplicationRow, idx: number): JSX.Element {
    return (
      <div className="admin-order-applications__grid">
        <label className={FIELD_W2}>
          <span>Тип</span>
          <select
            value={row.type}
            onChange={(e) =>
              updateRow(idx, { type: e.target.value as OrderApplicationType })
            }
          >
            {ORDER_APPLICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ORDER_APPLICATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <label className={FIELD_W2}>
          <span>Когда выполняется</span>
          <select
            value={row.stage}
            onChange={(e) =>
              updateRow(idx, { stage: e.target.value as OrderApplicationStage })
            }
          >
            {ORDER_APPLICATION_STAGES.map((s) => (
              <option key={s} value={s}>
                {ORDER_APPLICATION_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className={FIELD_W2}>
          <span>Статус</span>
          <select
            value={row.status}
            onChange={(e) =>
              updateRow(idx, {
                status: e.target.value as OrderApplicationStatus,
              })
            }
          >
            {ORDER_APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_APPLICATION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  function renderRowGrid(row: ApplicationRow, idx: number): JSX.Element {
    return (
      <div className="admin-order-applications__grid">
        <label className={FIELD_W2}>
          <span>Место</span>
          <input
            type="text"
            value={row.placement}
            onChange={(e) => updateRow(idx, { placement: e.target.value })}
            placeholder="Например: грудь"
          />
        </label>
        <label className={FIELD}>
          <span>Ширина, мм</span>
          <input
            type="number"
            min={1}
            step={1}
            value={row.widthMm}
            onChange={(e) => updateRow(idx, { widthMm: e.target.value })}
          />
        </label>
        <label className={FIELD}>
          <span>Высота, мм</span>
          <input
            type="number"
            min={1}
            step={1}
            value={row.heightMm}
            onChange={(e) => updateRow(idx, { heightMm: e.target.value })}
          />
        </label>
        <label className={FIELD}>
          <span>Кол-во цветов</span>
          <input
            type="number"
            min={1}
            step={1}
            value={row.colorsCount}
            onChange={(e) => updateRow(idx, { colorsCount: e.target.value })}
          />
        </label>
        <label className={FIELD}>
          <span>Единица</span>
          <input
            type="text"
            value={row.unit}
            onChange={(e) => updateRow(idx, { unit: e.target.value })}
          />
        </label>
        <label className={FIELD_W2}>
          <span>Цвет / описание</span>
          <input
            type="text"
            value={row.colorText}
            onChange={(e) => updateRow(idx, { colorText: e.target.value })}
            placeholder="белый, PMS 185 C, …"
          />
        </label>
        <label className={FIELD_W4}>
          <span>Описание</span>
          <input
            type="text"
            value={row.description}
            onChange={(e) => updateRow(idx, { description: e.target.value })}
            placeholder="Текст принта / описание макета"
          />
        </label>
        <label className={FIELD_FULL}>
          <span>Комментарий</span>
          <input
            type="text"
            value={row.comment}
            onChange={(e) => updateRow(idx, { comment: e.target.value })}
          />
        </label>
        <label className={FIELD_FULL}>
          <span>Ссылка на файл макета</span>
          <input
            type="url"
            value={row.fileUrl}
            onChange={(e) => updateRow(idx, { fileUrl: e.target.value })}
            placeholder="https://…"
          />
        </label>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// Pure-хелперы строк (вне компонента — не зависят от state).
// ---------------------------------------------------------------------------
function withSizeToggled(
  r: ApplicationRow,
  sizeId: string,
  on: boolean,
): ApplicationRow {
  const has = r.sizes.some((s) => s.sizeId === sizeId);
  const sizes = on
    ? has
      ? r.sizes
      : [...r.sizes, { sizeId, quantity: '' }]
    : r.sizes.filter((s) => s.sizeId !== sizeId);
  return { ...r, sizes };
}

function withSizeQty(
  r: ApplicationRow,
  sizeId: string,
  quantity: string,
): ApplicationRow {
  return {
    ...r,
    sizes: r.sizes.map((s) => (s.sizeId === sizeId ? { ...s, quantity } : s)),
  };
}

/**
 * Область применения строки словами — для свёрнутой шапки. Аналог
 * `describeApplicationScope` из shared, но по UI-строке: у неё нет
 * `sizeCode`, только `sizeId`, поэтому коды берём из списка размеров
 * заказа.
 */
function describeRowScope(
  row: ApplicationRow,
  availableSizes: SizeOption[],
): string {
  if (row.scope === 'SIZES') {
    const codes = row.sizes
      .map((s) => availableSizes.find((a) => a.id === s.sizeId)?.code)
      .filter((c): c is string => Boolean(c));
    return codes.length > 0
      ? `размеры: ${codes.join(', ')}`
      : 'размеры не выбраны';
  }
  const qty = row.quantity.trim();
  return qty ? `${qty} ${row.unit.trim() || 'шт'} из тиража` : 'весь тираж';
}

/**
 * Однострочная сводка нанесения для свёрнутой шапки: место, размер
 * макета, описание и (для одиночных) область применения. У участника
 * комплекта область общая — её показывает шапка комплекта, поэтому
 * `withScope = false`.
 */
function summarizeRow(
  row: ApplicationRow,
  availableSizes: SizeOption[],
  withScope: boolean,
): string {
  const parts: string[] = [];
  if (row.placement.trim()) parts.push(row.placement.trim());
  if (row.widthMm.trim() && row.heightMm.trim()) {
    parts.push(`${row.widthMm.trim()}×${row.heightMm.trim()} мм`);
  }
  if (row.description.trim()) parts.push(row.description.trim());
  if (withScope) parts.push(describeRowScope(row, availableSizes));
  return parts.join(' · ');
}

function lastIndexOfGroup(rows: ApplicationRow[], key: string): number {
  let last = -1;
  rows.forEach((r, i) => {
    if (r.groupKey === key) last = i;
  });
  return last;
}

// ---------------------------------------------------------------------------
// Блок «Применить к» (общий для одиночного нанесения и комплекта).
// ---------------------------------------------------------------------------
interface ScopeControlsProps {
  radioName: string;
  scope: ApplicationScope;
  quantity: string;
  sizes: ApplicationSizeRow[];
  availableSizes: SizeOption[];
  onScope: (scope: ApplicationScope) => void;
  onQuantity: (value: string) => void;
  onToggleSize: (sizeId: string, on: boolean) => void;
  onSizeQty: (sizeId: string, value: string) => void;
}

function ScopeControls({
  radioName,
  scope,
  quantity,
  sizes,
  availableSizes,
  onScope,
  onQuantity,
  onToggleSize,
  onSizeQty,
}: ScopeControlsProps): JSX.Element {
  const hasSizes = availableSizes.length > 0;
  return (
    <div className="admin-order-applications__scope">
      <span className="admin-order-applications__scope-label">Применить к</span>
      <div className="admin-order-applications__scope-modes">
        <label className="admin-order-applications__radio">
          <input
            type="radio"
            name={radioName}
            checked={scope === 'ORDER'}
            onChange={() => onScope('ORDER')}
          />
          <span>Весь тираж</span>
        </label>
        <label
          className="admin-order-applications__radio"
          title={hasSizes ? undefined : 'Сначала выберите лекало и план по размерам'}
          style={hasSizes ? undefined : { opacity: 0.5 }}
        >
          <input
            type="radio"
            name={radioName}
            checked={scope === 'SIZES'}
            disabled={!hasSizes}
            onChange={() => onScope('SIZES')}
          />
          <span>Выбранные размеры</span>
        </label>
      </div>

      {scope === 'ORDER' ? (
        <label className={`${FIELD} admin-order-applications__scope-qty`}>
          <span>Количество из тиража</span>
          <input
            type="number"
            min={0}
            step="any"
            value={quantity}
            onChange={(e) => onQuantity(e.target.value)}
            placeholder="пусто = весь тираж"
          />
        </label>
      ) : hasSizes ? (
        <div className="admin-order-applications__sizes">
          {availableSizes.map((sz) => {
            const sel = sizes.find((s) => s.sizeId === sz.id);
            const checked = sel != null;
            return (
              <div
                key={sz.id}
                className={
                  'admin-order-applications__size-chip' +
                  (checked ? ' admin-order-applications__size-chip--on' : '')
                }
              >
                <label className="admin-order-applications__size-toggle">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onToggleSize(sz.id, e.target.checked)}
                  />
                  <span>{sz.code}</span>
                </label>
                {checked && (
                  <input
                    type="number"
                    min={0}
                    step="any"
                    className="admin-order-applications__size-qty"
                    value={sel?.quantity ?? ''}
                    onChange={(e) => onSizeQty(sz.id, e.target.value)}
                    placeholder="всё"
                    title="Количество на этот размер (пусто = весь размер)"
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="admin-muted" style={{ fontSize: '0.8rem' }}>
          Нет доступных размеров для адресации.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Классы полей строки нанесения. Сетка строки — фиксированные 6 колонок
// (`.admin-order-applications__grid` в `globals.css`), поле объявляет,
// сколько колонок занимает. Раньше это были inline-стили + `auto-fill`,
// из-за чего число колонок зависело от ширины контейнера: поля
// переносились по одному, справа оставалась дыра, а шапка (Тип / Когда /
// Статус) не совпадала по колонкам с полями под ней.
// ---------------------------------------------------------------------------
const FIELD = 'admin-order-applications__field';
const FIELD_W2 = `${FIELD} admin-order-applications__field--w2`;
const FIELD_W4 = `${FIELD} admin-order-applications__field--w4`;
const FIELD_FULL = `${FIELD} admin-order-applications__field--full`;
