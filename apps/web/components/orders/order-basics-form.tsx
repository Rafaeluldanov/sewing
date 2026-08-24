'use client';

/**
 * `OrderBasicsForm` — форма блока «Основное» карточки заказа
 * `/admin/orders/[id]` (шаг 2 плана «правка на месте», см.
 * `docs/mockups/order-page-inline-edit-mockup.html`).
 *
 * Живёт ВНУТРИ `OrderEditBlock`: блок отвечает за состояния (просмотр /
 * правка / сохранено / не сохранено) и за сообщения, форма — только за
 * поля и сабмит. Результат сохранения форма докладывает блоку через
 * `onSaved` / `onFailed`.
 *
 * Поля (см. `updateOrderBasicsAction`):
 *   - клиент (`clientId`) — ОБЯЗАТЕЛЬНОЕ (этап «Клиент — обязательный
 *     атрибут заказа»): `required`-селект без варианта «без клиента».
 *     Исторический заказ без клиента дозаполняется здесь при первой правке;
 *   - срок сдачи (`dueDate`);
 *   - цена за 1 изделие + валюта (`customerUnitPrice` / `customerCurrency`);
 *   - комментарий (`comment`);
 *   - заказчик free-text (`customer`) — скрытым полем, для совместимости
 *     со старым flow.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет: подразделение (`companyDivisionId`). Раньше
 * оно лежало в этой форме, но у него другое окно правки —
 * `isOrderPlanEditable` (до запуска производства), а «Основное» правится
 * на любом статусе. Поле, видимое в производстве, но отбиваемое backend-ом
 * 409-й `ORDER_LOCKED`, — ровно то враньё, ради которого затевалась правка
 * на месте («общего окна правки не существует»). Подразделение переезжает
 * в блок «Настройки заказа» (шаг 3), до тех пор правится на `/edit`.
 * `updateOrderBasicsAction` трактует отсутствие ключа как «не трогать»
 * (см. `parseNullableString`), поэтому убрать поле безопасно.
 *
 * Backend / DTO / Prisma не меняли.
 */

import { useFormState, useFormStatus } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
  type MoneyCurrency,
} from '@sewing/shared/money';
import {
  updateOrderBasicsAction,
  type UpdateOrderBasicsActionState,
} from '@/app/admin/orders/[id]/basic-actions';
import { CreatableSelect } from '@/components/admin/ref-create/creatable-select';
import { useOrderEditBlockApi } from '@/components/orders/blocks/order-edit-block';

interface Props {
  orderId: string;
  initial: {
    dueDate: string | null;
    clientId: string | null;
    customer: string | null;
    customerUnitPrice: string | number | null | undefined;
    customerCurrency: MoneyCurrency | null | undefined;
    comment: string | null;
  };
  clients: ClientDto[];
}

const initialState: UpdateOrderBasicsActionState = {};

function FormActions({ onCancel }: { onCancel: () => void }) {
  const { pending } = useFormStatus();
  return (
    <div className="order-edit-block__actions">
      <button
        type="button"
        className="admin-btn admin-btn--ghost"
        onClick={onCancel}
        disabled={pending}
      >
        <X size={14} strokeWidth={1.7} aria-hidden />
        Отмена
      </button>
      <button
        type="submit"
        className="admin-btn admin-btn--primary"
        disabled={pending}
      >
        <Save size={14} strokeWidth={1.7} aria-hidden />
        {pending ? 'Сохранение…' : 'Сохранить'}
      </button>
    </div>
  );
}

