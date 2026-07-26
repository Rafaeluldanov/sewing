'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type {
  OrderDetailDto,
  ProductDto,
  SizeDto,
} from '@sewing/shared/orders';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { PatternListItemDto } from '@sewing/shared/patterns';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
import { AdminDateField } from '@/components/admin/admin-date-field';
import { updateOrderAction, type FormActionState } from '../../actions';

interface Props {
  order: OrderDetailDto;
  sizes: SizeDto[];
  products: ProductDto[];
  /**
   * Активные шаблоны маршрутов; при пустом массиве select прячется,
   * привязка не сбрасывается (поле `routeTemplateId` в форму не
   * попадёт → action оставит значение как есть).
   */
  routeTemplates: RouteTemplateSummaryDto[];
  /**
   * Активные шаблоны техкарт. Семантика и UX идентичны
   * `routeTemplates`. Текущая привязка `order.techCardId` всегда
   * показывается в селекте, даже если шаблон уже деактивирован.
   */
  techCards: TechCardTemplateSummaryDto[];
  /**
   * Активные карточки клиентов (см. `model Client`). Селект клиента
   * показывается только если массив непустой; текущая привязка
   * заказа всегда добавляется отдельной опцией, даже если клиент
   * уже архивирован.
   */
  clients: ClientDto[];
  /**
   * Soft-pattern MVP (этап 2 «Лекала»): активные карточки лекал
   * (плюс автоматически добавленная архивная карточка, если она
   * уже привязана к заказу). См. `page.tsx` рядом.
   */
  patterns: PatternListItemDto[];
  /**
   * Активные карточки подразделений (см.
   * `docs/domain.md §«Подразделения заказа»`). Текущая привязка
   * заказа всегда добавляется отдельной опцией ниже, даже если
   * карточка архивирована.
   */
  companyDivisions: CompanyDivisionDto[];
}

const initialState: FormActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? 'Сохраняем…' : 'Сохранить'}
    </button>
  );
}

