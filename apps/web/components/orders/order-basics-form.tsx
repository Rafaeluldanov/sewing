'use client';

/**
 * `OrderBasicsForm` — inline-форма «Сохранить основное» в hero
 * карточки заказа `/admin/orders/[id]`.
 *
 * Содержит редактируемые управленческие поля заказа:
 *   - подразделение (`companyDivisionId` → `CompanyDivision`);
 *   - срок сдачи (`dueDate`);
 *   - клиент (`clientId`);
 *   - заказчик free-text (`customer`) — для совместимости со старым flow;
 *   - цена за 1 изделие (`customerUnitPrice`);
 *   - валюта продажи (`customerCurrency`);
 *   - комментарий (`comment`).
 *
 * Сабмит уходит в `updateOrderBasicsAction`, который через
 * существующий `updateOrder` шлёт PATCH `/api/orders/:id` с
 * подмножеством полей `UpdateOrderDto`. «Опасные» поля
 * (items/route/techCard/pattern/status) сюда не входят — их
 * редактирует отдельная форма `/admin/orders/[id]/edit`.
 *
 * UX:
 *   - terminal-статусы (DONE/CANCELLED) → форма disabled, но
 *     поля остаются видимыми и значения подставлены;
 *   - на остальных статусах поля доступны (backend не блокирует
 *     basics-поля независимо от статуса);
 *   - после успешного сабмита показываем `successMessage` рядом
 *     с кнопкой; ошибки backend-а — в общий error-box над формой.
 *
 * Никакого autosave: пользователь явно нажимает «Сохранить
 * основное».
 */

import { useFormState, useFormStatus } from 'react-dom';
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { OrderStatus } from '@sewing/shared/orders';
import {
  MONEY_CURRENCIES,
  MONEY_CURRENCY_LABELS,
  type MoneyCurrency,
} from '@sewing/shared/money';
import {
  updateOrderBasicsAction,
  type UpdateOrderBasicsActionState,
} from '@/app/admin/orders/[id]/basic-actions';

interface Props {
  orderId: string;
  status: OrderStatus;
  initial: {
    /**
     * Текущая привязка заказа к `CompanyDivision`. `null` — заказ
     * без подразделения.
     */
    companyDivisionId: string | null;
    /**
     * Чтобы UI мог отрисовать архивную / уже невидимую в активном
     * списке карточку, передаём её краткие реквизиты сюда.
     */
    companyDivision: { id: string; code: string; name: string } | null;
    dueDate: string | null;
    clientId: string | null;
    customer: string | null;
    customerUnitPrice: string | number | null | undefined;
    customerCurrency: MoneyCurrency | null | undefined;
    comment: string | null;
  };
  clients: ClientDto[];
  /**
   * Активные карточки `CompanyDivision` для select-а. Если у заказа
   * уже привязана архивная карточка (нет в активном списке), UI
   * добавит её отдельной опцией ниже — иначе при сохранении
   * привязка пропала бы без явного действия пользователя.
   */
  companyDivisions: CompanyDivisionDto[];
}

const initialState: UpdateOrderBasicsActionState = {};

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="admin-btn admin-btn--primary"
      disabled={disabled || pending}
    >
      <Save size={14} strokeWidth={1.7} aria-hidden />
      {pending ? 'Сохранение…' : 'Сохранить основное'}
    </button>
  );
}

