'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { useMemo, useState } from 'react';
import type { ClientDto } from '@sewing/shared/clients';
import type { CompanyDivisionDto } from '@sewing/shared/company-divisions';
import type { ProductDto, SizeDto } from '@sewing/shared/orders';
import type { RouteTemplateSummaryDto } from '@sewing/shared/routes';
import type { TechCardTemplateSummaryDto } from '@sewing/shared/tech-cards';
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
  /**
   * Активные шаблоны техкарт (см. `docs/domain.md §«Техкарты»`,
   * ADR-0022). Список может быть пустым — тогда select скрыт и заказ
   * создаётся без snapshot материалов/внешних потребностей.
   */
  techCards: TechCardTemplateSummaryDto[];
  /**
   * Активные карточки подразделений (см.
   * `docs/domain.md §«Подразделения заказа»`) для select-а
   * `companyDivisionId`. Если список пуст (новая инсталляция без
   * seed-а) — поле «Подразделение» скрывается, заказ создаётся
   * без привязки.
   */
  companyDivisions: CompanyDivisionDto[];
  /**
   * Этап «Клиент — обязательный атрибут заказа»: активные карточки
   * `Client` для обязательного селекта «Клиент». Если справочник пуст
   * (новая инсталляция) — селект показываем всё равно, с подсказкой
   * «добавьте клиента в разделе «Клиенты»»: создать заказ без клиента
   * всё равно нельзя, и лучше сказать об этом прямо в форме, чем
   * молча спрятать поле.
   */
  clients: ClientDto[];
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

export function NewOrderForm({
  sizes,
  products,
  routeTemplates,
  techCards,
  companyDivisions,
  clients,
  today,
}: Props) {
  const [state, formAction] = useFormState(createOrderAction, initialState);
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  // Дефолт — карточка с `code = OTHER` (B2B).
  const defaultCompanyDivisionId =
    companyDivisions.find((d) => d.code === 'OTHER')?.id ??
    companyDivisions[0]?.id ??
    '';
  const [companyDivisionId, setCompanyDivisionId] = useState<string>(
    defaultCompanyDivisionId,
  );

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

      {/*
        Этап «Клиент — обязательный атрибут заказа»: тот же контракт, что
        в admin-форме `/admin/orders/new` — `required`-селект без варианта
        «без клиента». Пустое значение отбивает `createOrderAction`,
        backend — `ORDER_CLIENT_REQUIRED` на «Перевести в расчёт».
      */}
      <div className="form-row">
        <label htmlFor="clientId">Клиент *</label>
        <div>
          <select id="clientId" name="clientId" required aria-required="true">
            <option value="">— выберите клиента —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="hint">
            {clients.length === 0
              ? 'Список клиентов пуст — добавьте клиента в разделе «Клиенты».'
              : 'Обязательное поле — заказ всегда принадлежит клиенту.'}
          </div>
        </div>
      </div>

      {companyDivisions.length > 0 && (
        <div className="form-row">
          <label htmlFor="companyDivisionId">Подразделение</label>
          <div>
            <select
              id="companyDivisionId"
              name="companyDivisionId"
              value={companyDivisionId}
              onChange={(e) => setCompanyDivisionId(e.target.value)}
              required
            >
              {companyDivisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <div className="hint">
              Определяет, на каком экране /shopfloor/display будет
              видно заказ. По умолчанию — «B2B».
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

      {techCards.length > 0 && (
        <div className="form-row">
          <label htmlFor="techCardId">Техкарта</label>
          <div>
            <select id="techCardId" name="techCardId" defaultValue="">
              <option value="">— без техкарты —</option>
              {techCards.map((tc) => (
                <option key={tc.id} value={tc.id}>
                  {tc.name} ({tc.code})
                </option>
              ))}
            </select>
            <div className="hint">
              Опционально. Строки материалов и внешних подрядных размещений
              зафиксируются snapshot-ом при запуске заказа в производство —
              план потребностей на карточке заказа станет read-only и
              перестанет зависеть от поздних правок шаблона.
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