export function EditOrderForm({
  order,
  sizes,
  products,
  routeTemplates,
  techCards,
  clients,
  patterns,
  companyDivisions,
}: Props) {
  const action = updateOrderAction.bind(null, order.id);
  const [state, formAction] = useFormState(action, initialState);
  const [productId, setProductId] = useState(order.productId ?? '');
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    order.companyDivisionId ?? '',
  );

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [productId, products],
  );

  const qtyByCurrent = useMemo(() => {
    const map: Record<string, number> = {};
    for (const it of order.items) map[it.sizeId] = it.qtyPlan;
    return map;
  }, [order.items]);

  const orderDateValue = order.orderDate.slice(0, 10);
  const dueDateValue = order.dueDate ? order.dueDate.slice(0, 10) : '';

  const currentClient = order.client;
  const showClientSelect = clients.length > 0 || Boolean(currentClient);

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}

      <div className="form-row">
        <label htmlFor="orderDate">Дата заказа</label>
        <div>
          <AdminDateField
            id="orderDate"
            name="orderDate"
            required
            defaultValue={orderDateValue}
          />
        </div>
      </div>

      <div className="form-row">
        <label htmlFor="dueDate">Срок сдачи</label>
        <div>
          <AdminDateField
            id="dueDate"
            name="dueDate"
            defaultValue={dueDateValue}
          />
          <div className="hint">
            Когда заказ должен быть готов. Поле опциональное.
          </div>
        </div>
      </div>

      {/*
        Этап «Клиент — обязательный атрибут заказа»: селект `required`,
        варианта «без клиента» нет. Пустое значение отбивает
        `updateOrderAction`, backend — `ORDER_CLIENT_REQUIRED`.
      */}
      {showClientSelect && (
        <div className="form-row">
          <label htmlFor="clientId">Клиент *</label>
          <div>
            <select
              id="clientId"
              name="clientId"
              defaultValue={currentClient?.id ?? ''}
              required
              aria-required="true"
            >
              <option value="">— выберите клиента —</option>
              {/*
                Если у заказа уже привязан клиент, которого нет в
                списке активных (архивирован), всё равно показываем
                его опцией — иначе при сохранении формы привязка
                пропадёт без явного действия пользователя.
              */}
              {currentClient &&
                !clients.some((c) => c.id === currentClient.id) && (
                  <option value={currentClient.id}>
                    {currentClient.name} — архивный
                  </option>
                )}
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.isActive ? '' : ' — архивный'}
                </option>
              ))}
            </select>
            <div className="hint">
              Обязательное поле — заказ всегда принадлежит клиенту.
              Свободный текст `customer` остался только для
              совместимости со старым flow.
            </div>
          </div>
        </div>
      )}

      <div className="form-row">
        <label htmlFor="productId">Изделие</label>
        <div>
          <select
            id="productId"
            name="productId"
            required
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.color})
              </option>
            ))}
          </select>
        </div>
      </div>

      {(companyDivisions.length > 0 || order.companyDivisionId) && (
        <div className="form-row">
          <label htmlFor="companyDivisionId">Подразделение</label>
          <div>
            <select
              id="companyDivisionId"
              name="companyDivisionId"
              value={companyDivisionId}
              onChange={(e) => setCompanyDivisionId(e.target.value)}
            >
              <option value="">— без подразделения —</option>
              {/*
                Если у заказа уже привязано архивное подразделение
                (нет в активном списке), показываем его отдельной
                опцией — иначе FK обнулится при сохранении формы без
                явного действия пользователя.
              */}
              {order.companyDivisionId &&
                order.companyDivision &&
                !companyDivisions.some(
                  (d) => d.id === order.companyDivisionId,
                ) && (
                  <option value={order.companyDivisionId}>
                    {order.companyDivision.name} — архивное
                  </option>
                )}
              {companyDivisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isActive ? '' : ' — архив'}
                </option>
              ))}
            </select>
            <div className="hint">
              Менять можно только пока заказ в DRAFT.
            </div>
          </div>
        </div>
      )}

      <div className="form-row">
        <label htmlFor="color">Цвет</label>
        <div>
          <input
            id="color"
            name="color"
            type="text"
            defaultValue={order.color ?? selectedProduct?.color ?? ''}
          />
        </div>
      </div>

      {(routeTemplates.length > 0 || order.routeTemplateId) && (
        <div className="form-row">
          <label htmlFor="routeTemplateId">Шаблон маршрута</label>
          <div>
            <select
              id="routeTemplateId"
              name="routeTemplateId"
              defaultValue={order.routeTemplateId ?? ''}
            >
              <option value="">— без маршрута —</option>
              {/*
                Если у заказа уже выбран шаблон, которого нет в списке
                активных (например, шаблон деактивировали), всё равно
                показываем его как опцию — иначе при сохранении формы
                привязка пропадёт без явного действия пользователя.
              */}
              {order.routeTemplateId &&
                !routeTemplates.some(
                  (t) => t.id === order.routeTemplateId,
                ) && (
                  <option value={order.routeTemplateId}>
                    {order.routeTemplateName ?? 'Текущий шаблон'} (
                    {order.routeTemplateCode ?? '—'}) — неактивен
                  </option>
                )}
              {routeTemplates.map((tpl) => (
                <option
                  key={tpl.id}
                  value={tpl.id}
                  disabled={tpl.stepsCount === 0}
                >
                  {tpl.name} ({tpl.code})
                  {tpl.stepsCount === 0 ? ' — нет шагов' : ''}
                </option>
              ))}
            </select>
            <div className="hint">
              Менять шаблон можно только до запуска заказа в производство —
              после `start()` маршрут фиксируется snapshot-ом.
            </div>
          </div>
        </div>
      )}

      {(techCards.length > 0 || order.techCardId) && (
        <div className="form-row">
          <label htmlFor="techCardId">Техкарта</label>
          <div>
            <select
              id="techCardId"
              name="techCardId"
              defaultValue={order.techCardId ?? ''}
            >
              <option value="">— без техкарты —</option>
              {/*
                Если у заказа уже выбрана техкарта, которой нет в списке
                активных (например, её деактивировали), всё равно
                показываем её как опцию — иначе при сохранении формы
                привязка пропадёт без явного действия пользователя.
              */}
              {order.techCardId &&
                !techCards.some((t) => t.id === order.techCardId) && (
                  <option value={order.techCardId}>
                    {order.techCardName ?? 'Текущая техкарта'} (
                    {order.techCardCode ?? '—'}) — неактивна
                  </option>
                )}
              {techCards.map((tc) => (
                <option key={tc.id} value={tc.id}>
                  {tc.name} ({tc.code})
                  {tc.isActive ? '' : ' — неактивна'}
                </option>
              ))}
            </select>
            <div className="hint">
              Менять техкарту можно только до запуска заказа в производство —
              после `start()` план потребностей фиксируется snapshot-ом.
            </div>
          </div>
        </div>
      )}

      {/*
        Soft-pattern MVP (этап 2 «Лекала»): селект лекала. Семантика
        и UX идентичны techCard / routeTemplate. Поле опциональное —
        старые заказы без лекала остаются валидными.
      */}
      {(patterns.length > 0 || order.patternItemId) && (
        <div className="form-row">
          <label htmlFor="patternItemId">Лекало</label>
          <div>
            <select
              id="patternItemId"
              name="patternItemId"
              defaultValue={order.patternItemId ?? ''}
            >
              <option value="">— без лекала —</option>
              {order.patternItemId &&
                !patterns.some((p) => p.id === order.patternItemId) && (
                  <option value={order.patternItemId}>
                    {order.patternName ??
                      order.patternNameSnapshot ??
                      'Текущее лекало'}
                    {order.patternArticle ?? order.patternArticleSnapshot
                      ? ` (${order.patternArticle ?? order.patternArticleSnapshot})`
                      : ''}{' '}
                    — архивное
                  </option>
                )}
              {patterns.map((pt) => (
                <option key={pt.id} value={pt.id}>
                  {pt.name} ({pt.article})
                  {pt.status !== 'ACTIVE' ? ` — ${pt.status}` : ''}
                </option>
              ))}
            </select>
            <div className="hint">
              Менять лекало можно только до запуска заказа в производство —
              после `start()` поля лекала фиксируются snapshot-ом.
            </div>
          </div>
        </div>
      )}

      <div className="form-row">
        <label htmlFor="comment">Комментарий</label>
        <div>
          <textarea
            id="comment"
            name="comment"
            defaultValue={order.comment ?? ''}
            maxLength={2000}
          />
        </div>
      </div>

      <div className="form-row">
        <label>Размеры и количества</label>
        <div>
          <div className="size-grid">
            {sizes.map((s) => (
              <label key={s.id} title={s.code}>
                <span>{s.code}</span>
                <input
                  type="number"
                  name={`qty[${s.id}]`}
                  min={0}
                  step={1}
                  inputMode="numeric"
                  defaultValue={qtyByCurrent[s.id] ?? ''}
                />
              </label>
            ))}
          </div>
          <div className="hint">
            Пустые размеры будут удалены из заказа. В заказ попадают только
            количества &gt; 0.
          </div>
        </div>
      </div>

      <div className="actions-row">
        <SubmitButton />
        <Link className="btn btn-ghost" href={`/orders/${order.id}`}>
          Отмена
        </Link>
      </div>
    </form>
  );
}
