import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listActiveCutters } from '@/lib/employees-api';
import { getOrderReleaseState } from '@/lib/cutting-tasks-api';
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
  // Помощник раскройщика: рулонный выпуск. Размеры и рулоны берём из
  // завершённой задачи раскройщика (`CuttingTask`), помощник ничего не
  // вводит руками — выбирает размер и рулоны и жмёт «Выпустить паспорт».
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
              когда раскройщик завершит раскрой.
            </div>
          </div>
        );
      }
      throw e;
    }

    const today = new Date().toISOString().slice(0, 10);
    const cuttingDone = release.cuttingTaskStatus === 'DONE';

    return (
      <div>
        <div className="page-header">
          <h1>Выпуск паспортов по заказу {release.orderNumber}</h1>
          <Link className="btn" href="/work/cut-orders">
            ← К выбору заказа
          </Link>
        </div>
        {!cuttingDone && (
          <div className="error-box">
            Раскрой по заказу ещё не завершён — выпуск паспортов станет
            доступен, когда раскройщик отметит «Раскрой завершён».
          </div>
        )}
        <CutterAssistantRollForm
          orderId={release.orderId}
          orderNumber={release.orderNumber}
          productName={release.productName}
          color={release.color}
          sizes={release.sizes}
          rolls={release.rolls}
          released={release.released}
          today={today}
          disabled={!cuttingDone}
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
      />
    </div>
  );
}
