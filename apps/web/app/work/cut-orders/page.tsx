import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { OrderReadyForReleaseDto } from '@sewing/shared/cutting-tasks';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listOrdersReadyForRelease } from '@/lib/cutting-tasks-api';

export const dynamic = 'force-dynamic';

/**
 * Доска помощника раскройщика (`CUTTER_ASSISTANT`): выбор заказа для
 * выпуска паспортов.
 *
 * Заказ появляется здесь автоматически, как только раскройщик завершил
 * раскрой (`CuttingTask = DONE`) — источник `GET /api/cutting-tasks/
 * ready-for-release`. Карточки подсвечены по статусу:
 *   - «новый» (есть невыпущенные рулоны) — жёлтая полоса;
 *   - «Завершено» (все рулоны по всем размерам выпущены) — зелёная
 *     полоса + бейдж.
 * Тап по карточке ведёт на рулонный выпуск `/orders/:id/passports/new`.
 *
 * Route живёт под `/work/*`, чтобы у помощника был единый «mobile clean»
 * контекст (верхний `AppHeader` скрыт по префиксу `/work`).
 */
export default async function WorkCutOrdersPage() {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/work/cut-orders');

  let items: OrderReadyForReleaseDto[] = [];
  let error: string | null = null;
  try {
    items = await listOrdersReadyForRelease();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
    error = `[${e.code ?? 'API_ERROR'}] ${e.message}`;
  }

  // Авто-выбор: ровно один заказ, по которому ещё есть что выпускать →
  // сразу открываем выпуск, помощник не видит лишний экран.
  const pending = items.filter((o) => o.status === 'NEW');
  if (!error && pending.length === 1 && items.length === 1) {
    redirect(`/orders/${pending[0].orderId}/passports/new`);
  }

  return (
    <div className="cut-orders">
      <header className="cut-orders__head">
        <Link href="/work" className="cut-orders__back" aria-label="Назад">
          ←
        </Link>
        <h1 className="cut-orders__title">Выберите заказ</h1>
      </header>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="cut-orders__empty" role="status">
          <div className="cut-orders__empty-title">Нет заказов на выпуск</div>
          <p className="cut-orders__empty-hint">
            Когда раскройщик завершит раскрой по заказу, он появится здесь.
          </p>
          <Link href="/work" className="btn btn-block">
            Назад
          </Link>
        </div>
      )}

      {!error && items.length > 0 && (
        <ul className="cut-orders__list" aria-label="Заказы на выпуск">
          {items.map((o) => {
            const done = o.status === 'DONE';
            return (
              <li key={o.orderId}>
                <Link
                  className={
                    'cut-orders__card' +
                    ` constructor-card--status-${done ? 'done' : 'new'}`
                  }
                  href={`/orders/${o.orderId}/passports/new`}
                  prefetch={false}
                >
                  <span className="cut-orders__card-title">
                    {o.productName}
                    {done ? (
                      <span
                        className="constructor-status constructor-status--done"
                        style={{ marginLeft: '0.5rem' }}
                      >
                        Завершено
                      </span>
                    ) : null}
                  </span>
                  <span className="cut-orders__card-meta">
                    <span className="cut-orders__card-number">
                      {o.orderNumber}
                    </span>
                    {o.color ? (
                      <span className="cut-orders__card-color">· {o.color}</span>
                    ) : null}
                    <span className="cut-orders__card-color">
                      · выпущено {o.releasedPairs}/{o.totalPairs}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