export function OrderBasicsForm({
  orderId,
  status,
  initial,
  clients,
  companyDivisions,
}: Props) {
  const action = updateOrderBasicsAction.bind(null, orderId);
  const [state, formAction] = useFormState(action, initialState);

  const isTerminal = status === 'DONE' || status === 'CANCELLED';

  const dueDateInitial = initial.dueDate ? initial.dueDate.slice(0, 10) : '';
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    initial.companyDivisionId ?? '',
  );
  const [dueDate, setDueDate] = useState<string>(dueDateInitial);
  const [clientId, setClientId] = useState<string>(initial.clientId ?? '');
  const [customerUnitPrice, setCustomerUnitPrice] = useState<string>(
    initial.customerUnitPrice == null ? '' : String(initial.customerUnitPrice),
  );
  const [customerCurrency, setCustomerCurrency] = useState<MoneyCurrency | ''>(
    initial.customerCurrency ?? '',
  );
  const [comment, setComment] = useState<string>(initial.comment ?? '');
  const [savedToast, setSavedToast] = useState<string | null>(null);

  useEffect(() => {
    if (state.ok && state.successMessage) {
      setSavedToast(state.successMessage);
      const timer = setTimeout(() => setSavedToast(null), 3000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state.ok, state.successMessage]);

  const showCurrentClientArchivedOption =
    initial.clientId &&
    !clients.some((c) => c.id === initial.clientId);

  const showCurrentDivisionArchivedOption =
    initial.companyDivisionId &&
    !companyDivisions.some((d) => d.id === initial.companyDivisionId);

  const fieldError = (key: string): string | undefined =>
    state.fieldErrors?.[key];

  return (
    <form
      action={formAction}
      className="order-hero-card__basic-form-inner"
      aria-label="Основные поля заказа"
    >
      {state.error && (
        <div className="error-box" role="alert">
          {state.error}
        </div>
      )}

      <div className="order-hero-card__basic-grid">
        <div className="order-hero-card__field">
          <label htmlFor="basics-companyDivisionId">Подразделение</label>
          <select
            id="basics-companyDivisionId"
            name="companyDivisionId"
            value={companyDivisionId}
            onChange={(e) => setCompanyDivisionId(e.target.value)}
            disabled={isTerminal}
          >
            <option value="">— без подразделения —</option>
            {/*
              Если у заказа уже привязана архивная (или не входящая в
              активный список) карточка — показываем её отдельной
              опцией, иначе при сохранении формы FK обнулится без
              явного действия пользователя.
            */}
            {showCurrentDivisionArchivedOption &&
              initial.companyDivision && (
                <option value={initial.companyDivision.id}>
                  {initial.companyDivision.name} — архивный
                </option>
              )}
            {companyDivisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isActive ? '' : ' — архив'}
              </option>
            ))}
          </select>
        </div>

        <div className="order-hero-card__field">
          <label htmlFor="basics-dueDate">Срок сдачи</label>
          <input
            id="basics-dueDate"
            name="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            disabled={isTerminal}
          />
        </div>

        <div className="order-hero-card__field">
          <label htmlFor="basics-clientId">Клиент</label>
          <select
            id="basics-clientId"
            name="clientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            disabled={isTerminal}
          >
            <option value="">— без клиента —</option>
            {showCurrentClientArchivedOption && initial.clientId && (
              <option value={initial.clientId}>— архивный клиент —</option>
            )}
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.isActive ? '' : ' — архив'}
              </option>
            ))}
          </select>
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
              disabled={isTerminal}
            />
            <select
              name="customerCurrency"
              value={customerCurrency}
              onChange={(e) =>
                setCustomerCurrency(e.target.value as MoneyCurrency | '')
              }
              aria-label="Валюта"
              disabled={isTerminal}
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
            disabled={isTerminal}
          />
        </div>

        <input type="hidden" name="customer" value={initial.customer ?? ''} />
      </div>

      <div className="order-hero-card__basic-form-actions">
        <SubmitButton disabled={isTerminal} />
        {savedToast && (
          <span className="order-hero-card__basic-form-toast" role="status">
            {savedToast}
          </span>
        )}
        {isTerminal && (
          <span className="admin-muted" style={{ fontSize: '0.78rem' }}>
            Заказ {status === 'DONE' ? 'завершён' : 'отменён'} — поля
            недоступны для редактирования.
          </span>
        )}
      </div>
    </form>
  );
}
