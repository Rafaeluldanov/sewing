import Link from 'next/link';
import type { OrderReadyForReleaseDto } from '@sewing/shared/cutting-tasks';
import { ApiRequestError, errorText } from '@/lib/api';
import { listOrdersReadyForRelease } from '@/lib/cutting-tasks-api';
import { requireActiveCutterShift } from '../require-shift';

export const dynamic = 'force-dynamic';

/**
 * Вкладка «Выпуск» кабинета раскройщика — ОЧЕРЕДЬ заказов, по которым можно
 * печатать паспорта. Серверный компонент.
 *
 * Источник данных один — `GET /api/cutting-tasks/ready-for-release`
 * (`listOrdersReadyForRelease`): заказ попадает в очередь, как только
 * раскройщик ЗАКРЫЛ ХОТЯ БЫ ОДИН расклад кнопкой «Расклад готов»
 * (`CuttingTaskLay.completedAt`). Дожидаться конца раскроя не нужно — это
 * главный смысл вкладки: настилы идут один за другим, а паспорта по готовым
 * раскладам печатаются параллельно.
 *
 * Три состояния строки (`OrderReadyForReleaseDto.status`) — и они значат
 * РАЗНОЕ действие, поэтому различаются и цветом полосы, и кликабельностью:
 *   - `NEW` — жёлтая полоса, бейдж «N паспортов» (сколько ещё не выпущено
 *     по ЗАКРЫТЫМ раскладам). Кликабельна: иди печатай;
 *   - `WAITING` — синяя полоса, бейдж-статус «Ждём расклад». По закрытым
 *     раскладам выпущено всё, но раскрой продолжается. НЕ кликабельна:
 *     печатать нечего, заказ вернётся в `NEW` сам после следующего
 *     «Расклад готов» — тап в форму, где ноль рулонов, только путает;
 *   - `DONE` — зелёная полоса, статус «Завершено». Кликабельна для
 *     повторной печати (потерянный/испорченный паспорт).
 *
 * Клик ведёт на `/cutter/release/[orderId]` — форму выпуска по раскладу.
 *
 * Отличие от доски помощника `/work/cut-orders`: здесь НЕТ авто-редиректа
 * при единственном заказе. Раскройщик пришёл на вкладку осознанно и должен
 * видеть очередь целиком (и вернуться на неё после печати), а помощника
 * авто-выбор экономит один тап на его единственном маршруте.
 *
 * Аутентификация и RBAC — на уровне `apps/web/app/cutter/layout.tsx`
 * (`canSeeCutter` + redirect); вкладки сверху рисует тот же layout, поэтому
 * своей шапки с кнопкой «Назад» у страницы нет. Загрузка fail-soft: сбой
 * API показываем баннером, страница не падает.
 */

/** Русское склонение «паспорт»: 1 паспорт, 2 паспорта, 5 паспортов. */
function pluralPassports(count: number): string {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return 'паспортов';
  if (n1 > 1 && n1 < 5) return 'паспорта';
  if (n1 === 1) return 'паспорт';
  return 'паспортов';
}

export default async function CutterReleaseQueuePage() {
  // Вкладка доступна только в активной смене — см. `require-shift.ts`.
  await requireActiveCutterShift();

  let items: OrderReadyForReleaseDto[] = [];
  let error: string | null = null;
  try {
    items = await listOrdersReadyForRelease();
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить очередь выпуска';
  }

  return (
    <div className="cut-orders">
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {!error && items.length === 0 && (
        <div className="cut-orders__empty" role="status">
          <div className="cut-orders__empty-title">Нет заказов на выпуск</div>
          <p className="cut-orders__empty-hint">
            Когда вы закроете первый расклад кнопкой «Расклад готов», заказ
            появится здесь — дожидаться конца раскроя не нужно.
          </p>
        </div>
      )}

      {!error && items.length > 0 && (
        <ul className="cut-orders__list" aria-label="Заказы на выпуск">
          {items.map((o) => {
            const done = o.status === 'DONE';
            // «Ждём расклад» — единственное НЕкликабельное состояние: по
            // закрытым раскладам выпущено всё, печатать нечего.
            const waiting = o.status === 'WAITING';
            const tone = done ? 'done' : waiting ? 'in_progress' : 'new';
            // Сколько паспортов ждут печати ПО ЗАКРЫТЫМ раскладам. Для `NEW`
            // всегда > 0 (это и есть условие статуса на backend), но считаем
            // через Math.max, чтобы рассинхрон снимка не дал «-1 паспорт».
            const pending = Math.max(0, o.totalPassports - o.releasedPassports);
            const title = o.color
              ? `${o.productName} · ${o.color}`
              : o.productName;

            const body = (
              <>
                <span className="cutter-release-queue__card-head">
                  <span className="cut-orders__card-title">{title}</span>
                  {done ? (
                    <span className="constructor-status constructor-status--done">
                      Завершено
                    </span>
                  ) : waiting ? (
                    <span className="constructor-status constructor-status--in_progress">
                      Ждём расклад
                    </span>
                  ) : (
                    <span className="constructor-status constructor-status--new">
                      {pending} {pluralPassports(pending)}
                    </span>
                  )}
                </span>
                <span className="cut-orders__card-meta">
                  <span className="cut-orders__card-number">
                    {o.orderNumber}
                  </span>
                  <span className="cut-orders__card-color">
                    · выпущено {o.releasedPassports}/{o.totalPassports}{' '}
                    паспортов
                  </span>
                </span>
                {o.cuttingInProgress ? (
                  <span className="cut-orders__card-meta">
                    раскрой идёт, закрыто раскладов {o.laysClosed} из{' '}
                    {o.laysTotal}
                  </span>
                ) : null}
                {waiting ? (
                  <span className="cut-orders__card-meta">
                    по закрытым раскладам выпущено всё — заказ вернётся в
                    очередь сам
                  </span>
                ) : null}
              </>
            );

            return (
              <li key={o.orderId}>
                {waiting ? (
                  <div
                    className={
                      'cut-orders__card cutter-release-queue__card--locked' +
                      ` constructor-card--status-${tone}`
                    }
                  >
                    {body}
                  </div>
                ) : (
                  <Link
                    className={
                      'cut-orders__card' + ` constructor-card--status-${tone}`
                    }
                    href={`/cutter/release/${o.orderId}`}
                    prefetch={false}
                  >
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
