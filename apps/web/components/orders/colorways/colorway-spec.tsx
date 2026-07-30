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

import { Fragment, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  resolveVariantParamsGroup,
  type OrderTechCardLineDto,
  type OrderTechCardParametersDto,
  type OrderTechCardVariantParamsDto,
} from '@sewing/shared/order-tech-cards';
import type { OrderTechCardParameterDto } from '@sewing/shared/tech-card-parameters';
import {
  TECH_CARD_PARAMETER_INPUT_TYPES,
  TECH_CARD_PARAMETER_INPUT_TYPE_LABELS,
} from '@sewing/shared/tech-card-parameters';
import {
  getMaterialCharacteristic,
  getMaterialSubtype,
} from '@sewing/shared/material-characteristics';
import {
  characteristicValueFromSubtypeKey,
  resolveSubtypeKeyByCharacteristic,
} from '@sewing/shared/material-characteristic-options';
import { CharacteristicCombobox } from '@/components/materials/characteristic-combobox';

import {
  applyTechCardParamToAllAction,
  createTechCardLineAction,
  createTechCardParamAction,
  deleteTechCardLineAction,
  deleteTechCardParamAction,
  reloadTechCardFromTemplateAction,
  reloadTechCardNormsAction,
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

/**
 * Источник нормы — КОМПАКТНЫЙ индикатор: буква + цвет, расшифровка по
 * наведению. Текстовые бейджи («из номенклатуры» / «из шаблона») занимали
 * половину колонки и перетягивали внимание с самого числа, хотя нужны лишь
 * тогда, когда норма вызывает вопрос.
 */
const QTY_SOURCE_BADGE: Record<string, { letter: string; title: string }> = {
  NOMENCLATURE: {
    letter: 'Н',
    title:
      'Норма из номенклатуры — пересчёт заказа освежает её по размерному плану',
  },
  TEMPLATE: {
    letter: 'Ш',
    title:
      'Норма из шаблона техкарты — в номенклатуре подходящего параметра не нашлось',
  },
  ORDER: {
    letter: 'З',
    title:
      'Норма правлена в заказе — она главнее номенклатуры и переживает пересчёт',
  },
};

/**
 * Характеристики, которые показываем в панели строки.
 *
 * Набор задаёт ПОДТИП (`getMaterialSubtype`) — тот же источник, что в
 * редакторе шаблона, чтобы «параметры» в заказе и в справочнике значили одно
 * и то же. Подтип не выбран (старые строки) — показываем то, что уже
 * заполнено, плюс базовую пару для роли, иначе панель была бы пустой и
 * править было бы нечего.
 */
function characteristicKeysForLine(line: OrderTechCardLineDto): string[] {
  const subtype = line.subtypeKey ? getMaterialSubtype(line.subtypeKey) : null;
  const keys = subtype ? subtype.characteristics.map((c) => c.key) : [];
  if (keys.length === 0) {
    keys.push(
      ...(line.materialRole === 'PACKAGING'
        ? ['size', 'material', 'type', 'length']
        : ['density', 'rollWidth']),
    );
  }
  for (const k of Object.keys(line.characteristics ?? {})) {
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

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
  /** Строка, у которой раскрыта панель параметров (одна за раз). */
  const [openLine, setOpenLine] = useState<string | null>(null);
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
  // Есть ли в группе строка, у которой расход и закупка в разных единицах.
  // От этого зависит, показывать таблицу в один блок или в два.
  const hasSplitLines = (group?.lines ?? []).some(
    (l) => (l.normUnit ?? '').trim() !== '',
  );

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
    patch: Record<
      string,
      string | number | null | Record<string, string | number | null>
    >,
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
            {/* Шапка раздваивается ТОЛЬКО когда в группе есть строка, у которой
                единица нормы отличается от закупочной. Иначе оба блока
                показывали бы одно и то же число, а лишняя пара колонок —
                это шум для всех, у кого расход и закупка в одной единице. */}
            {hasSplitLines && (
              <tr>
                <th colSpan={2}></th>
                <th className="cws-grp cws-grp--norm" colSpan={3}>
                  Расход — единица техкарты
                </th>
                <th></th>
                <th className="cws-grp cws-grp--buy" colSpan={2}>
                  Закупка
                </th>
                <th></th>
              </tr>
            )}
            <tr>
              <th>Материал</th>
              <th>Параметры</th>
              <th className="num">Норма/шт</th>
              <th>Ед.</th>
              <th>Цвет</th>
              <th className="num">{hasSplitLines ? 'Расход' : 'Итого'}</th>
              {hasSplitLines && (
                <>
                  <th aria-label="Пересчёт"></th>
                  <th className="cws-zone--buy">Ед.</th>
                  <th className="num cws-zone--buy">К закупке</th>
                </>
              )}
              <th aria-label="Действия"></th>
            </tr>
          </thead>
          <tbody>
            {group.lines.length === 0 && (
              <tr>
                <td colSpan={hasSplitLines ? 10 : 7} className="cws-muted">
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
              const open = openLine === l.id;
              const chips = characteristicKeysForLine(l)
                .map((key) => ({
                  key,
                  def: getMaterialCharacteristic(key),
                  value: (l.characteristics ?? {})[key],
                }))
                .filter((c) => c.value !== undefined && c.value !== '');
              // Чип-«шапка» строки — значение поля «Характеристика» (то, что
              // заменило подтип). У старых строк своего значения нет —
              // показываем лейбл подтипа, чтобы чип не пропал.
              const characteristicChip =
                (l.fabricType ?? '').trim() ||
                (l.subtypeKey
                  ? (getMaterialSubtype(l.subtypeKey)?.label ?? l.subtypeKey)
                  : null);
              return (
                <Fragment
                  key={`${l.id}:${l.name}:${l.qtyPerUnit}:${l.unit}:${l.colorText ?? ''}:${l.densityGsm ?? ''}:${l.subtypeKey ?? ''}:${JSON.stringify(l.characteristics ?? {})}`}
                >
                <tr>
                  <td>
                    <div className="cws-nameline">
                      <button
                        type="button"
                        className={`cws-caret${open ? ' is-open' : ''}`}
                        aria-expanded={open}
                        aria-label={`Параметры материала «${l.name}»`}
                        onClick={() => setOpenLine(open ? null : l.id)}
                      >
                        {open ? '⌄' : '›'}
                      </button>
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
                    </div>
                    <span className="cws-flags">
                      {l.isManual && (
                        <span className="cws-pill">добавлена в заказе</span>
                      )}
                      {dParam && (
                        <span className="cws-density">
                          {`${dParam.label}:`}
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
                          {dParam.unit && (
                            <span className="cws-muted">{dParam.unit}</span>
                          )}
                        </span>
                      )}
                    </span>
                  </td>
                  {/* Параметры материала: чипами — то, что заполнено. Вход в
                      правку БЕЗУСЛОВНЫЙ (пустая строка показывает «+ параметр»),
                      иначе у строки без характеристик их негде было бы завести. */}
                  <td>
                    <button
                      type="button"
                      className="cws-chips"
                      onClick={() => setOpenLine(open ? null : l.id)}
                      title="Открыть параметры материала"
                    >
                      {characteristicChip && (
                        <span className="cws-chip cws-chip--subtype">
                          {characteristicChip}
                        </span>
                      )}
                      {chips.map((c) => (
                        <span
                          key={c.key}
                          className={`cws-chip${
                            l.boundFields.includes(`char:${c.key}`)
                              ? ' cws-chip--slot'
                              : ''
                          }`}
                        >
                          {c.def?.label ?? c.key} <b>{String(c.value)}</b>
                          {c.def?.unit ? ` ${c.def.unit}` : ''}
                        </span>
                      ))}
                      {chips.length === 0 && !characteristicChip && (
                        <span className="cws-chip cws-chip--empty">
                          + параметр
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="num">
                    <span className="cws-qty">
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
                    {/* Источник нормы: буква + цвет, расшифровка по наведению.
                        Без индикатора не отличить «подтянулось из
                        номенклатуры» от «стоит заглушка шаблона». */}
                    {l.qtySource && QTY_SOURCE_BADGE[l.qtySource] && (
                      <span
                        className={`cws-src cws-src--${l.qtySource.toLowerCase()}`}
                        title={
                          l.qtySourceLabel
                            ? `${QTY_SOURCE_BADGE[l.qtySource]!.title}. Источник: ${l.qtySourceLabel}`
                            : QTY_SOURCE_BADGE[l.qtySource]!.title
                        }
                        aria-label={QTY_SOURCE_BADGE[l.qtySource]!.title}
                      >
                        {QTY_SOURCE_BADGE[l.qtySource]!.letter}
                      </span>
                    )}
                    </span>
                  </td>
                  {/* Единица РАСХОДА. У расщеплённой строки это `normUnit` и
                      правится она отдельно от закупочной; у обычной — прежнее
                      поле `unit`, как и было. */}
                  <td>
                    <input
                      className="cws-cell cws-cell--sm"
                      defaultValue={l.normUnit ?? l.unit}
                      disabled={ro || pending || unitBound}
                      title={
                        unitBound
                          ? boundTitle
                          : l.normUnit
                            ? 'Единица нормы расхода. Закупочная единица — в блоке «Закупка».'
                            : undefined
                      }
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (!next) return;
                        if (l.normUnit) {
                          if (next !== l.normUnit) saveLine(l.id, { normUnit: next });
                        } else if (next !== l.unit) {
                          saveLine(l.id, { unit: next });
                        }
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
                  {/* Расход — в единице НОРМЫ; у нерасщеплённой строки это
                      прежнее «итого» в единице закупки, поле в поле. */}
                  <td className="num cws-total">
                    {l.normUnit ? (l.totalNorm ?? '—') : l.totalQty}{' '}
                    {l.normUnit ?? l.unit}
                  </td>
                  {hasSplitLines && (
                    <>
                      <td className="num cws-arrow">{l.normUnit ? '→' : ''}</td>
                      <td className="cws-zone--buy">
                        {l.normUnit ? l.unit : ''}
                      </td>
                      <td className="num cws-total cws-zone--buy">
                        {!l.normUnit ? (
                          ''
                        ) : l.purchaseProblem ? (
                          /* Прочерк с объяснением, а не тихий ноль: ноль
                             читается как «материал не нужен». */
                          <span className="cws-nocalc" title={l.purchaseProblem}>
                            —
                          </span>
                        ) : (
                          <span title={l.purchaseFormula ?? undefined}>
                            {l.totalQty} {l.unit}
                          </span>
                        )}
                      </td>
                    </>
                  )}
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
                {open && (
                  <tr className="cws-exp">
                    <td colSpan={hasSplitLines ? 10 : 7}>
                      <LineParams
                        line={l}
                        readOnly={ro}
                        pending={pending}
                        onSave={(patch) => saveLine(l.id, patch)}
                      />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {!ro &&
        (newLine === null ? (
          <button
            type="button"
            className="cws-btn cws-btn--dash"
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
              className="cws-btn cws-btn--primary"
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
              className="cws-btn"
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
              className="cws-btn"
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

          {/* «Обновить нормы из номенклатуры» — мягкое действие, доступно в
              любом окне правки: структуру строк не трогает, только числа. */}
          <button
            type="button"
            className="cws-btn"
            disabled={pending}
            title="Перечитать нормы расхода из карточки номенклатуры (правки норм в заказе сбросятся)"
            onClick={() => {
              const ok = window.confirm(
                'Обновить нормы из номенклатуры?\n\n' +
                  'Нормы шаблонных строк будут перечитаны из карточки ' +
                  'номенклатуры. Ваши правки норм в заказе сбросятся. ' +
                  'Структура строк, параметры и характеристики останутся.',
              );
              if (!ok) return;
              startTransition(async () =>
                apply(await reloadTechCardNormsAction(orderId)),
              );
            }}
          >
            Обновить нормы из номенклатуры
          </button>

          {/* «Обновить из шаблона» — только в окне планирования. Действие
              пересоздаёт строки снимка (новые id), а после расчёта на них
              уже ссылаются строки потребностей (`WorkshopNeed.sourceId`) —
              связь порвалась бы молча. Бэкенд это же окно и держит
              (`ORDER_TECH_CARD_LOCKED`), кнопку просто не показываем. */}
          {!amendment && (
            <button
              type="button"
              className="cws-btn"
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
              className="cws-btn"
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
                className="cws-btn cws-btn--primary"
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
                className="cws-btn"
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

/**
 * Панель параметров строки материала: подтип + характеристики + расшифровка
 * нормы, если она пришла из номенклатуры поразмерно.
 *
 * Раньше этих полей в заказе не было вовсе — характеристики правились только в
 * справочнике техкарт, а в заказе строка показывала одну норму. Набор полей
 * берём из подтипа (`MATERIAL_SUBTYPES`), чтобы «параметры» здесь и в шаблоне
 * означали одно и то же.
 *
 * Ячейка под слот-параметром (`boundFields`) — read-only с замком: два
 * писателя в одну ячейку запрещены, backend такую правку отбивает 409.
 */
function LineParams({
  line,
  readOnly,
  pending,
  onSave,
}: {
  line: OrderTechCardLineDto;
  readOnly: boolean;
  pending: boolean;
  onSave: (
    patch: Record<
      string,
      string | number | null | Record<string, string | number | null>
    >,
  ) => void;
}) {
  const keys = characteristicKeysForLine(line);
  const values = line.characteristics ?? {};
  const disabled = readOnly || pending;
  // Поле «Характеристика» вместо убранного «Подтипа» (решение пользователя
  // 29.07.2026): выбор из пополняемого списка либо свой текст. Подтип не
  // выбирается, а выводится из значения — и уходит тем же патчем, потому что
  // он задаёт набор характеристик ниже.
  const role = line.materialRole ?? '';
  // Строки, заполненные до этой правки, держат значение в `subtypeKey` —
  // показываем его лейбл, иначе поле выглядело бы пустым.
  const characteristicValue =
    (line.fabricType ?? '') || characteristicValueFromSubtypeKey(line.subtypeKey);
  const characteristicBound = line.boundFields.includes('core:fabricType');

  return (
    <div className="cws-params-panel">
      <div className="cws-params-panel__head">
        <span className="cws-grouplabel">Параметры материала</span>
        {line.materialRole && (
          <span className="cws-chip">роль: {line.materialRole}</span>
        )}
      </div>

      <div className="cws-fields">
        <label className="cws-field">
          <span>
            Характеристика
            {characteristicBound ? ' 🔒' : ''}
          </span>
          <CharacteristicCombobox
            roleKey={role}
            value={characteristicValue}
            disabled={disabled || characteristicBound}
            placeholder={characteristicBound ? '—' : 'выберите или введите'}
            onCommit={(next) => {
              const trimmed = next.trim();
              if (trimmed === characteristicValue.trim()) return;
              const nextSubtype = resolveSubtypeKeyByCharacteristic(
                role,
                trimmed,
              );
              // Подтип шлём вместе со значением: он задаёт набор
              // характеристик, и бэкенд по нему уносит значения, которых у
              // нового набора нет.
              onSave({
                fabricType: trimmed === '' ? null : trimmed,
                subtypeKey: nextSubtype,
              });
            }}
          />
        </label>

        {keys.map((key) => {
          const def = getMaterialCharacteristic(key);
          const bound = line.boundFields.includes(`char:${key}`);
          const raw = values[key];
          return (
            <label className="cws-field" key={key}>
              <span>
                {def?.label ?? key}
                {def?.unit ? `, ${def.unit}` : ''}
                {bound ? ' 🔒' : ''}
              </span>
              <input
                key={`${key}:${String(raw ?? '')}`}
                className="cws-cell"
                type={def?.valueType === 'number' ? 'number' : 'text'}
                defaultValue={raw != null ? String(raw) : ''}
                placeholder="—"
                disabled={disabled || bound}
                title={
                  bound
                    ? 'Ячейка привязана к параметру техкарты — правьте значение параметра'
                    : undefined
                }
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === (raw != null ? String(raw) : '')) return;
                  onSave({ characteristics: { [key]: next === '' ? null : next } });
                }}
              />
            </label>
          );
        })}
      </div>

      {line.qtyBySize.length > 0 && (
        <div className="cws-bysize">
          <span className="cws-grouplabel">Норма по размерам · из номенклатуры</span>
          <div className="cws-bysize__row">
            {line.qtyBySize.map((b) => (
              <span className="cws-bysize__cell" key={b.sizeId}>
                <span>
                  {b.sizeCode} · {b.qtyPlan} шт
                </span>
                <b>{b.value}</b>
              </span>
            ))}
          </div>
          <p className="cws-muted">
            В заказе хранится одна норма на изделие — средневзвешенная по этому
            плану ({line.qtyPerUnit} {line.unit}/шт). Правка нормы в строке
            заменит её целиком: строка перейдёт в «правлено в заказе», и
            пересчёт больше не будет её трогать.
          </p>
        </div>
      )}

      {line.qtySource === 'ORDER' && !line.isManual && (
        <p className="cws-muted">
          Норма правлена в заказе — номенклатура её больше не перезаписывает.
          Вернуть число из номенклатуры: «Обновить нормы из номенклатуры».
        </p>
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
        className="cws-btn cws-btn--primary"
        disabled={pending || v.label.trim() === ''}
        onClick={() => onSubmit(v)}
      >
        Добавить
      </button>
      <button type="button" className="cws-btn" onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}

function SpecStyles() {
  return (
    <style>{`
.cws { display:flex; flex-direction:column; gap:12px; border-top:1px dashed var(--color-border); padding-top:11px;
  /* ОДНА высота на все контролы окна: поля таблицы, поля панели параметров,
     селекты, кнопки. Раньше каждый блок задавал свой padding, и строки
     «прыгали» по высоте — это читалось как разные элементы разных экранов. */
  --cws-h:32px; --cws-r:8px; }
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
.cws-table td { padding:6px 10px; border-bottom:1px solid var(--color-border); vertical-align:middle; }
.cws-table tr:last-child td { border-bottom:0; }
.cws-table td.num { text-align:right; white-space:nowrap; }
.cws-total { font-variant-numeric:tabular-nums; color:var(--color-fg-strong); font-weight:600; }
/* Сдвоенная шапка: расход слева, закупка справа. Появляется только у групп,
   где единица нормы отличается от закупочной. */
.cws-table th.cws-grp { text-align:center; font-size:10px; border-bottom:0; padding-bottom:3px; }
.cws-table th.cws-grp--norm { background:var(--color-ok-soft,var(--color-bg-tint)); color:var(--color-ok-fg,var(--color-fg-strong)); }
.cws-table th.cws-grp--buy { background:var(--color-accent-soft,var(--color-bg-muted)); color:var(--color-accent-fg,var(--color-fg-strong)); }
.cws-table td.cws-zone--buy, .cws-table th.cws-zone--buy { background:color-mix(in srgb, var(--color-accent-soft,var(--color-bg-muted)) 34%, transparent); }
.cws-arrow { color:var(--color-accent-fg,var(--color-fg-muted)); font-weight:700; }
.cws-nocalc { color:var(--color-fg-subtle); cursor:help; }
.cws-cell { width:100%; min-width:70px; height:var(--cws-h); padding:0 8px; border:1px solid var(--color-border-strong);
  border-radius:var(--cws-r); font:inherit; font-size:13px; background:var(--color-bg-card); color:var(--color-fg); }
select.cws-cell { padding-right:22px; }
.cws-cell:focus { outline:none; border-color:var(--color-accent); }
.cws-cell:disabled { opacity:.65; cursor:not-allowed; background:var(--color-bg-muted); }
.cws-cell--name { min-width:170px; font-weight:600; }
.cws-cell--num { min-width:76px; max-width:96px; text-align:right; }
.cws-cell--sm { min-width:64px; max-width:110px; width:auto; padding:0 6px; font-size:12.5px; }
.cws-flags { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:5px; }
.cws-pill { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.03em;
  padding:2px 7px; border-radius:999px; background:var(--color-bg-tint); color:var(--color-fg-strong); }
.cws-density { display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--color-fg-muted); }
.cws-x { border:none; background:none; color:var(--color-fg-subtle); cursor:pointer; font-size:17px; line-height:1; padding:4px 6px; border-radius:6px; }
.cws-x:hover:not(:disabled) { color:var(--color-danger); background:var(--color-danger-soft); }
.cws-x:disabled { opacity:.4; cursor:not-allowed; }
.cws-btn { display:inline-flex; align-items:center; justify-content:center; align-self:flex-start; height:var(--cws-h);
  padding:0 12px; border:1px solid var(--color-border-strong); border-radius:var(--cws-r); background:var(--color-bg-card);
  color:var(--color-fg-muted); font:inherit; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; }
.cws-btn:hover:not(:disabled) { border-color:var(--color-accent); color:var(--color-fg); }
.cws-btn:disabled { opacity:.55; cursor:not-allowed; }
.cws-btn--dash { border-style:dashed; }
.cws-btn--primary { background:var(--btn-primary-bg,var(--color-accent)); border-color:var(--btn-primary-edge,var(--color-accent));
  color:var(--btn-primary-fg,#fff); }
.cws-btn--primary:hover:not(:disabled) { color:var(--btn-primary-fg,#fff); }
.cws-form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border:1px dashed var(--color-border-strong); border-radius:10px; }
.cws-form input, .cws-form select { height:var(--cws-h); padding:0 9px; border:1px solid var(--color-border-strong);
  border-radius:var(--cws-r); font:inherit; font-size:13px; background:var(--color-bg-card); color:var(--color-fg); }
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
.cws-nameline { display:flex; align-items:flex-start; gap:6px; }
.cws-caret { flex:none; width:24px; height:var(--cws-h); display:inline-flex; align-items:center; justify-content:center;
  border:1px solid var(--color-border-strong); border-radius:7px; background:var(--color-bg-card);
  color:var(--color-fg-muted); font:inherit; font-size:12px; cursor:pointer; }
.cws-caret:hover { border-color:var(--color-accent); color:var(--color-fg); }
.cws-caret.is-open { background:var(--color-bg-tint); border-color:var(--color-accent); color:var(--color-fg-strong); }
.cws-chips { display:flex; flex-wrap:wrap; gap:4px; align-items:center; max-width:270px;
  border:none; background:none; padding:0; font:inherit; text-align:left; cursor:pointer; }
.cws-chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px;
  background:var(--color-bg-muted); color:var(--color-fg); font-size:11.5px; }
.cws-chip--subtype { font-weight:700; }
.cws-chip--slot { background:var(--color-accent-soft,var(--color-bg-tint)); color:var(--color-accent-fg); font-weight:700; }
.cws-chip--empty { background:var(--color-bg-card); border:1px dashed var(--color-border-strong); color:var(--color-fg-subtle); }
.cws-qty { display:inline-flex; align-items:center; gap:6px; justify-content:flex-end; }
.cws-src { flex:none; display:inline-flex; align-items:center; justify-content:center; width:19px; height:19px;
  border-radius:999px; font-size:11px; font-weight:800; cursor:help; user-select:none; }
.cws-src--nomenclature { background:var(--color-ok-soft,var(--color-bg-tint)); color:var(--color-ok-fg,var(--color-fg-strong)); }
.cws-src--template { background:var(--color-bg-muted); color:var(--color-fg-muted); }
.cws-src--order { background:var(--color-bg-tint); color:var(--color-warn-fg,var(--color-fg-strong)); }
.cws-exp > td { background:var(--color-bg-muted); }
.cws-params-panel { display:flex; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--color-border-strong);
  border-radius:10px; background:var(--color-bg-card); }
.cws-params-panel__head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.cws-params-panel__head .cws-grouplabel { margin-bottom:0; }
.cws-fields { display:grid; grid-template-columns:repeat(auto-fill,minmax(168px,1fr)); gap:8px; }
.cws-field { display:flex; flex-direction:column; gap:3px; }
.cws-field > span { font-size:10.5px; font-weight:700; color:var(--color-fg-muted); }
.cws-bysize { display:flex; flex-direction:column; gap:6px; }
.cws-bysize__row { display:flex; flex-wrap:wrap; gap:6px; }
.cws-bysize__cell { display:inline-flex; flex-direction:column; align-items:center; gap:2px; padding:4px 8px;
  border:1px solid var(--color-border); border-radius:8px; background:var(--color-bg-muted); font-size:12px; }
.cws-bysize__cell > span { font-size:10px; font-weight:700; color:var(--color-fg-muted); }
`}</style>
  );
}
