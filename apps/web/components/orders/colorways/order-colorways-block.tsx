'use client';

/**
 * Блок «Расцветки» карточки заказа (фича `FEATURE_COLORWAYS`).
 *
 * Реальный редактор поверх API `/api/orders/:id/colorways`: у заказа
 * одна или несколько расцветок, каждая — цвет + своя техкарта
 * материалов + поразмерный план. Пишет через server actions
 * (`colorways-actions.ts`), состояние обновляет из возвращаемого
 * полного `OrderColorwaysDto`.
 *
 * На первом срезе это аддитивная надстройка над заказом: `OrderItem`
 * остаётся агрегатом, сведение поразмерного плана по цветам в
 * производство/раскрой — поздняя фаза. Блок это честно проговаривает
 * в подсказке внизу.
 */

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  resolveVariantParamsGroup,
  type OrderTechCardParametersDto,
} from '@sewing/shared/order-tech-cards';
import { ColorwaySpec } from './colorway-spec';
import { ModalPortal } from '@/components/modal-portal';
import {
  Palette,
  Plus,
  Trash2,
  Save,
  Info,
  Loader2,
  Layers,
} from 'lucide-react';
import type { OrderColorwaysDto } from '@sewing/shared';
import {
  createColorwayAction,
  updateColorwayAction,
  deleteColorwayAction,
} from '@/app/admin/orders/[id]/colorways-actions';
import { refreshTechCardParamsAction } from '@/app/admin/orders/[id]/tech-card-params-actions';

// Декоративный свотч по названию цвета (источник истины — имя-строка).
const COLOR_HEX: Record<string, string> = {
  'белый': '#f2f2f0', 'белая': '#f2f2f0',
  'чёрный': '#222', 'черный': '#222', 'чёрная': '#222', 'черная': '#222',
  'красный': '#d23b3b', 'красная': '#d23b3b',
  'жёлтый': '#e8b73a', 'желтый': '#e8b73a', 'жёлтая': '#e8b73a', 'желтая': '#e8b73a',
  'синий': '#2f7fd1', 'синяя': '#2f7fd1',
  'зелёный': '#2e9e4a', 'зеленый': '#2e9e4a', 'зелёная': '#2e9e4a', 'зеленая': '#2e9e4a',
  'серый': '#8a8a86', 'серая': '#8a8a86',
};
function swatchHex(name: string): string {
  return COLOR_HEX[name.trim().toLowerCase()] ?? '#b7c3d0';
}

interface DraftSize { sizeId: string; qtyPlan: number }
interface Draft { color: string; techCardId: string | null; sizes: DraftSize[] }

function toDraft(v: OrderColorwaysDto['variants'][number]): Draft {
  return {
    color: v.color,
    techCardId: v.techCardId,
    sizes: v.sizes.map((s) => ({ sizeId: s.sizeId, qtyPlan: s.qtyPlan })),
  };
}

/**
 * Сводка спецификации расцветки для тогла «Материалы · N». Решение 16.07:
 * вход в спецификацию БЕЗУСЛОВНЫЙ (раньше чип рисовался только при
 * обязательных параметрах — у техкарты без них материал было некуда
 * добавить). null — только если данные фичи вообще не пришли.
 */
function specSummary(
  params: OrderTechCardParametersDto | null | undefined,
  variantId: string,
): { lines: number } | null {
  if (!params) return null;
  // При 0–1 расцветке снимок живёт order-level группой (`orderVariantId =
  // null`) — резолвер знает это правило (та же логика, что на бэке).
  const group = resolveVariantParamsGroup(params, variantId);
  if (!group) return null;
  return { lines: group.lines.length };
}

