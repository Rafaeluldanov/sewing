'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type {
  OrderDetailDto,
  ProductDto,
  SizeDto,
} from '@sewing/shared/orders';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
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
}: Props) {
  const action = updateOrderAction.bind(null, order.id);
  const [state, formAction] = useFormState(action, initialState);
  const [productId, setProductId] = useState(order.productId ?? '');

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

  return (
    <form action={formAction} className="card">
      {state.error && <div className="error-box">{state.error}</div>}

      <div className="form-row">
        <label htmlFor="orderDate">Дата заказа</label>
        <div>
          <input
            id="orderDate"
            name="orderDate"
            type="date"
            required
            defaultValue={orderDateValue}
          />
        </div>
      </div>

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
