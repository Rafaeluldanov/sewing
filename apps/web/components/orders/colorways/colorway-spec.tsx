'use client';

/**
 * Инлайн-спецификация расцветки: материалы техкарты заказа + параметры.
 * Раскрывается прямо В КАРТОЧКЕ блока «Расцветки» (замена модалки
 * `colorway-params-window.tsx`, решение 16.07: «техкарта живёт в заказе»).
 *
 * Правится ЛЮБАЯ строка — и шаблонная, и ручная: название, норма, ед.,
 * цвет, плотность. Любую можно убрать (последнюю шаблонную backend отбивает
 * — пересборка вернула бы её), свою — добавить. Обязательных полей нет.
 *
 * Ячейка под параметром (`boundFields`) напрямую не правится — два писателя
 * в одну ячейку запрещены. Для плотности редактор параметра рендерится
 * ПРЯМО в строке материала (это самый частый случай); прочие параметры —
 * компактным списком ниже.
 *
 * Окно правки шире, чем у расцветок: спецификация правится и после расчёта,
 * и в производстве (`params.editMode === 'AMENDMENT'` — с предупреждением и
 * записью в журнал правок), закрыта только на `DONE`/`CANCELLED`. Право
 * даёт бэкенд, компонент его не переизобретает.
 *
 * Состояние наверху: каждый write возвращает свежий полный DTO, компонент
 * поднимает его в блок через `onData` — все карточки видят одно состояние.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  resolveVariantParamsGroup,
  type OrderTechCardParametersDto,
  type OrderTechCardVariantParamsDto,
} from '@sewing/shared/order-tech-cards';
import type { OrderTechCardParameterDto } from '@sewing/shared/tech-card-parameters';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
} from '@sewing/shared/tech-card-parameters';

import {
  applyTechCardParamToAllAction,
  createTechCardLineAction,
  createTechCardParamAction,
  deleteTechCardLineAction,
  deleteTechCardParamAction,
  reloadTechCardFromTemplateAction,
  saveTechCardAsTemplateAction,
  setTechCardParamValueAction,
  updateTechCardLineAction,
  type TechCardParamsActionResult,
} from '@/app/admin/orders/[id]/tech-card-params-actions';

interface Props {
  orderId: string;
  params: OrderTechCardParametersDto;
  /** Чья карточка (null = order-level группа при 0–1 расцветке). */
  variantId: string | null;
  /** Поднять свежий DTO в блок — единое состояние для всех карточек. */
  onData: (data: OrderTechCardParametersDto) => void;
}

const emptyLine = { name: '', unit: '', qtyPerUnit: '', colorText: '' };

const emptyAdHoc = {
  label: '',
  inputType: 'TEXT' as string,
  options: '',
  unit: '',
  value: '',
  target: '',
};

