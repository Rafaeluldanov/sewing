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
 * Источник правды для словарей типа/stage/статуса —
 * `@sewing/shared/order-applications`, чтобы UI-форма и backend
 * Zod-схема не разъезжались.
 */

import { Plus, Trash2 } from 'lucide-react';
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
 * Локальное представление строки в UI-форме. Все числовые поля —
 * строкой, чтобы корректно работать с `<input value=…>` без
 * NaN-маневров. Конвертация в payload — в `rowToInput` ниже.
 */
export interface ApplicationRow {
  /** Локальный ключ React (id из DTO для существующих, random для новых). */
  key: string;
  type: OrderApplicationType;
  stage: OrderApplicationStage;
  placement: string;
  widthMm: string;
  heightMm: string;
  colorsCount: string;
  quantity: string;
  unit: string;
  colorText: string;
  description: string;
  comment: string;
  fileUrl: string;
  status: OrderApplicationStatus;
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
    quantity: '',
    unit: 'шт',
    colorText: '',
    description: '',
    comment: '',
    fileUrl: '',
    status: 'PLANNED',
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
    quantity: app.quantity ?? '',
    unit: app.unit ?? 'шт',
    colorText: app.colorText ?? '',
    description: app.description ?? '',
    comment: app.comment ?? '',
    fileUrl: app.fileUrl ?? '',
    status: app.status,
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
  return {
    type: row.type,
    stage: row.stage,
    placement: trim(row.placement),
    widthMm: parseInt(row.widthMm),
    heightMm: parseInt(row.heightMm),
    colorsCount: parseInt(row.colorsCount),
    quantity: parseDecimalString(row.quantity),
    unit: trim(row.unit) ?? undefined,
    colorText: trim(row.colorText),
    description: trim(row.description),
    comment: trim(row.comment),
    fileUrl: trim(row.fileUrl),
    status: row.status,
  };
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
   * Поменять имя имеет смысл только для нестандартных вызывающих —
   * в текущей кодовой базе всегда стоит дефолт.
   */
  inputName?: string;
  /**
   * Если форма уже сабмитится / валится — блокируем кнопки
   * «Добавить» / «Удалить», чтобы пользователь не вмешивался в
   * процесс сохранения. Не блокирует поля ввода — это сознательно
   * (Next.js `pending`-state коротковременный).
   */
  disabled?: boolean;
}

export function OrderApplicationsEditor({
  initial = [],
  inputName = 'applicationsJson',
  disabled = false,
}: Props) {
  const [rows, setRows] = useState<ApplicationRow[]>(() => [...initial]);

  const serialized = useMemo(
    () => JSON.stringify(rows.map(rowToInput)),
    [rows],
  );

  function updateRow(idx: number, patch: Partial<ApplicationRow>): void {
    setRows((curr) =>
      curr.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }
  function addRow(): void {
    setRows((curr) => [...curr, blankApplicationRow()]);
  }
  function removeRow(idx: number): void {
    setRows((curr) => curr.filter((_, i) => i !== idx));
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

      {rows.map((row, idx) => (
        <div
          key={row.key}
          className="admin-order-applications__row"
          style={{
            border: '1px solid var(--admin-border, #e5e7eb)',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            <label style={fieldStyle}>
              <span>Тип</span>
              <select
                value={row.type}
                onChange={(e) =>
                  updateRow(idx, {
                    type: e.target.value as OrderApplicationType,
                  })
                }
              >
                {ORDER_APPLICATION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ORDER_APPLICATION_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            <label style={fieldStyle}>
              <span>Когда выполняется</span>
              <select
                value={row.stage}
                onChange={(e) =>
                  updateRow(idx, {
                    stage: e.target.value as OrderApplicationStage,
                  })
                }
              >
                {ORDER_APPLICATION_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {ORDER_APPLICATION_STAGE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            <label style={fieldStyle}>
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

            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => removeRow(idx)}
              title="Удалить нанесение"
              disabled={disabled}
              style={{ marginLeft: 'auto' }}
            >
              <Trash2 size={14} strokeWidth={1.6} aria-hidden /> Удалить
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 8,
            }}
          >
            <label style={fieldStyle}>
              <span>Место</span>
              <input
                type="text"
                value={row.placement}
                onChange={(e) =>
                  updateRow(idx, { placement: e.target.value })
                }
                placeholder="Например: грудь"
              />
            </label>
            <label style={fieldStyle}>
              <span>Ширина, мм</span>
              <input
                type="number"
                min={1}
                step={1}
                value={row.widthMm}
                onChange={(e) =>
                  updateRow(idx, { widthMm: e.target.value })
                }
              />
            </label>
            <label style={fieldStyle}>
              <span>Высота, мм</span>
              <input
                type="number"
                min={1}
                step={1}
                value={row.heightMm}
                onChange={(e) =>
                  updateRow(idx, { heightMm: e.target.value })
                }
              />
            </label>
            <label style={fieldStyle}>
              <span>Кол-во цветов</span>
              <input
                type="number"
                min={1}
                step={1}
                value={row.colorsCount}
                onChange={(e) =>
                  updateRow(idx, { colorsCount: e.target.value })
                }
              />
            </label>
            <label style={fieldStyle}>
              <span>Количество</span>
              <input
                type="number"
                min={0}
                step="any"
                value={row.quantity}
                onChange={(e) =>
                  updateRow(idx, { quantity: e.target.value })
                }
              />
            </label>
            <label style={fieldStyle}>
              <span>Единица</span>
              <input
                type="text"
                value={row.unit}
                onChange={(e) => updateRow(idx, { unit: e.target.value })}
              />
            </label>
            <label style={fieldStyle}>
              <span>Цвет / описание</span>
              <input
                type="text"
                value={row.colorText}
                onChange={(e) =>
                  updateRow(idx, { colorText: e.target.value })
                }
                placeholder="белый, PMS 185 C, …"
              />
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span>Описание</span>
              <input
                type="text"
                value={row.description}
                onChange={(e) =>
                  updateRow(idx, { description: e.target.value })
                }
                placeholder="Текст принта / описание макета"
              />
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span>Комментарий</span>
              <input
                type="text"
                value={row.comment}
                onChange={(e) =>
                  updateRow(idx, { comment: e.target.value })
                }
              />
            </label>
            <label style={{ ...fieldStyle, gridColumn: '1 / -1' }}>
              <span>Ссылка на файл макета</span>
              <input
                type="url"
                value={row.fileUrl}
                onChange={(e) =>
                  updateRow(idx, { fileUrl: e.target.value })
                }
                placeholder="https://…"
              />
            </label>
          </div>
        </div>
      ))}

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
          onClick={addRow}
          disabled={disabled}
        >
          <Plus size={14} strokeWidth={1.6} aria-hidden /> Добавить нанесение
        </button>
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: '0.85rem',
  gap: 2,
};
