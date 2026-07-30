'use client';

/**
 * `OrderNeedEditor` — правка строки потребности прямо во вкладке
 * «Потребности» карточки заказа (`/admin/orders/[id]?tab=needs`).
 *
 * Фича «Правка потребности на любой стадии». Раньше строку из техкарты
 * поправить было нельзя вовсе (409 `WORKSHOP_NEED_NOT_MANUAL`), а
 * закупочные поля правились только на отдельном экране закупщика
 * `/admin/workshop-needs`. Ошибка в расчёте («не та норма», «не та
 * единица») чинилась перезапуском всего просчёта — с потерей цен и
 * статусов, введённых закупщиком.
 *
 * Теперь: карандаш в строке таблицы → окно правки → сохранение. Backend
 * помечает правку (`manualEditAt`), кладёт исходное количество в
 * `calculatedQtyOriginal` и СРАЗУ пересчитывает себестоимость
 * (`OrderCostEstimatesService.syncAfterNeedsChange`) — «₽ за изделие» в
 * блоке ниже обновляется тем же действием, без второй кнопки.
 *
 * Компонент рендерится:
 *   - в ячейке «Описание» таблицы `OrderMaterialsUnifiedTable` (колонка
 *     sticky — карандаш виден без горизонтального скролла);
 *   - в шапке той же таблицы как «Добавить строку» (`mode="create"`).
 *
 * Окно — фиксированный оверлей, а не раскрытие строки: таблица широкая
 * (14 колонок, min-width 1380px), инлайн-форма в ячейке ломала бы
 * вёрстку и уезжала за горизонтальный скролл.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  MATERIAL_ROLES,
  MATERIAL_ROLE_LABELS,
} from '@sewing/shared/material-roles';
import { MONEY_CURRENCIES } from '@sewing/shared/money';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  cancelOrderNeedAction,
  createManualWorkshopNeedAction,
  deleteOrderNeedAction,
  updateOrderNeedAction,
} from '@/app/orders/actions';

interface Props {
  orderId: string;
  /** `undefined` — режим «Добавить строку». */
  need?: WorkshopNeedListItemDto;
  /**
   * Режим окна. `edit` — правка существующей строки, `create` — новая
   * ручная строка потребности (`isManual = true`).
   */
  mode: 'edit' | 'create';
}

