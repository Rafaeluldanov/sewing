'use client';

/**
 * `RatesAmendmentTab` — вкладка «Расценки» окна правки заказа
 * («Изменить маршрут» / «Изменить в производстве»).
 *
 * Зачем: состав маршрута и деньги маршрута правились на РАЗНЫХ
 * поверхностях — холст в окне и отдельный редактор во вкладке «Операции»,
 * хотя окно правки у них одно и то же (всё, кроме `DONE`/`CANCELLED`).
 * Здесь тот же редактор (`OrderRouteOverridesEditor`, ручка
 * `PUT /orders/:id/route-overrides`) встроен в окно, чтобы «поправить
 * маршрут и стоимость операции» делалось в одном месте.
 *
 * Сохранений всё равно два и они независимы: холст шлёт весь маршрут
 * (`PUT .../amendments/route`), редактор — переопределения по шагам. Так и
 * задумано: у нового шага ещё нет `OrderRouteStep.id`, вешать на него
 * расценку до сохранения структуры не на что.
 *
 * Права — как у остальной правки денег: `ADMIN`/`SHOP_MANAGER`. Вкладку
 * подставляет вызывающая сторона (вкладка «Производство» карточки заказа);
 * в кабинете мастера холст живёт без неё.
 */

import {
  OrderRouteOverridesEditor,
  type RouteOverrideEditorSize,
  type RouteOverrideEditorStep,
} from '@/components/orders/operations/order-route-overrides-editor';

export interface RatesAmendmentState {
  sizes: RouteOverrideEditorSize[];
  steps: RouteOverrideEditorStep[];
}

interface Props {
  orderId: string;
  state: RatesAmendmentState;
  onClose: () => void;
}

export function RatesAmendmentTab({ orderId, state, onClose }: Props) {
  return (
    <div data-testid="amend-rates-tab">
      <p className="admin-muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
        Расценки и нормы действуют только в этом заказе и не меняют справочник
        операций. Уже начисленная выработка задним числом не пересчитывается, а
        плановая себестоимость обновляется только до запуска производства.
      </p>
      <OrderRouteOverridesEditor
        orderId={orderId}
        sizes={state.sizes}
        steps={state.steps}
        variant="embedded"
        onCancel={onClose}
        onSaved={onClose}
      />
    </div>
  );
}
