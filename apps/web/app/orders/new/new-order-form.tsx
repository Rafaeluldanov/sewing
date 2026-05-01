'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type { ProductDto, SizeDto } from '@sewing/shared/orders';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import { createOrderAction, type FormActionState } from '../actions';

interface Props {
  sizes: SizeDto[];
  products: ProductDto[];
  /**
   * Активные шаблоны маршрута производства (см. `docs/domain.md
   * §«Маршруты производства»`). На MVP список может быть пустым —
   * тогда select просто скрывается, и заказ создаётся без маршрута
   * (полный backward-compatibility со старым flow).
   */
  routeTemplates: RouteTemplateSummaryDto[];
  today: string;
}

const initialState: FormActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? 'Сохранение…' : 'Создать заказ'}
    </button>
  );
}

export function NewOrderForm({ sizes, products, routeTemplates, today }: Props) {
  const [state, formAction] = useFormState(createOrderAction, initialState);
  const [productId, setProductId] = useState(products[0]?.id ?? '');

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === productId),
    [productId, products],
  );

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
            defaultValue={today}
          />
          <div className="hint">
            Дата, на которую оформлен заказ. Иммутабельна после запуска в
            производство.
          </div>
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
            {products.length === 0 && <option value="">— нет изделий —</option>}
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
            defaultValue={selectedProduct?.color ?? ''}
            placeholder="По умолчанию — цвет изделия"
          />
          <div className="hint">
            Можно оставить пустым — подставим цвет из изделия.
          </div>
        </div>
      </div>

      {routeTemplates.length > 0 && (
        <div className="form-row">
          <label htmlFor="routeTemplateId">Шаблон маршрута</label>
          <div>
            <select
              id="routeTemplateId"
              name="routeTemplateId"
              defaultValue=""
            >
              <option value="">— без маршрута —</option>
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
              Опционально. Шаги маршрута зафиксируются snapshot-ом при запуске
              заказа в производство — UI на /work будет подсказывать швее
              текущий и следующий шаг. Это «мягкий» маршрут: scan «не туда»
              не блокируется.
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
            maxLength={2000}
            placeholder="Необязательно"
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
                  placeholder="0"
                />
              </label>
            ))}
          </div>
          <div className="hint">
            Пустые размеры не попадут в заказ. В заказ уходят только
            количества &gt; 0.
          </div>
        </div>
      </div>

      <div className="actions-row">
        <SubmitButton />
        <a href="/orders" className="btn btn-ghost">
          Отмена
        </a>
      </div>
    </form>
  );
}
