import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { OrderListItemDto } from '@sewing/shared/orders';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listOrders } from '@/lib/orders-api';

export const dynamic = 'force-dynamic';

/**
 * Упрощённый «выбор заказа для выпуска паспорта» для роли
 * CUTTER_ASSISTANT (см. ТЗ «упрощение UX помощника раскройщика»).
 *
 * Поведение:
 *   - один заказ в `IN_PRODUCTION` → сразу редиректим на
 *     `/orders/:id/passports/new`, помощник вообще не видит этот
 *     экран (выбора-то нет);
 *   - несколько заказов → показываем короткий список карточек только
 *     с названием позиции/изделия и номером заказа; тап по карточке
 *     ведёт на тот же `/orders/:id/passports/new`;
 *   - ни одного → аккуратный empty state «Нет заказов на раскрое».
 *
 * Источник истины — backend: `GET /api/orders?status=IN_PRODUCTION`
 * уже разрешён `CUTTER_ASSISTANT` (см. `OrdersController.list` и
 * `docs/api.md §4`). Никаких новых endpoint-ов не заводим.
 *
 * Этот route намеренно живёт под `/work/*`, чтобы у CUTTER_ASSISTANT
 * был единый «mobile clean» контекст: верхний тёмный header скрывает
 * `AppHeader` именно по префиксу `/work` (и по точному пути выпуска
 * паспорта).
 */
export default async function WorkCutOrdersPage({
  searchParams,
}: {
  searchParams?: { mode?: string };
}) {
  // Middleware уже редиректит анонимов, но дополнительно сверяемся:
  // если cookie неактуальна, пусть лучше будет явный редирект, а не
  // пустой UI с непонятной ошибкой 401 в консоли.
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/work/cut-orders');

  // Демо-режим серийного выпуска паспортов отличается только конечной
  // страницей: вместо `/passports/new` ведём на `/passports/new-demo`.
  // Логика выбора заказа (один/много/ни одного) не меняется.
  const isDemo = searchParams?.mode === 'demo';
  const newPassportPath = isDemo ? 'new-demo' : 'new';

  let items: OrderListItemDto[] = [];
  let error: string | null = null;
  try {
    // Берём с запасом (200 — потолок схемы), но реально на пилоте в
    // `IN_PRODUCTION` одновременно лежит < 10 заказов. Сортировка по
    // `createdAt DESC` уже выставлена бэкендом по умолчанию.
    const data = await listOrders({ status: 'IN_PRODUCTION', pageSize: 200 });
    items = data.items;
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    error = `[${e.code ?? 'API_ERROR'}] ${e.message}`;
  }

  // Авто-выбор: один заказ → сразу выпуск паспорта.
  if (!error && items.length === 1) {
    redirect(`/orders/${items[0].id}/passports/${newPassportPath}`);
  }

  return (
    <div className="cut-orders">
      <header className="cut-orders__head">
        <Link href="/work" className="cut-orders__back" aria-label="Назад">
          ←
        </Link>
        <h1 className="cut-orders__title">
          {isDemo ? 'Выберите заказ (демо)' : 'Выберите заказ'}
        </h1>
      </header>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="cut-orders__empty" role="status">
          <div className="cut-orders__empty-title">Нет заказов на раскрое</div>
          <p className="cut-orders__empty-hint">
            Когда менеджер запустит заказ в производство, он появится здесь.
          </p>
          <Link href="/work" className="btn btn-block">
            Назад
          </Link>
        </div>
      )}

      {!error && items.length > 1 && (
        <ul className="cut-orders__list" aria-label="Заказы на раскрое">
          {items.map((o) => (
            <li key={o.id}>
              <Link
                className="cut-orders__card"
                href={`/orders/${o.id}/passports/${newPassportPath}`}
                prefetch={false}
              >
                <span className="cut-orders__card-title">
                  {o.productName ?? 'Без изделия'}
                </span>
                <span className="cut-orders__card-meta">
                  <span className="cut-orders__card-number">{o.number}</span>
                  {o.color ? (
                    <span className="cut-orders__card-color">· {o.color}</span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