export function ColorwaySpec({
  orderId,
  params,
  variantId,
  onData,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [newLine, setNewLine] = useState<typeof emptyLine | null>(null);
  const [adHoc, setAdHoc] = useState<typeof emptyAdHoc | null>(null);
  const [saveAs, setSaveAs] = useState<{ code: string; name: string } | null>(
    null,
  );
  const router = useRouter();

  const group: OrderTechCardVariantParamsDto | undefined =
    resolveVariantParamsGroup(params, variantId);
  // Право на правку — целиком с бэкенда (`editMode`), а не от родителя:
  // расцветка замораживается вместе с планом заказа, а спецификация живёт
  // дольше (см. `OrderTechCardEditMode`).
  const ro = !params.editable;
  // За окном планирования правка идёт amendment-путём: снимок материалов и
  // план операций пересобираются, маршрут и паспорта — нет, потребности
  // пересчитываются best-effort, событие уходит в журнал правок.
  const amendment = params.editMode === 'AMENDMENT';

  function apply(r: TechCardParamsActionResult): void {
    if (!r.ok) {
      setError(r.error ?? 'Ошибка');
      return;
    }
    setError(null);
    if (r.data) onData(r.data);
    if (r.savedTemplate) {
      setNotice(
        `Шаблон «${r.savedTemplate.code} — ${r.savedTemplate.name}» создан. ` +
          'Значения остались в заказе.',
      );
      setSaveAs(null);
    }
    // Снимок материалов и потребность пересобраны на бэке — серверные части
    // карточки заказа надо перечитать.
    router.refresh();
  }

  if (!group) {
    return (
      <div className="cws">
        <SpecStyles />
        <p className="cws-muted">
          Спецификация появится после сохранения расцветки.
        </p>
      </div>
    );
  }

  // Ключ ЗАПИСИ — из группы, не из пропа: у единственной расцветки проп —
  // реальный id, а снимок живёт под order-level `null` (см. резолвер).
  const writeVariantId = group.orderVariantId;

  /** Параметр, владеющий плотностью строки, — рендерим прямо в строке. */
  function densityParamFor(lineId: string): OrderTechCardParameterDto | null {
    return (
      group!.parameters.find((p) =>
        p.targets.some(
          (t) => t.requirementId === lineId && t.field === 'char:density',
        ),
      ) ?? null
    );
  }
  // Параметры, у которых ВСЕ цели — плотность строк, показаны инлайн;
  // остальные (другие ячейки / «просто запись») — списком ниже.
  const otherParams = group.parameters.filter(
    (p) =>
      p.targets.length === 0 ||
      p.targets.some((t) => t.field !== 'char:density'),
  );

  function saveLine(
    lineId: string,
    patch: Record<string, string | number | null>,
  ): void {
    startTransition(async () =>
      apply(await updateTechCardLineAction(orderId, lineId, patch)),
    );
  }
  function saveParam(parameterId: string, value: string | null): void {
    startTransition(async () =>
      apply(
        await setTechCardParamValueAction(orderId, parameterId, { value }),
      ),
    );
  }

  /** Редактор значения параметра (ENUM → select, иначе input). */
  function paramEditor(p: OrderTechCardParameterDto, compact = false) {
    if (p.options && p.options.length > 0) {
      return (
        <select
          className={compact ? 'cws-cell cws-cell--sm' : 'cws-cell'}
          disabled={ro || pending}
          value={p.value ?? ''}
          onChange={(e) => saveParam(p.id, e.target.value || null)}
        >
          <option value="">—</option>
          {p.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        key={`${p.id}:${p.value ?? ''}`}
        className={compact ? 'cws-cell cws-cell--sm' : 'cws-cell'}
        type={p.inputType === 'NUMBER' ? 'number' : 'text'}
        disabled={ro || pending}
        defaultValue={p.value ?? ''}
        placeholder="—"
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next === (p.value ?? '')) return;
          saveParam(p.id, next || null);
        }}
      />
    );
  }

  return (
    <div className="cws">
      <SpecStyles />
      {group.techCardName && (
        <p className="cws-muted cws-tpl">
          Из шаблона: <strong>{group.techCardName}</strong> — дальше список
          живёт в заказе, правки шаблона сюда не протекают.
        </p>
      )}
      {amendment && (
        <p className="cws-warn">
          Заказ уже прошёл расчёт. Правка пересчитает потребности цеха и
          плановую себестоимость, но <strong>не отменит</strong> уже
          выданные и закупленные материалы — разница останется видна в
          план-факте. Каждая правка попадёт в журнал правок заказа.
        </p>
      )}
      {ro && (
        <p className="cws-warn">
          Заказ закрыт (завершён или отменён) — спецификация только для
          просмотра.
        </p>
      )}
      {error && <p className="cws-error">{error}</p>}
      {notice && <p className="cws-notice">{notice}</p>}

      <div className="cws-tablewrap">
        <table className="cws-table">
          <thead>
            <tr>
              <th>Материал</th>
              <th className="num">Норма/шт</th>
              <th>Ед.</th>
              <th>Цвет</th>
              <th className="num">Итого</th>
              <th aria-label="Действия"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="cws-muted">
                  Пока пусто: выберите техкарту расцветки — материалы придут из
                  шаблона, — или добавьте материал вручную.
                </td>
              </tr>
            )}
            {group.lines.map((l) => {
              const dParam = l.boundFields.includes('char:density')
                ? densityParamFor(l.id)
                : null;
              const nameBound = l.boundFields.includes('core:name');
              const unitBound = l.boundFields.includes('core:unit');
              const qtyBound = l.boundFields.includes('core:qtyPerUnit');
              const boundTitle =
                'Ячейка привязана к параметру — правьте значение параметра';
              return (
                <tr
                  key={`${l.id}:${l.name}:${l.qtyPerUnit}:${l.unit}:${l.colorText ?? ''}:${l.densityGsm ?? ''}`}
                >
                  <td>
                    <input
                      className="cws-cell cws-cell--name"
                      defaultValue={l.name}
                      disabled={ro || pending || nameBound}
                      title={nameBound ? boundTitle : undefined}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== l.name) saveLine(l.id, { name: next });
                      }}
                    />
                    <span className="cws-flags">
                      {l.isManual && (
                        <span className="cws-pill">добавлена в заказе</span>
                      )}
                      {(dParam || l.densityGsm != null) && (
                        <span className="cws-density">
                          {dParam ? `${dParam.label}:` : 'плотность:'}
                          {dParam ? (
                            <>
                              {paramEditor(dParam, true)}
                              {!ro && params.variants.length > 1 && (
                                <button
                                  type="button"
                                  className="cws-linkbtn"
                                  disabled={pending}
                                  title="Применить это значение ко всем расцветкам (разовое копирование)"
                                  onClick={() =>
                                    startTransition(async () =>
                                      apply(
                                        await applyTechCardParamToAllAction(
                                          orderId,
                                          dParam.id,
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  → все расцветки
                                </button>
                              )}
                            </>
                          ) : (
                            <input
                              className="cws-cell cws-cell--sm"
                              type="number"
                              min={1}
                              defaultValue={l.densityGsm ?? ''}
                              disabled={ro || pending}
                              onBlur={(e) => {
                                const raw = e.target.value.trim();
                                const next = raw === '' ? null : Math.trunc(+raw);
                                if (next === l.densityGsm) return;
                                if (next !== null && (!Number.isFinite(next) || next <= 0)) return;
                                saveLine(l.id, { densityGsm: next });
                              }}
                            />
                          )}
                          {dParam?.unit ? (
                            <span className="cws-muted">{dParam.unit}</span>
                          ) : (
                            !dParam && <span className="cws-muted">г/м²</span>
                          )}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="num">
                    <input
                      className="cws-cell cws-cell--num"
                      inputMode="decimal"
                      defaultValue={l.qtyPerUnit}
                      disabled={ro || pending || qtyBound}
                      title={qtyBound ? boundTitle : undefined}
                      onBlur={(e) => {
                        const next = e.target.value.trim().replace(',', '.');
                        if (next === l.qtyPerUnit) return;
                        if (!Number.isFinite(Number(next)) || Number(next) <= 0) return;
                        saveLine(l.id, { qtyPerUnit: next });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="cws-cell cws-cell--sm"
                      defaultValue={l.unit}
                      disabled={ro || pending || unitBound}
                      title={unitBound ? boundTitle : undefined}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== l.unit) saveLine(l.id, { unit: next });
                      }}
                    />
                  </td>
                  <td>
                    <input
                      className="cws-cell"
                      defaultValue={l.colorText ?? ''}
                      placeholder="—"
                      disabled={ro || pending}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next === (l.colorText ?? '')) return;
                        saveLine(l.id, { colorText: next || null });
                      }}
                    />
                  </td>
                  <td className="num cws-total">
                    {l.totalQty} {l.unit}
                  </td>
                  <td className="num">
                    {!ro && (
                      <button
                        type="button"
                        className="cws-x"
                        aria-label={`Убрать материал «${l.name}»`}
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () =>
                            apply(await deleteTechCardLineAction(orderId, l.id)),
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!ro &&
        (newLine === null ? (
          <button
            type="button"
            className="cws-add"
            onClick={() => setNewLine({ ...emptyLine })}
          >
            + Добавить материал
          </button>
        ) : (
          <div className="cws-form">
            <input
              type="text"
              placeholder="Название (Лента усилительная)"
              value={newLine.name}
              onChange={(e) =>
                setNewLine((s) => (s ? { ...s, name: e.target.value } : s))
              }
            />
            <input
              type="text"
              placeholder="Норма/шт (0.9)"
              value={newLine.qtyPerUnit}
              onChange={(e) =>
                setNewLine((s) => (s ? { ...s, qtyPerUnit: e.target.value } : s))
              }
            />
            <input
              type="text"
              placeholder="Ед. (м)"
              value={newLine.unit}
              onChange={(e) =>
                setNewLine((s) => (s ? { ...s, unit: e.target.value } : s))
              }
            />
            <input
              type="text"
              placeholder="Цвет (необязательно)"
              value={newLine.colorText}
              onChange={(e) =>
                setNewLine((s) => (s ? { ...s, colorText: e.target.value } : s))
              }
            />
            <button
              type="button"
              className="admin-btn admin-btn--primary"
              disabled={
                pending ||
                !newLine.name.trim() ||
                !newLine.unit.trim() ||
                !newLine.qtyPerUnit.trim()
              }
              onClick={() =>
                startTransition(async () => {
                  const r = await createTechCardLineAction(orderId, {
                    orderVariantId: writeVariantId,
                    name: newLine.name.trim(),
                    unit: newLine.unit.trim(),
                    qtyPerUnit: newLine.qtyPerUnit.trim().replace(',', '.'),
                    colorText: newLine.colorText.trim() || null,
                  });
                  if (r.ok) setNewLine(null);
                  apply(r);
                })
              }
            >
              Добавить
            </button>
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              onClick={() => setNewLine(null)}
            >
              Отмена
            </button>
          </div>
        ))}

      {otherParams.length > 0 && (
        <div className="cws-params">
          <div className="cws-grouplabel">Параметры</div>
          <ul>
            {otherParams.map((p) => (
              <li key={p.id}>
                <span className="cws-params__label">
                  {p.label}
                  {p.unit ? <span className="cws-muted">, {p.unit}</span> : null}
                  {p.isAdHoc && <span className="cws-pill">в заказе</span>}
                </span>
                {paramEditor(p, true)}
                <span className="cws-params__meta">
                  {p.targets.length > 0 ? (
                    <span className="cws-muted">
                      → {p.targets
                        .map((t) => `${t.lineName}: ${t.fieldLabel}`)
                        .join(', ')}
                    </span>
                  ) : (
                    <span className="cws-muted">запись в спецификации</span>
                  )}
                  {!ro && params.variants.length > 1 && (
                    <button
                      type="button"
                      className="cws-linkbtn"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () =>
                          apply(
                            await applyTechCardParamToAllAction(orderId, p.id),
                          ),
                        )
                      }
                    >
                      → все расцветки
                    </button>
                  )}
                  {!ro && p.isAdHoc && (
                    <button
                      type="button"
                      className="cws-linkbtn cws-linkbtn--danger"
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () =>
                          apply(await deleteTechCardParamAction(orderId, p.id)),
                        )
                      }
                    >
                      удалить
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!ro && (
        <div className="cws-foot">
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
                    orderVariantId: writeVariantId,
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
                    // Обязательность снята 16.07: свои параметры — просто поля.
                    isRequired: false,
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

          {/* «Обновить из шаблона» — только в окне планирования. Действие
              пересоздаёт строки снимка (новые id), а после расчёта на них
              уже ссылаются строки потребностей (`WorkshopNeed.sourceId`) —
              связь порвалась бы молча. Бэкенд это же окно и держит
              (`ORDER_TECH_CARD_LOCKED`), кнопку просто не показываем. */}
          {!amendment && (
            <button
              type="button"
              className="admin-btn admin-btn--ghost"
              disabled={pending}
              title="Перечитать шаблон: структура строк заказа будет перезаписана"
              onClick={() => {
                const ok = window.confirm(
                  'Перечитать техкарту из шаблона?\n\n' +
                    'Строки из шаблона будут заменены на актуальные, ваши правки ' +
                    'шаблонных строк сбросятся. Материалы, добавленные в заказе, ' +
                    'и значения параметров сохранятся.',
                );
                if (!ok) return;
                startTransition(async () =>
                  apply(await reloadTechCardFromTemplateAction(orderId)),
                );
              }}
            >
              Обновить из шаблона
            </button>
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
            <div className="cws-form cws-form--saveas">
              <p className="cws-muted">
                В справочник уедет <strong>структура</strong> (строки и
                параметры). Значения останутся в заказе.
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
                        orderVariantId: writeVariantId,
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
    </div>
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
    <div className="cws-form">
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
      <input
        type="text"
        placeholder="Значение"
        value={v.value}
        onChange={(e) => setV({ ...v, value: e.target.value })}
      />
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

function SpecStyles() {
  return (
    <style>{`
.cws { display:flex; flex-direction:column; gap:12px; border-top:1px dashed var(--color-border); padding-top:11px; }
.cws * { box-sizing:border-box; }
.cws-muted { font-size:12.5px; color:var(--color-fg-muted); }
.cws-tpl { margin:0; }
.cws-error { margin:0; padding:8px 11px; border-radius:8px; background:var(--color-danger-soft); color:var(--color-danger-fg); font-size:13px; }
.cws-notice { margin:0; padding:8px 11px; border-radius:8px; background:var(--color-bg-tint); color:var(--color-fg-strong); font-size:13px; }
.cws-warn { margin:0; padding:8px 11px; border-radius:8px; border:1px solid var(--color-border);
  background:var(--color-warning-soft,var(--color-bg-muted)); color:var(--color-fg-muted); font-size:12.5px; line-height:1.45; }
.cws-tablewrap { overflow-x:auto; border:1px solid var(--color-border); border-radius:10px; }
.cws-table { width:100%; border-collapse:collapse; font-size:13px; }
.cws-table th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em;
  color:var(--color-fg-muted); font-weight:700; padding:7px 10px; border-bottom:1px solid var(--color-border); background:var(--color-bg-muted); }
.cws-table th.num { text-align:right; }
.cws-table td { padding:7px 10px; border-bottom:1px solid var(--color-border); vertical-align:top; }
.cws-table tr:last-child td { border-bottom:0; }
.cws-table td.num { text-align:right; white-space:nowrap; }
.cws-total { font-variant-numeric:tabular-nums; color:var(--color-fg-strong); font-weight:600; padding-top:12px !important; }
.cws-cell { width:100%; min-width:70px; padding:5px 8px; border:1px solid var(--color-border-strong); border-radius:7px;
  font:inherit; font-size:13px; background:var(--color-bg-card); color:var(--color-fg); }
.cws-cell:focus { outline:none; border-color:var(--color-accent); }
.cws-cell:disabled { opacity:.65; cursor:not-allowed; background:var(--color-bg-muted); }
.cws-cell--name { min-width:170px; font-weight:600; }
.cws-cell--num { min-width:76px; max-width:96px; text-align:right; }
.cws-cell--sm { min-width:64px; max-width:110px; width:auto; padding:3px 6px; font-size:12.5px; }
.cws-flags { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:5px; }
.cws-pill { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
  padding:2px 7px; border-radius:999px; background:var(--color-bg-tint); color:var(--color-fg-strong); }
.cws-density { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--color-fg-muted); }
.cws-x { border:none; background:none; color:var(--color-fg-subtle); cursor:pointer; font-size:17px; line-height:1; padding:4px 6px; border-radius:6px; }
.cws-x:hover:not(:disabled) { color:var(--color-danger); background:var(--color-danger-soft); }
.cws-x:disabled { opacity:.4; cursor:not-allowed; }
.cws-add { align-self:flex-start; border:1px dashed var(--color-border-strong); background:var(--color-bg-card);
  color:var(--color-fg-muted); border-radius:8px; padding:6px 12px; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.cws-add:hover { border-color:var(--color-accent); color:var(--color-fg); }
.cws-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border:1px dashed var(--color-border-strong); border-radius:10px; }
.cws-form input, .cws-form select { padding:6px 9px; border:1px solid var(--color-border-strong); border-radius:7px; font:inherit; font-size:13px;
  background:var(--color-bg-card); color:var(--color-fg); }
.cws-form input:focus, .cws-form select:focus { outline:none; border-color:var(--color-accent); }
.cws-form--saveas p { width:100%; margin:0; }
.cws-params ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.cws-params li { display:flex; align-items:center; flex-wrap:wrap; gap:9px; font-size:13px; }
.cws-params__label { font-weight:600; }
.cws-params__meta { display:inline-flex; align-items:center; gap:9px; }
.cws-grouplabel { font-size:10.5px; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:var(--color-fg-muted); margin-bottom:7px; }
.cws-linkbtn { border:none; background:none; padding:0; cursor:pointer; font-size:12px; font-weight:600; color:var(--color-accent-fg); }
.cws-linkbtn:hover { text-decoration:underline; }
.cws-linkbtn--danger { color:var(--color-danger); }
.cws-foot { display:flex; flex-wrap:wrap; gap:8px; align-items:flex-start; }
`}</style>
  );
}