export function OrderColorwaysBlock({
  orderId,
  initial,
  editable = true,
  techCardParams = null,
}: {
  orderId: string;
  initial: OrderColorwaysDto;
  /**
   * Можно ли сейчас редактировать расцветки. Совпадает с бэкенд-окном
   * (`DRAFT`/`CALCULATION`): только там правка расцветки поднимается в
   * агрегат `OrderItem`. Иначе блок read-only, а любые мутации бэкенд
   * отклонит (`ORDER_COLORWAYS_LOCKED`) — чтобы форма не «сохраняла»
   * правки, которые не изменят общий план заказа.
   */
  editable?: boolean;
  /**
   * Фича «Параметры техкарт»: слоты и значения по расцветкам. Плитка
   * показывает, сколько обязательных ещё не заполнено, и открывает окно.
   * null — фича не отдала данные (карточка не должна из-за этого падать).
   */
  techCardParams?: OrderTechCardParametersDto | null;
}) {
  const ro = !editable;
  const [data, setData] = useState<OrderColorwaysDto>(initial);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(data.variants.map((v) => [v.id, toDraft(v)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Фича «Варианты просчёта»: при переключении варианта бэкенд
  // ПЕРЕСОЗДАЁТ расцветки (`OrderVariant`) с новыми id, и после
  // `router.refresh()` в блок приезжает новый `initial` с этими id.
  // `data`/`drafts` инициализируются из `initial` лишь при монтировании
  // (useState), поэтому без синхронизации блок продолжал бы показывать
  // расцветки ПРОШЛОГО варианта и сохранял бы по устаревшему id →
  // «Расцветка не найдена» + правки «перетекали» между вариантами.
  // Синхронизируем по НАБОРУ id расцветок: он меняется при переключении
  // варианта / добавлении / удалении, но НЕ на каждый refresh — поэтому
  // несохранённые правки в drafts при обычной ревалидации не сбрасываются.
  const variantKey = initial.variants.map((v) => v.id).join(',');
  useEffect(() => {
    setData(initial);
    setDrafts(
      Object.fromEntries(initial.variants.map((v) => [v.id, toDraft(v)])),
    );
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantKey]);
  // Спецификация (материалы + параметры) — единое состояние на все карточки:
  // каждый write возвращает свежий полный DTO. После server-действий вне
  // спецификации (смена техкарты расцветки → router.refresh) приезжает новый
  // проп — синхронизируемся с ним, иначе таблица показала бы устаревший
  // снимок.
  const [params, setParams] = useState<OrderTechCardParametersDto | null>(
    techCardParams,
  );
  useEffect(() => setParams(techCardParams), [techCardParams]);
  // Материалы техкарты открываются в компактной модалке (а не инлайн в
  // карточке — иначе грид расплывался в «простыню»). Храним id расцветки,
  // чья модалка сейчас открыта (null = закрыта); открыта максимум одна.
  const [specVariant, setSpecVariant] = useState<string | null>(null);
  // Esc закрывает модалку (клик по фону — в разметке оверлея).
  useEffect(() => {
    if (!specVariant) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSpecVariant(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [specVariant]);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const sizeCode = useMemo(
    () => new Map(data.sizes.map((s) => [s.id, s.code])),
    [data.sizes],
  );

  function applyResult(
    r: { ok: boolean; error?: string; data?: OrderColorwaysDto },
  ): void {
    if (r.ok && r.data) {
      setData(r.data);
      setDrafts(
        Object.fromEntries(r.data.variants.map((v) => [v.id, toDraft(v)])),
      );
      setError(null);
      // Смена техкарты расцветки пересобирает СПЕЦИФИКАЦИЮ (материалы +
      // параметры) на бэке, но `updateColorwayAction` возвращает только
      // расцветки. Материалы раньше подтягивались лишь через
      // `router.refresh()` → проп → useEffect, и это срабатывало
      // ненадёжно («материалы появлялись только после F5»). Явно
      // перечитываем спецификацию и обновляем `params` сразу.
      void refreshTechCardParamsAction(orderId).then((pr) => {
        if (pr.ok && pr.data) setParams(pr.data);
      });
      // Правка расцветки на бэке пересобирает агрегат OrderItem
      // (Σ OrderVariantSize) — см. `OrdersService.resyncColorwayDerived`.
      // Но карточка заказа («План по размерам», итог qtyPlanTotal в шапке,
      // размерный breakdown) рендерится server-компонентом из `getOrder`
      // и без ревалидации показывает старый план. `router.refresh()`
      // перезапрашивает серверные данные → план наверху меняется вслед
      // за расцветкой. Локальный state блока (`data`/`drafts`) уже
      // обновлён из ответа, поэтому сам блок не «мигает».
      router.refresh();
    } else {
      setError(r.error ?? 'Ошибка');
    }
    setBusyId(null);
  }

  function patchDraft(vid: string, upd: Partial<Draft>): void {
    setDrafts((prev) => ({ ...prev, [vid]: { ...prev[vid], ...upd } }));
  }
  function setQty(vid: string, sizeId: string, qty: number): void {
    setDrafts((prev) => {
      const d = prev[vid];
      const exists = d.sizes.some((s) => s.sizeId === sizeId);
      const sizes = exists
        ? d.sizes.map((s) => (s.sizeId === sizeId ? { ...s, qtyPlan: qty } : s))
        : [...d.sizes, { sizeId, qtyPlan: qty }];
      return { ...prev, [vid]: { ...d, sizes } };
    });
  }
  function addSize(vid: string, sizeId: string): void {
    if (!sizeId) return;
    setDrafts((prev) => {
      const d = prev[vid];
      if (d.sizes.some((s) => s.sizeId === sizeId)) return prev;
      return { ...prev, [vid]: { ...d, sizes: [...d.sizes, { sizeId, qtyPlan: 0 }] } };
    });
  }
  function removeSize(vid: string, sizeId: string): void {
    setDrafts((prev) => ({
      ...prev,
      [vid]: { ...prev[vid], sizes: prev[vid].sizes.filter((s) => s.sizeId !== sizeId) },
    }));
  }

  function saveVariant(vid: string): void {
    const d = drafts[vid];
    setBusyId(vid);
    startTransition(async () => {
      applyResult(
        await updateColorwayAction(orderId, vid, {
          color: d.color,
          techCardId: d.techCardId,
          sizes: d.sizes,
        }),
      );
    });
  }
  function addColorway(): void {
    setBusyId('__new__');
    startTransition(async () => {
      applyResult(
        await createColorwayAction(orderId, {
          color: 'новый цвет',
          techCardId: null,
          sizes: [],
        }),
      );
    });
  }
  function removeColorway(vid: string): void {
    setBusyId(vid);
    startTransition(async () => {
      applyResult(await deleteColorwayAction(orderId, vid));
    });
  }

  // Итог по размерам (по всем расцветкам, из черновиков — вживую).
  const totalsBySize = useMemo(() => {
    const acc = new Map<string, number>();
    for (const d of Object.values(drafts)) {
      for (const s of d.sizes) {
        if (s.qtyPlan > 0) acc.set(s.sizeId, (acc.get(s.sizeId) ?? 0) + s.qtyPlan);
      }
    }
    return [...acc.entries()].sort(
      (a, b) =>
        data.sizes.findIndex((s) => s.id === a[0]) -
        data.sizes.findIndex((s) => s.id === b[0]),
    );
  }, [drafts, data.sizes]);
  const grandTotal = totalsBySize.reduce((a, [, q]) => a + q, 0);

  const canDelete = data.variants.length > 1;

  return (
    <section className="cwl">
      <BlockStyles />
      <header className="cwl-head">
        <h2>
          <Palette size={18} strokeWidth={1.8} aria-hidden /> Расцветки
          <span className="cwl-badge">{data.variants.length}</span>
        </h2>
        {!ro && (
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={addColorway}
            disabled={pending}
          >
            {pending && busyId === '__new__' ? (
              <Loader2 size={15} className="cwl-spin" aria-hidden />
            ) : (
              <Plus size={15} strokeWidth={2} aria-hidden />
            )}{' '}
            Добавить расцветку
          </button>
        )}
      </header>

      {ro && (
        <div className="cwl-locked">
          <Info size={16} strokeWidth={1.8} aria-hidden />
          <span>
            План заказа заморожен (расчёт завершён или заказ в производстве),
            поэтому цвет, размеры и выбор техкарты только для просмотра:
            правка не изменит общий план заказа — чтобы менять их, верните
            заказ на пересчёт.{' '}
            {params?.editMode === 'AMENDMENT' ? (
              <>
                <strong>Материалы техкарты править можно</strong> — откройте
                «Материалы» в карточке расцветки.
              </>
            ) : null}
          </span>
        </div>
      )}

      {error && <div className="cwl-error">{error}</div>}

      <div className="cwl-grid">
        {data.variants.map((v) => {
          const d = drafts[v.id];
          if (!d) return null;
          const rowTotal = d.sizes.reduce((a, s) => a + (s.qtyPlan || 0), 0);
          const usedSizeIds = new Set(d.sizes.map((s) => s.sizeId));
          const addable = data.sizes.filter((s) => !usedSizeIds.has(s.id));
          const busy = pending && busyId === v.id;
          const spec = specSummary(params, v.id);
          const isOpen = specVariant === v.id;
          return (
            <article
              key={v.id}
              className="cwl-card"
              style={{ ['--cwl-accent' as string]: swatchHex(d.color) }}
            >
              <div className="cwl-card__head">
                <span className="cwl-swatch" style={{ background: swatchHex(d.color) }} />
                <input
                  className="cwl-input cwl-input--name"
                  value={d.color}
                  onChange={(e) => patchDraft(v.id, { color: e.target.value })}
                  placeholder="Цвет"
                  disabled={ro}
                />
                {!ro && (
                  <button
                    type="button"
                    className="cwl-icon"
                    aria-label="Удалить расцветку"
                    disabled={!canDelete || pending}
                    title={canDelete ? 'Удалить расцветку' : 'Нельзя удалить последнюю расцветку'}
                    onClick={() => removeColorway(v.id)}
                  >
                    <Trash2 size={15} strokeWidth={1.8} aria-hidden />
                  </button>
                )}
              </div>

              <label className="cwl-field">
                <span className="cwl-label">Техкарта материалов</span>
                <select
                  className="cwl-input"
                  value={d.techCardId ?? ''}
                  onChange={(e) =>
                    patchDraft(v.id, { techCardId: e.target.value || null })
                  }
                  disabled={ro}
                >
                  <option value="">— по умолчанию заказа —</option>
                  {data.techCards.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>

              <div className="cwl-field">
                <span className="cwl-label">План по размерам, шт</span>
                <div className="cwl-sizes">
                  {d.sizes.map((s) => (
                    <div key={s.sizeId} className="cwl-size">
                      <span className="cwl-size__code">{sizeCode.get(s.sizeId) ?? '—'}</span>
                      <input
                        type="number"
                        min={0}
                        // Ноль — плейсхолдер, а не значение: ячейку не нужно
                        // сначала стирать, чтобы ввести число (см. тот же
                        // приём в `order-create-colorways.tsx`).
                        placeholder="0"
                        value={s.qtyPlan === 0 ? '' : String(s.qtyPlan)}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) =>
                          setQty(v.id, s.sizeId, Math.max(0, +e.target.value || 0))
                        }
                        disabled={ro}
                      />
                      {!ro && (
                        <button
                          type="button"
                          className="cwl-size__x"
                          aria-label="Убрать размер"
                          onClick={() => removeSize(v.id, s.sizeId)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                  {!ro && addable.length > 0 && (
                    <select
                      className="cwl-add-size"
                      value=""
                      onChange={(e) => addSize(v.id, e.target.value)}
                    >
                      <option value="">＋ размер</option>
                      {addable.map((s) => (
                        <option key={s.id} value={s.id}>{s.code}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Спецификация расцветки: материалы техкарты заказа +
                  параметры. Вход БЕЗУСЛОВНЫЙ (решение 16.07) — раньше чип
                  «Параметры N из M» рисовался только при обязательных
                  параметрах, и у техкарты без них материал было некуда
                  добавить. Клик «Развернуть» открывает таблицу в компактной
                  модалке (см. рендер оверлея ниже). */}
              {spec && (
                <button
                  type="button"
                  className="cwl-spec-toggle"
                  aria-expanded={isOpen}
                  aria-haspopup="dialog"
                  onClick={() => setSpecVariant(v.id)}
                >
                  <Layers size={14} strokeWidth={1.8} aria-hidden />
                  Материалы
                  <span className="cwl-badge">{spec.lines}</span>
                  <span className="cwl-spec-toggle__hint">развернуть</span>
                </button>
              )}

              <footer className="cwl-card__foot">
                <span className="cwl-muted">
                  Σ {rowTotal} шт ·{' '}
                  {d.techCardId
                    ? (data.techCards.find((t) => t.id === d.techCardId)?.name ?? 'своя техкарта')
                    : 'техкарта заказа'}
                </span>
                {!ro && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost cwl-save"
                    onClick={() => saveVariant(v.id)}
                    disabled={pending}
                  >
                    {busy ? (
                      <Loader2 size={14} className="cwl-spin" aria-hidden />
                    ) : (
                      <Save size={14} strokeWidth={1.8} aria-hidden />
                    )}{' '}
                    Сохранить
                  </button>
                )}
              </footer>
            </article>
          );
        })}
      </div>

      {/* Модалка «Материалы техкарты» — компактный оверлей вместо инлайновой
          «простыни». Тот же самодостаточный `ColorwaySpec`, что раскрывался
          в карточке, просто помещён в диалог. Закрытие: × / клик по фону / Esc. */}
      {specVariant && params && drafts[specVariant] && (
        <ModalPortal>
          <div
            className="qr-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Материалы техкарты — ${drafts[specVariant].color || 'расцветка'}`}
            onClick={(e) => {
              if (e.target === e.currentTarget) setSpecVariant(null);
            }}
          >
            <div className="qr-modal__card cwl-spec-modal__card">
              <div className="qr-modal__header">
                <h3 className="qr-modal__title cwl-spec-modal__title">
                  <Layers size={16} strokeWidth={1.8} aria-hidden />
                  Материалы техкарты
                  {drafts[specVariant].color
                    ? ` · ${drafts[specVariant].color}`
                    : ''}
                </h3>
                <button
                  type="button"
                  className="qr-modal__close"
                  onClick={() => setSpecVariant(null)}
                  aria-label="Закрыть"
                >
                  ×
                </button>
              </div>
              {/* readOnly НЕ пробрасываем: окно правки спецификации ШИРЕ,
                  чем у расцветок. Расцветку (цвет/размеры/техкарту) можно
                  править только пока план не заморожен, а материалы и
                  нормы технолог уточняет и после расчёта, и в производстве
                  — `ColorwaySpec` берёт своё право на правку из
                  `params.editMode` (его считает бэкенд). */}
              <ColorwaySpec
                orderId={orderId}
                params={params}
                variantId={specVariant}
                onData={setParams}
              />
            </div>
          </div>
        </ModalPortal>
      )}

      {totalsBySize.length > 0 && (
        <div className="cwl-totals">
          <span className="cwl-muted">Итого по размерам:</span>
          {totalsBySize.map(([sid, q]) => (
            <span key={sid} className="cwl-chip">
              {sizeCode.get(sid) ?? '—'} <b>{q}</b>
            </span>
          ))}
          <span className="cwl-chip cwl-chip--total">Всего <b>{grandTotal}</b></span>
        </div>
      )}

      <div className="cwl-note">
        <Info size={16} strokeWidth={1.8} aria-hidden />
        <span>
          Первый срез: расцветки хранятся отдельно от плана заказа
          (аддитивно). Цвет паспортов и поразмерный крой по цветам —
          следующая фаза. Фича под флагом <code>FEATURE_COLORWAYS</code>.
        </span>
      </div>
    </section>
  );
}

function BlockStyles() {
  // dangerouslySetInnerHTML (а не children `<style>{…}`): в CSS есть
  // `content:''` — React экранировал бы апострофы в children как
  // `&#x27;`, но браузер внутри `<style>` не декодирует entities, из-за
  // чего server-HTML расходился с client → hydration error. Через
  // __html строка вставляется как есть, server === client.
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
.cwl { display: flex; flex-direction: column; gap: 14px; background: var(--color-bg-card);
  border: 1px solid var(--color-border); border-radius: var(--admin-radius-card,12px);
  box-shadow: var(--admin-shadow-soft); padding: 16px 18px; }
.cwl * { box-sizing: border-box; }
.cwl-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.cwl-head h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 17px; }
.cwl-badge { display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px;
  padding:0 6px; border-radius:999px; background:var(--color-bg-muted); color:var(--color-fg-muted); font-size:12px; font-weight:700; }
/* Спецификация расцветки: тогл «Материалы · N» открывает таблицу
   материалов+параметров в компактной модалке (.cwl-spec-modal__card),
   а не инлайн — иначе раскрытая карточка растягивалась на всю ширину грида. */
.cwl-spec-toggle { display:flex; align-items:center; gap:7px; width:100%;
  padding:7px 9px; border:1px dashed var(--color-border-strong); border-radius:9px;
  background:var(--color-bg-card); color:var(--color-fg); font:inherit; font-size:13px;
  font-weight:600; cursor:pointer; text-align:left; }
.cwl-spec-toggle:hover { border-color:var(--color-accent); }
.cwl-spec-toggle__hint { margin-left:auto; font-size:11.5px; font-weight:500; color:var(--color-fg-subtle); }
/* Модалка техкарты шире базовой .qr-modal__card (520px): в таблице
   спецификации семь колонок — материал, параметры, норма, ед., цвет,
   итого, удаление; на 760px «Итого» уезжало за край окна.
   (историческая заметка ниже — про первую, компактную версию)
   т.к. таблица материалов многоколоночная, но заметно уже инлайн-«простыни».
   Таблица внутри и так скроллится по горизонтали (.cws-tablewrap). */
.cwl-spec-modal__card { width: min(100%, 1080px); }
.cwl-spec-modal__title { display:inline-flex; align-items:center; gap:7px; }
/* Внутри модалки убираем верхний разделитель .cws — он был нужен как
   отбивка от карточки при инлайн-раскрытии, в диалоге лишний. */
.cwl-spec-modal__card .cws { border-top:0; padding-top:0; }
.cwl-error { padding:9px 12px; border-radius:8px; background:var(--color-danger-soft); color:var(--color-danger-fg); font-size:13px; }
.cwl-locked { display:flex; align-items:flex-start; gap:8px; padding:10px 12px; border-radius:9px;
  background:var(--color-warning-soft,var(--color-bg-muted)); color:var(--color-fg-muted);
  border:1px solid var(--color-border); font-size:12.5px; line-height:1.45; }
.cwl-locked svg { flex:none; margin-top:1px; }
.cwl-input:disabled, .cwl-size input:disabled { opacity:.65; cursor:not-allowed; background:var(--color-bg-muted); }
.cwl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
.cwl-card { position:relative; border:1px solid var(--color-border); border-radius:12px; padding:12px 12px 10px;
  display:flex; flex-direction:column; gap:11px; background:var(--color-bg); overflow:hidden; }
.cwl-card::before { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--cwl-accent); }
.cwl-card__head { display:flex; align-items:center; gap:9px; }
.cwl-swatch { width:26px; height:26px; border-radius:7px; border:1px solid rgba(0,0,0,.15); flex:none; }
.cwl-input { width:100%; padding:6px 9px; border:1px solid var(--color-border-strong); border-radius:8px;
  font:inherit; background:var(--color-bg-card); color:var(--color-fg); }
.cwl-input:focus { outline:none; border-color:var(--color-accent); }
.cwl-input--name { font-weight:700; }
.cwl-icon { flex:none; margin-left:auto; display:inline-flex; padding:6px; border-radius:7px; border:1px solid transparent;
  background:none; color:var(--color-fg-subtle); cursor:pointer; }
.cwl-icon:hover:not(:disabled){ color:var(--color-danger); background:var(--color-danger-soft); }
.cwl-icon:disabled { opacity:.4; cursor:not-allowed; }
.cwl-field { display:flex; flex-direction:column; gap:6px; }
.cwl-label { font-size:11px; font-weight:600; color:var(--color-fg-muted); text-transform:uppercase; letter-spacing:.02em; }
.cwl-sizes { display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
.cwl-size { display:flex; align-items:center; gap:4px; border:1px solid var(--color-border); border-radius:8px; padding:2px 4px 2px 7px; background:var(--color-bg-card); }
.cwl-size__code { font-size:11px; font-weight:700; color:var(--color-fg-muted); }
.cwl-size input { width:52px; padding:4px; text-align:center; border:1px solid transparent; border-radius:6px; font:inherit; background:transparent; color:var(--color-fg); }
.cwl-size input:focus { outline:none; border-color:var(--color-accent); background:var(--color-bg); }
.cwl-size__x { border:none; background:none; color:var(--color-fg-subtle); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }
.cwl-size__x:hover { color:var(--color-danger); }
.cwl-add-size { padding:5px 7px; border:1px dashed var(--color-border-strong); border-radius:8px; font:inherit; background:var(--color-bg-card); color:var(--color-fg-muted); cursor:pointer; }
.cwl-card__foot { display:flex; align-items:center; justify-content:space-between; gap:8px; border-top:1px dashed var(--color-border); padding-top:9px; }
.cwl-muted { font-size:12.5px; color:var(--color-fg-muted); }
.cwl-save { padding:5px 10px; font-size:13px; }
.cwl-totals { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:2px; }
.cwl-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:999px; background:var(--color-bg-muted); font-size:12.5px; }
.cwl-chip--total { background:var(--color-bg-tint); color:var(--color-fg-strong); }
.cwl-note { display:flex; align-items:flex-start; gap:8px; padding:10px 12px; border-radius:9px; background:var(--color-bg-soft);
  border:1px solid var(--color-border); color:var(--color-fg-muted); font-size:12.5px; line-height:1.45; }
.cwl-note svg { flex:none; margin-top:1px; }
.cwl-note code { background:rgba(0,0,0,.06); padding:1px 5px; border-radius:5px; font-size:12px; }
.cwl-spin { animation: cwl-rot 0.8s linear infinite; }
@keyframes cwl-rot { to { transform: rotate(360deg); } }
`,
      }}
    />
  );
}