export function OrderBasicsForm({ orderId, initial, clients }: Props) {
  // Состояниями блока («сохранено» / «не сохранено» / закрыть правку)
  // управляет `OrderEditBlock` — форма только докладывает результат.
  const block = useOrderEditBlockApi();
  const action = updateOrderBasicsAction.bind(null, orderId);
  const [state, formAction] = useFormState(action, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  const dueDateInitial = initial.dueDate ? initial.dueDate.slice(0, 10) : '';
  const [dueDate, setDueDate] = useState<string>(dueDateInitial);
  const [clientId, setClientId] = useState<string>(initial.clientId ?? '');
  const [customerUnitPrice, setCustomerUnitPrice] = useState<string>(
    initial.customerUnitPrice == null ? '' : String(initial.customerUnitPrice),
  );
  const [customerCurrency, setCustomerCurrency] = useState<MoneyCurrency | ''>(
    initial.customerCurrency ?? '',
  );
  const [comment, setComment] = useState<string>(initial.comment ?? '');

  // Результат сабмита докладываем блоку. `onSaved` уводит блок в просмотр,
  // `onFailed` оставляет форму с введённым — правки при ошибке не теряются.
  useEffect(() => {
    if (state.ok) {
      block.saved();
      return;
    }
    if (state.error) {
      block.failed(state.error, {
        retry: () => formRef.current?.requestSubmit(),
      });
    }
    // Реагируем именно на смену результата, а не на каждый рендер:
    // `block` пересоздаётся при каждом рендере блока, в зависимости
    // его не берём — иначе эффект зациклится.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const showCurrentClientArchivedOption =
    initial.clientId && !clients.some((c) => c.id === initial.clientId);

  const fieldError = (key: string): string | undefined =>
    state.fieldErrors?.[key];

  return (
    <form
      ref={formRef}
      action={formAction}
      className="order-edit-block__form"
      aria-label="Основные поля заказа"
    >
      <div className="order-hero-card__basic-grid">
        {/* Этап «Клиент — обязательный атрибут заказа»: снять клиента нельзя,
            гейт стоит и в `updateOrderBasicsAction`, и в backend
            (`ORDER_CLIENT_REQUIRED`). */}
        <div className="order-hero-card__field">
          <label htmlFor="basics-clientId">
            Клиент{' '}
            <span
              className="order-hero-card__required"
              aria-label="обязательное поле"
              title="обязательное поле"
            >
              *
            </span>
          </label>
          <CreatableSelect
            entity="client"
            id="basics-clientId"
            name="clientId"
            value={clientId}
            onValueChange={setClientId}
            required
            aria-required="true"
            existingValues={clients.map((c) => c.id)}
          >
            <option value="">— выберите клиента —</option>
            {showCurrentClientArchivedOption && initial.clientId && (
              <option value={initial.clientId}>— архивный клиент —</option>
            )}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isActive ? '' : ' — архив'}
              </option>
            ))}
          </CreatableSelect>
          {fieldError('clientId') && (
            <span className="order-hero-card__field-error">
              {fieldError('clientId')}
            </span>
          )}
        </div>

        <div className="order-hero-card__field">
          <label htmlFor="basics-dueDate">Срок сдачи</label>
          <input
            id="basics-dueDate"
            name="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>

        <div className="order-hero-card__field order-hero-card__field--price">
          <label htmlFor="basics-customerUnitPrice">Цена за 1 шт</label>
          <div className="order-hero-card__price-row">
            <input
              id="basics-customerUnitPrice"
              name="customerUnitPrice"
              type="text"
              inputMode="decimal"
              value={customerUnitPrice}
              onChange={(e) => setCustomerUnitPrice(e.target.value)}
              placeholder="0.00"
            />
            <select
              name="customerCurrency"
              value={customerCurrency}
              onChange={(e) =>
                setCustomerCurrency(e.target.value as MoneyCurrency | '')
              }
              aria-label="Валюта"
            >
              <option value="">—</option>
              {MONEY_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {MONEY_CURRENCY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          {fieldError('customerUnitPrice') && (
            <span className="order-hero-card__field-error">
              {fieldError('customerUnitPrice')}
            </span>
          )}
        </div>

        <div className="order-hero-card__field order-hero-card__field--comment">
          <label htmlFor="basics-comment">Комментарий</label>
          <textarea
            id="basics-comment"
            name="comment"
            rows={2}
            maxLength={2000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Краткое описание заказа"
          />
        </div>

        <input type="hidden" name="customer" value={initial.customer ?? ''} />
      </div>

      <FormActions onCancel={block.cancel} />
    </form>
  );
}
