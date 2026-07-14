'use client';

/**
 * Окно «Техкарта расцветки»: значения параметров, добавление своего параметра
 * и вынос техкарты в справочник.
 *
 * Значения принадлежат РАСЦВЕТКЕ — наследования с уровня заказа нет. Чтобы не
 * вводить одно и то же несколько раз, у каждого значения есть «применить ко
 * всем расцветкам»: это разовое копирование, а не связь. Разошлись потом —
 * так решил технолог, и это видно.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type {
  OrderTechCardParametersDto,
  OrderTechCardVariantParamsDto,
} from '@sewing/shared/order-tech-cards';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
} from '@sewing/shared/tech-card-parameters';

import {
  applyTechCardParamToAllAction,
  createTechCardParamAction,
  deleteTechCardParamAction,
  saveTechCardAsTemplateAction,
  setTechCardParamValueAction,
  type TechCardParamsActionResult,
} from '@/app/admin/orders/[id]/tech-card-params-actions';

interface Props {
  orderId: string;
  initial: OrderTechCardParametersDto;
  /** Какую расцветку открыли (null = order-level группа). */
  variantId: string | null;
  onClose: () => void;
}

const emptyAdHoc = {
  label: '',
  inputType: 'TEXT' as string,
  options: '',
  unit: '',
  isRequired: false,
  value: '',
  target: '',
};

