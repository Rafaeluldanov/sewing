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
 * Заказ появляется здесь автоматически, как только раскройщик ЗАКРЫЛ ХОТЯ
 * БЫ ОДИН РАСКЛАД («Расклад готов») — дожидаться завершения всего раскроя
 * больше не нужно. Источник `GET /api/cutting-tasks/ready-for-release`.
 * Карточки подсвечены по статусу:
 *   - «новый» (есть невыпущенные рулоны по закрытым раскладам) — жёлтая;
 *   - «Ждём расклад» (по закрытым выпущено всё, раскрой продолжается) —
 *     синяя: печатать нечего, заказ вернётся сам;
 *   - «Завершено» (раскрой завершён и выпущены все паспорта) — зелёная
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

  // Авто-выбор: ровно один заказ, по которому ЕСТЬ что выпускать → сразу
  // открываем выпуск, помощник не видит лишний экран.
  //
  // Частичное завершение раскроя: строка `WAITING` («по закрытым раскладам
  // всё выпущено, раскрой продолжается») в авто-выборе не участвует — иначе
  // помощник провалился бы в форму, где печатать нечего. Поэтому условие
  // смотрит на количество NEW-строк, а не на длину всего списка.
  const pending = items.filter((o) => o.status === 'NEW');
  if (!error && pending.length === 1) {
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
            Когда раскройщик закроет первый расклад по заказу, он появится
            здесь — дожидаться конца раскроя не нужно.
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
            // «Ждём расклад»: печатать нечего, но заказ не добит — раскрой
            // продолжается. Отдельный тон, чтобы помощник не принял строку
            // ни за «выпускай» (жёлтая), ни за «готово» (зелёная).
            const waiting = o.status === 'WAITING';
            const tone = done ? 'done' : waiting ? 'in_progress' : 'new';
            return (
              <li key={o.orderId}>
                <Link
                  className={
                    'cut-orders__card' + ` constructor-card--status-${tone}`
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
                    ) : waiting ? (
                      <span
                        className="constructor-status constructor-status--in_progress"
                        style={{ marginLeft: '0.5rem' }}
                      >
                        Ждём расклад
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
                      · выпущено {o.releasedPassports}/{o.totalPassports}{' '}
                      паспортов
                    </span>
                    {o.cuttingInProgress ? (
                      <span className="cut-orders__card-color">
                        · раскрой идёт, закрыто раскладов {o.laysClosed} из{' '}
                        {o.laysTotal}
                      </span>
                    ) : null}
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