/** Убирает хвостовые нули: «1.5000» → «1.5», «800.0000» → «800». */
function trimDecimal(raw: string | null | undefined): string {
  if (raw == null) return '';
  if (!raw.includes('.')) return raw;
  const trimmed = raw.replace(/0+$/u, '').replace(/\.$/u, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

export function OrderNeedEditor({ orderId, need, mode }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [description, setDescription] = useState(need?.description ?? '');
  const [unit, setUnit] = useState(need?.unit ?? '');
  const [role, setRole] = useState(need?.materialRole ?? '');
  const [calculatedQty, setCalculatedQty] = useState(
    trimDecimal(need?.calculatedQty),
  );
  const [purchaseQty, setPurchaseQty] = useState(
    trimDecimal(need?.purchaseQty),
  );
  const [price, setPrice] = useState(trimDecimal(need?.quotedPrice));
  const [currency, setCurrency] = useState(need?.quotedCurrency ?? 'RUB');
  const [comment, setComment] = useState(need?.comment ?? '');

  // Esc закрывает окно — обычное ожидание от модалки.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function run(
    action: () => Promise<{ ok?: boolean; error?: string }>,
    closeOnOk = true,
  ) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(result.error);
        return;
      }
      if (closeOnOk) setOpen(false);
      router.refresh();
    });
  }

  function submit() {
    // Отправляем весь набор полей: backend сам решит, что изменилось, и
    // пометит правку состава. Пустые необязательные поля идут как
    // `null` — это осознанное «стереть значение» (см. Zod-поля
    // `PurchaseQtyField` / `QuotedPriceField`).
    const payload = {
      description: description.trim(),
      unit: unit.trim(),
      materialRole: role === '' ? null : role,
      calculatedQty: calculatedQty.trim(),
      purchaseQty: purchaseQty.trim() === '' ? null : purchaseQty.trim(),
      quotedPrice: price.trim() === '' ? null : price.trim(),
      quotedCurrency: price.trim() === '' ? null : currency,
      comment: comment.trim() === '' ? null : comment.trim(),
    };
    if (mode === 'create') {
      run(() => createManualWorkshopNeedAction(orderId, payload));
      return;
    }
    run(() => updateOrderNeedAction(orderId, need!.id, payload));
  }

  const isCancelled = need?.status === 'CANCELLED';
  const editedQty =
    need?.calculatedQtyOriginal != null
      ? trimDecimal(need.calculatedQtyOriginal)
      : null;

  return (
    <>
      {mode === 'create' ? (
        <button
          type="button"
          className="admin-btn admin-btn--ghost order-need-editor__add"
          onClick={() => setOpen(true)}
          data-testid="order-need-add"
        >
          <Plus size={15} strokeWidth={1.7} aria-hidden /> Добавить строку
        </button>
      ) : (
        <button
          type="button"
          className="order-need-editor__pencil"
          onClick={() => setOpen(true)}
          title="Изменить строку потребности"
          aria-label={`Изменить: ${need?.description ?? ''}`}
          data-testid="order-need-edit"
        >
          <Pencil size={13} strokeWidth={1.7} aria-hidden />
        </button>
      )}

      {open && (
        <div
          className="order-need-editor__overlay"
          role="dialog"
          aria-modal="true"
          aria-label={
            mode === 'create'
              ? 'Новая строка потребности'
              : 'Правка строки потребности'
          }
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="order-need-editor__panel">
            <div className="order-need-editor__head">
              <b className="order-need-editor__title">
                {mode === 'create'
                  ? 'Новая строка потребности'
                  : 'Правка строки потребности'}
              </b>
              <button
                type="button"
                className="order-need-editor__close"
                onClick={() => setOpen(false)}
                aria-label="Закрыть"
              >
                <X size={16} strokeWidth={1.7} aria-hidden />
              </button>
            </div>

            <p className="order-need-editor__hint admin-muted">
              Себестоимость пересчитается сразу после сохранения — отдельно
              нажимать «Пересчитать» не нужно.
            </p>

            {editedQty && (
              <p className="order-need-editor__was" data-testid="order-need-was">
                Система считала: {editedQty} {need?.unit}
              </p>
            )}

            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}

            <form
              className="order-need-editor__form"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label className="order-need-editor__field order-need-editor__field--wide">
                <span className="order-need-editor__lab">Описание</span>
                <input
                  type="text"
                  className="admin-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  disabled={pending}
                />
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">Чистая норма</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="admin-input"
                  value={calculatedQty}
                  onChange={(e) => setCalculatedQty(e.target.value)}
                  required
                  disabled={pending}
                />
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">Ед. изм.</span>
                <input
                  type="text"
                  className="admin-input"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  required
                  disabled={pending}
                />
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">Роль материала</span>
                <select
                  className="admin-input"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={pending}
                >
                  <option value="">— не указана —</option>
                  {MATERIAL_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {MATERIAL_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">К закупке</span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="admin-input"
                  value={purchaseQty}
                  onChange={(e) => setPurchaseQty(e.target.value)}
                  placeholder={calculatedQty}
                  disabled={pending}
                />
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">
                  Цена за 1 {unit || 'ед.'}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="admin-input"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  disabled={pending}
                />
              </label>

              <label className="order-need-editor__field">
                <span className="order-need-editor__lab">Валюта</span>
                <select
                  className="admin-input"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  disabled={pending}
                >
                  {MONEY_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="order-need-editor__field order-need-editor__field--wide">
                <span className="order-need-editor__lab">Комментарий</span>
                <textarea
                  className="admin-input"
                  rows={2}
                  maxLength={1000}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={pending}
                />
              </label>

              <div className="order-need-editor__actions">
                <button
                  type="submit"
                  className="admin-btn admin-btn--primary"
                  disabled={pending}
                >
                  {pending ? 'Сохраняем…' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  className="admin-btn admin-btn--ghost"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                >
                  Отмена
                </button>

                {mode === 'edit' && need && !isCancelled && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost order-need-editor__danger"
                    disabled={pending}
                    title={
                      need.isManual
                        ? 'Удалить строку из потребности'
                        : 'Убрать строку из потребности и себестоимости (строка останется в истории — на неё могут ссылаться закупки и приёмки)'
                    }
                    onClick={() => {
                      const question = need.isManual
                        ? `Удалить «${need.description}»?`
                        : `Убрать «${need.description}» из потребности?`;
                      if (!window.confirm(question)) return;
                      run(() =>
                        need.isManual
                          ? deleteOrderNeedAction(orderId, need.id)
                          : cancelOrderNeedAction(orderId, need.id),
                      );
                    }}
                  >
                    <Trash2 size={15} strokeWidth={1.6} aria-hidden />
                    {need.isManual ? 'Удалить строку' : 'Убрать из потребности'}
                  </button>
                )}

                {mode === 'edit' && need && isCancelled && (
                  <button
                    type="button"
                    className="admin-btn admin-btn--ghost"
                    disabled={pending}
                    title="Вернуть погашенную строку в потребность и себестоимость"
                    onClick={() =>
                      run(() =>
                        updateOrderNeedAction(orderId, need.id, {
                          status: 'REVIEWED',
                        }),
                      )
                    }
                  >
                    Вернуть в потребность
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export default OrderNeedEditor;