export function ColorwayParamsWindow({
  orderId,
  initial,
  variantId,
  onClose,
}: Props) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [adHoc, setAdHoc] = useState<typeof emptyAdHoc | null>(null);
  const [saveAs, setSaveAs] = useState<{ code: string; name: string } | null>(
    null,
  );
  const router = useRouter();

  const group: OrderTechCardVariantParamsDto | undefined = data.variants.find(
    (v) => v.orderVariantId === variantId,
  );
  const ro = !data.editable;

  function apply(r: TechCardParamsActionResult): void {
    if (!r.ok) {
      setError(r.error ?? 'Ошибка');
      return;
    }
    setError(null);
    if (r.data) setData(r.data);
    if (r.savedTemplate) {
      setNotice(
        `Шаблон «${r.savedTemplate.code} — ${r.savedTemplate.name}» создан. ` +
          'Значения остались в заказе.',
      );
      setSaveAs(null);
    }
    // Снимок материалов и потребность пересобраны на бэке — карточка заказа
    // рендерится сервером, поэтому её надо перечитать.
    router.refresh();
  }

  if (!group) {
    return (
      <Shell onClose={onClose} title="Техкарта расцветки">
        <p className="admin-muted">
          У этой расцветки нет техкарты — выберите её в блоке «Расцветки».
        </p>
      </Shell>
    );
  }

  const title = `Техкарта расцветки — ${group.color ?? 'заказ'}`;

  return (
    <Shell onClose={onClose} title={title}>
      {group.techCardName && (
        <p className="admin-muted admin-tcp__tpl">
          Шаблон: <strong>{group.techCardName}</strong>
        </p>
      )}
      {error && <p className="admin-error">{error}</p>}
      {notice && <p className="admin-success">{notice}</p>}

      {group.parameters.length === 0 ? (
        <p className="admin-muted">
          В этой техкарте нет параметров: все ячейки заданы жёстко.
        </p>
      ) : (
        <ul className="admin-tcp__list">
          {group.parameters.map((p) => {
            const missing =
              p.isRequired && (p.value == null || p.value.trim() === '');
            return (
              <li
                key={p.id}
                className={`admin-tcp__row${missing ? ' admin-tcp__row--missing' : ''}`}
              >
                <div className="admin-tcp__head">
                  <label htmlFor={`p-${p.id}`}>
                    {p.label}
                    {p.isRequired && <span aria-hidden> *</span>}
                    {p.unit ? <span className="admin-muted">, {p.unit}</span> : null}
                  </label>
                  {p.isAdHoc && (
                    <span className="admin-badge">добавлен в заказе</span>
                  )}
                </div>

                {p.options && p.options.length > 0 ? (
                  <select
                    id={`p-${p.id}`}
                    disabled={ro || pending}
                    value={p.value ?? ''}
                    onChange={(e) =>
                      startTransition(async () =>
                        apply(
                          await setTechCardParamValueAction(orderId, p.id, {
                            value: e.target.value || null,
                          }),
                        ),
                      )
                    }
                  >
                    <option value="">— не заполнено —</option>
                    {p.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`p-${p.id}`}
                    type={p.inputType === 'NUMBER' ? 'number' : 'text'}
                    disabled={ro || pending}
                    defaultValue={p.value ?? ''}
                    placeholder="не заполнено"
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next === (p.value ?? '')) return;
                      startTransition(async () =>
                        apply(
                          await setTechCardParamValueAction(orderId, p.id, {
                            value: next || null,
                          }),
                        ),
                      );
                    }}
                  />
                )}

                <div className="admin-tcp__meta">
                  {p.targets.length > 0 ? (
                    <span className="admin-muted">
                      подставляется в:{' '}
                      {p.targets
                        .map((t) => `${t.lineName} → ${t.fieldLabel}`)
                        .join(', ')}
                    </span>
                  ) : (
                    <span className="admin-muted">
                      только запись в спецификации — на расчёт не влияет
                    </span>
                  )}
                  <span className="admin-tcp__actions">
                    {!ro && data.variants.length > 1 && (
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () =>
                            apply(
                              await applyTechCardParamToAllAction(orderId, p.id),
                            ),
                          )
                        }
                      >
                        Применить ко всем расцветкам
                      </button>
                    )}
                    {!ro && p.isAdHoc && (
                      <button
                        type="button"
                        className="admin-btn admin-btn--ghost admin-btn--danger"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () =>
                            apply(
                              await deleteTechCardParamAction(orderId, p.id),
                            ),
                          )
                        }
                      >
                        Удалить
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!ro && (
        <div className="admin-tcp__foot">
          {adHoc === null ? (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => setAdHoc({ ...emptyAdHoc })}
            >
              + Добавить параметр
            </button>
          ) : (
            <AdHocForm
              value={adHoc}
              targets={group.targets}
              pending={pending}
              onCancel={() => setAdHoc(null)}
              onSubmit={(v) => {
                const [requirementId = '', field = ''] = v.target.split('|');
                startTransition(async () => {
                  const r = await createTechCardParamAction(orderId, {
                    orderVariantId: variantId,
                    // Технический ключ пользователю не показываем.
                    key: `adhoc_${Date.now().toString(36)}`,
                    label: v.label,
                    inputType: v.inputType,
                    options:
                      v.inputType === 'ENUM' && v.options.trim() !== ''
                        ? v.options
                            .split(',')
                            .map((o) => o.trim())
                            .filter(Boolean)
                        : undefined,
                    unit: v.unit || null,
                    isRequired: v.isRequired,
                    value: v.value || null,
                    target:
                      requirementId && field ? { requirementId, field } : null,
                  });
                  if (r.ok) setAdHoc(null);
                  apply(r);
                });
              }}
            />
          )}

          {saveAs === null ? (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => setSaveAs({ code: '', name: '' })}
            >
              Сохранить как новый шаблон
            </button>
          ) : (
            <div className="admin-tcp__saveas">
              <p className="admin-muted">
                В справочник уедет <strong>структура</strong>: строки материалов
                и параметры. Заполненные значения останутся в заказе — иначе
                новый шаблон унёс бы их намертво и стал очередным близнецом.
              </p>
              <input
                type="text"
                placeholder="Код (TK-KULIRKA-OS)"
                value={saveAs.code}
                onChange={(e) =>
                  setSaveAs((s) => (s ? { ...s, code: e.target.value } : s))
                }
              />
              <input
                type="text"
                placeholder="Название"
                value={saveAs.name}
                onChange={(e) =>
                  setSaveAs((s) => (s ? { ...s, name: e.target.value } : s))
                }
              />
              <button
                type="button"
                className="admin-btn admin-btn--primary"
                disabled={pending || !saveAs.code.trim() || !saveAs.name.trim()}
                onClick={() =>
                  startTransition(async () =>
                    apply(
                      await saveTechCardAsTemplateAction(orderId, {
                        orderVariantId: variantId,
                        code: saveAs.code.trim(),
                        name: saveAs.name.trim(),
                      }),
                    ),
                  )
                }
              >
                Сохранить
              </button>
              <button
                type="button"
                className="admin-btn admin-btn--ghost"
                onClick={() => setSaveAs(null)}
              >
                Отмена
              </button>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function AdHocForm({
  value,
  targets,
  pending,
  onCancel,
  onSubmit,
}: {
  value: typeof emptyAdHoc;
  targets: OrderTechCardVariantParamsDto['targets'];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (v: typeof emptyAdHoc) => void;
}) {
  const [v, setV] = useState(value);
  // Ячейки, уже занятые другим параметром, показываем, но не даём выбрать:
  // два писателя в одну ячейку — молчаливый баг.
  const byLine = new Map<string, typeof targets>();
  for (const t of targets) {
    const list = byLine.get(t.lineName) ?? [];
    list.push(t);
    byLine.set(t.lineName, list);
  }

  return (
    <div className="admin-tcp__adhoc">
      <input
        type="text"
        placeholder="Название параметра"
        value={v.label}
        onChange={(e) => setV({ ...v, label: e.target.value })}
      />
      <select
        value={v.inputType}
        onChange={(e) => setV({ ...v, inputType: e.target.value })}
      >
        {TECH_CARD_PARAMETER_INPUT_TYPES.map((t) => (
          <option key={t} value={t}>
            {TECH_CARD_PARAMETER_INPUT_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {v.inputType === 'ENUM' && (
        <input
          type="text"
          placeholder="Значения списка: 160, 190, 220"
          value={v.options}
          onChange={(e) => setV({ ...v, options: e.target.value })}
        />
      )}
      <input
        type="text"
        placeholder="Ед. изм."
        value={v.unit}
        onChange={(e) => setV({ ...v, unit: e.target.value })}
      />

      <label className="admin-field--inline">
        <span>Куда подставляется</span>
        <select
          value={v.target}
          onChange={(e) => setV({ ...v, target: e.target.value })}
        >
          <option value="">— просто зафиксировать в спецификации —</option>
          {Array.from(byLine.entries()).map(([lineName, list]) => (
            <optgroup key={lineName} label={lineName}>
              {list.map((t) => (
                <option
                  key={`${t.requirementId}|${t.field}`}
                  value={`${t.requirementId}|${t.field}`}
                  disabled={Boolean(t.takenByKey)}
                >
                  {t.fieldLabel}
                  {t.unit ? `, ${t.unit}` : ''}
                  {t.takenByKey ? ' — уже занята' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <input
        type="text"
        placeholder="Значение"
        value={v.value}
        onChange={(e) => setV({ ...v, value: e.target.value })}
      />
      <label className="admin-field--inline">
        <input
          type="checkbox"
          checked={v.isRequired}
          onChange={(e) => setV({ ...v, isRequired: e.target.checked })}
        />
        <span>Обязательный</span>
      </label>

      <button
        type="button"
        className="admin-btn admin-btn--primary"
        disabled={pending || v.label.trim() === ''}
        onClick={() => onSubmit(v)}
      >
        Добавить
      </button>
      <button type="button" className="admin-btn admin-btn--ghost" onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="admin-modal-backdrop" role="dialog" aria-modal="true">
      <div className="admin-modal admin-tcp">
        <div className="admin-modal__head">
          <strong>{title}</strong>
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>
        <div className="admin-modal__body">{children}</div>
      </div>
    </div>
  );
}
