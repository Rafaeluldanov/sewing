import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listActiveCutters } from '@/lib/employees-api';
import { getOrderReleaseState } from '@/lib/cutting-tasks-api';
import { moscowToday } from '@/lib/time-tracker-period';
import { getOrder } from '@/lib/orders-api';
import { listOrderPassports } from '@/lib/passports-api';
import { NewPassportForm } from './new-passport-form';
import { CutterAssistantRollForm } from './cutter-assistant-roll-form';

export const dynamic = 'force-dynamic';

export default async function NewPassportPage({
  params,
}: {
  params: { id: string };
}) {
  const me = await getCurrentUserOrNull();
  const isCutterAssistant = me?.user.role === 'CUTTER_ASSISTANT';
  const isCutter = me?.user.role === 'CUTTER';

  // -------------------------------------------------------------------------
  // Помощник раскройщика: рулонный выпуск. Размеры и рулоны берём из задачи
  // раскройщика (`CuttingTask`), помощник ничего не вводит руками — выбирает
  // расклад, размер и рулоны и жмёт «Выпустить паспорт».
  //
  // Частичное завершение раскроя (коммит 3b1669c): раньше выпуск был заперт
  // до `cuttingTaskStatus === 'DONE'` («Раскрой завершён» по всему заказу).
  // Теперь единица готовности — РАСКЛАД: раскройщик закрывает его кнопкой
  // «Расклад готов» (`CuttingTaskLay.completedAt`), и по этому раскладу можно
  // печатать паспорта, пока остальные ещё настилаются. Поэтому гейт экрана
  // считается по раскладам, а не по статусу задачи, и «раскрой ещё идёт» —
  // это НЕ ошибка, а нормальное состояние (синяя справка, не красная плашка).
  // Backend держит тот же инвариант: выпуск по открытому раскладу отвергается
  // с 400 `CUTTING_LAY_NOT_DONE`.
  // -------------------------------------------------------------------------
  if (isCutterAssistant) {
    let release;
    try {
      release = await getOrderReleaseState(params.id);
    } catch (e) {
      if (e instanceof ApiRequestError && e.statusCode === 404) {
        return (
          <div>
            <div className="page-header">
              <h1>Выпуск паспортов</h1>
              <Link className="btn" href="/work/cut-orders">
                ← К выбору заказа
              </Link>
            </div>
            <div className="error-box">
              По этому заказу ещё нет задачи раскроя. Заказ появится здесь,
              когда по нему закроют первый расклад кнопкой «Расклад готов».
            </div>
          </div>
        );
      }
      throw e;
    }

    // Дата раскроя — по Москве, а не по UTC: в ночные часы
    // `toISOString()` отдаёт вчерашний день, и паспорта помощника
    // получали бы `cutDate` на сутки раньше, чем у раскройщика на
    // `/cutter/release/[orderId]` (там уже `moscowToday()`).
    const today = moscowToday();

    // Гейт экрана = закрытые расклады. Ровно тот же признак, по которому
    // фильтрует расклады сама форма (`CutterAssistantRollForm`): открытый
    // расклад виден, но не выбирается. Нет ни одного закрытого — выпускать
    // физически нечего, форму отдаём `disabled`.
    const sortedLays = [...release.lays].sort((a, b) => a.ordinal - b.ordinal);
    const closedLays = sortedLays.filter((l) => l.completedAt);
    const openLays = sortedLays.filter((l) => !l.completedAt);
    const nothingToRelease = closedLays.length === 0;

    // Согласование числа руками: «закрыт расклад 1» / «закрыты расклады 1, 2».
    const closedText =
      closedLays.length === 1
        ? `закрыт расклад ${closedLays[0].ordinal}`
        : `закрыты расклады ${closedLays.map((l) => l.ordinal).join(', ')}`;

    return (
      <div>
        <div className="page-header">
          <h1>Выпуск паспортов по заказу {release.orderNumber}</h1>
          <Link className="btn" href="/work/cut-orders">
            ← К выбору заказа
          </Link>
        </div>
        {nothingToRelease ? (
          // Ждём первый закрытый расклад. Тон нейтральный (жёлтый), а не
          // danger: помощник ничего не сломал, просто ещё рано.
          <div className="warning-box" role="status">
            <div className="warning-box__msg">
              Ни один расклад ещё не закрыт — выпуск станет доступен, когда
              раскройщик нажмёт «Расклад готов» по первому раскладу.
            </div>
          </div>
        ) : openLays.length > 0 ? (
          // Печатать уже можно, но не по всему заказу. Это справка, а НЕ
          // ошибка — красной плашкой помощник читал бы штатный ход раскроя
          // как поломку (тот же `.cutter-release-note`, что в кабинете
          // раскройщика на `/cutter/release/<orderId>`).
          <div className="cutter-release-note" role="status">
            <strong>Раскрой ещё идёт: {closedText}.</strong>
            Остальные расклады появятся здесь по мере закрытия.
          </div>
        ) : null}
        <CutterAssistantRollForm
          orderId={release.orderId}
          orderNumber={release.orderNumber}
          productName={release.productName}
          color={release.color}
          lays={release.lays}
          released={release.released}
          today={today}
          disabled={nothingToRelease}
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Менеджер / админ: прежняя ручная форма (правки, заказы без задачи
  // раскроя). Раскройщик сюда не попадает — выпуск ему запрещён (RBAC).
  // -------------------------------------------------------------------------
  let order;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const passports = await listOrderPassports(params.id);
  // Сколько уже выпущено по каждому размеру (без CANCELLED).
  const cutBySize = new Map<string, number>();
  for (const p of passports) {
    if (p.status === 'CANCELLED') continue;
    cutBySize.set(p.sizeId, (cutBySize.get(p.sizeId) ?? 0) + p.qtyCut);
  }
  const sizeOptions = order.items.map((it) => ({
    sizeId: it.sizeId,
    sizeCode: it.sizeCode,
    sizeSortOrder: it.sizeSortOrder,
    qtyPlan: it.qtyPlan,
    qtyCutFact: cutBySize.get(it.sizeId) ?? 0,
    remaining: Math.max(it.qtyPlan - (cutBySize.get(it.sizeId) ?? 0), 0),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const blocked = order.status !== 'IN_PRODUCTION';
  const backHref = `/orders/${order.id}`;

  // PHASE 2 STEP 3: select раскройщика для не-CUTTER ролей. Backend
  // требует явный `cutterId`, чтобы immediate-начисление пошло
  // правильному сотруднику (см. `PassportsService.create`,
  // `docs/api.md §24a`).
  const cutterOptions = isCutter ? [] : await listActiveCutters();

  return (
    <div>
      <div className="page-header">
        <h1>Новый паспорт по заказу {order.number}</h1>
        <Link className="btn" href={backHref}>
          ← К заказу
        </Link>
      </div>
      {blocked && (
        <div className="error-box">
          Выпуск паспорта разрешён только для заказа в статусе{' '}
          <strong>IN_PRODUCTION</strong>. Текущий статус: {order.status}.
          Запустите заказ в производство в карточке.
        </div>
      )}
      <NewPassportForm
        orderId={order.id}
        orderNumber={order.number}
        productId={order.productId}
        productName={order.productName ?? '—'}
        color={order.color ?? '—'}
        sizes={sizeOptions}
        today={today}
        disabled={blocked}
        canRequestCuttingClosure={false}
        isCutterAssistant={false}
        creatorIsCutter={isCutter}
        cutterOptions={cutterOptions}
        canCreateCutter={(me?.user.roles ?? []).some(
          (r) => r === 'ADMIN' || r === 'SHOP_MANAGER',
        )}
      />
    </div>
  );
}
