import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { requireActiveCutterShift } from '../../require-shift';
import { getOrderReleaseState } from '@/lib/cutting-tasks-api';
import { moscowToday } from '@/lib/time-tracker-period';
import { CutterAssistantRollForm } from '@/app/orders/[id]/passports/new/cutter-assistant-roll-form';
import type { OrderReleaseStateDto } from '@sewing/shared/cutting-tasks';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { orderId: string };
}

/**
 * Вкладка «Выпуск» → форма выпуска паспортов по одному заказу. Серверный
 * компонент кабинета раскройщика (`/cutter/release/<orderId>`).
 *
 * Зачем отдельный роут под `/cutter`, а не переход на общий
 * `/orders/<id>/passports/new`: чистая учётка `CUTTER` заперта middleware
 * на префикс `/cutter` (см. `apps/web/middleware.ts`), поэтому все экраны
 * раскройщика живут только здесь. Сама форма при этом НЕ дублируется —
 * переиспользуем клиентский `CutterAssistantRollForm` помощника
 * (`apps/web/app/orders/[id]/passports/new/cutter-assistant-roll-form.tsx`),
 * передав ему `backHref="/cutter/release"`: логика «расклад → размер →
 * рулоны → выпустить/перепечатать» у раскройщика и помощника одна и та же,
 * различается только навигация вокруг.
 *
 * Данные — один запрос `getOrderReleaseState(orderId)`
 * (`GET /api/cutting-tasks/by-order/:orderId/release-state`, роль `CUTTER`
 * в `@Roles` добавлена вместе с этой вкладкой): расклады с размерами и
 * рулонами из задачи раскроя + уже выпущенные тройки
 * `(расклад, размер, рулон)`. Раскройщик ничего не вводит руками.
 *
 * Инварианты экрана:
 *   - выпускать можно ТОЛЬКО по закрытым раскладам (`completedAt != null`):
 *     открытый ещё настилается, его слои могут измениться, и backend такой
 *     выпуск отвергает (400 `CUTTING_LAY_NOT_DONE`). Нет ни одного
 *     закрытого — форма `disabled`, кнопка выпуска не нажимается;
 *   - «раскрой ещё идёт» — это НЕ ошибка (частичное завершение раскроя,
 *     коммит 3b1669c): вместо старого красного `error-box` «Раскрой по
 *     заказу ещё не завершён» показываем синий `.cutter-release-note` с
 *     номерами закрытых раскладов. Красным тоном раскройщик читал бы
 *     нормальное состояние как поломку;
 *   - номера закрытых/открытых раскладов считаются здесь, на сервере —
 *     клиентской форме этот текст не нужен.
 *
 * Гейт смены — как на `/cutter/<id>`: раскрой scan-shift роль, без активной
 * `ShiftSession` отправляем на доску `/cutter`, где предложат «Начать
 * смену» (там же живёт печать на принтер стола из смены). fail-soft на
 * `ApiRequestError`: сбой `GET /shifts/current` трактуем как «смены нет».
 */
export default async function CutterReleaseOrderPage({ params }: PageProps) {
  await requireActiveCutterShift();

  let release: OrderReleaseStateDto;
  try {
    release = await getOrderReleaseState(params.orderId);
  } catch (e) {
    // 404 = по заказу вообще нет задачи раскроя (например, ссылку открыли
    // из закладки, а задачу отменили). Не 404-им страницу целиком —
    // объясняем словами и возвращаем в очередь.
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      return (
        <div className="constructor-detail">
          <Link href="/cutter/release" className="constructor-back">
            ← К очереди выпуска
          </Link>
          <header className="constructor-detail__head">
            <div>
              <h1 className="constructor-detail__title">Выпуск паспортов</h1>
            </div>
          </header>
          <section className="constructor-card-block">
            <p className="constructor-muted">
              По этому заказу ещё нет задачи раскроя. Заказ появится в очереди
              выпуска, когда по нему закроют первый расклад кнопкой «Расклад
              готов».
            </p>
          </section>
        </div>
      );
    }
    throw e;
  }

  const sortedLays = [...release.lays].sort((a, b) => a.ordinal - b.ordinal);
  // Закрытые расклады = то, по чему разрешён выпуск (см. инварианты выше).
  const closedOrdinals = sortedLays
    .filter((l) => l.completedAt)
    .map((l) => l.ordinal);
  const openOrdinals = sortedLays
    .filter((l) => !l.completedAt)
    .map((l) => l.ordinal);
  const nothingToRelease = closedOrdinals.length === 0;

  // Согласование числа руками: «закрыт расклад 1» / «закрыты расклады 1, 2».
  const closedText =
    closedOrdinals.length === 1
      ? `закрыт расклад ${closedOrdinals[0]}`
      : `закрыты расклады ${closedOrdinals.join(', ')}`;
  const openText =
    openOrdinals.length === 1
      ? `Расклад ${openOrdinals[0]} появится здесь`
      : `Расклады ${openOrdinals.join(', ')} появятся здесь`;

  return (
    <div className="constructor-detail">
      <Link href="/cutter/release" className="constructor-back">
        ← К очереди выпуска
      </Link>

      <header className="constructor-detail__head">
        <div>
          <h1 className="constructor-detail__title">
            Выпуск паспортов по заказу {release.orderNumber}
          </h1>
          <div className="constructor-detail__article">
            {release.productName} · {release.color}
          </div>
        </div>
      </header>

      {openOrdinals.length > 0 && (
        <div className="cutter-release-note" role="status">
          <strong>
            {nothingToRelease
              ? 'Раскрой идёт: ни один расклад ещё не закрыт'
              : `Раскрой идёт: ${closedText}`}
          </strong>
          {`${openText}, когда вы нажмёте «Расклад готов» в задаче раскроя.`}
        </div>
      )}

      <CutterAssistantRollForm
        orderId={release.orderId}
        orderNumber={release.orderNumber}
        productName={release.productName}
        color={release.color}
        lays={release.lays}
        released={release.released}
        // Дата раскроя = сегодняшний МОСКОВСКИЙ день: `toISOString()` в ночь
        // отдаёт вчерашнюю дату (см. memory feedback про timezone).
        today={moscowToday()}
        disabled={nothingToRelease}
        backHref="/cutter/release"
      />
    </div>
  );
}
