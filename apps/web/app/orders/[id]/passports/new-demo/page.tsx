import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listEmployees } from '@/lib/employees-api';
import { getOrder } from '@/lib/orders-api';
import { listOrderPassports } from '@/lib/passports-api';
import { NewPassportDemoForm } from './new-passport-demo-form';

export const dynamic = 'force-dynamic';

/**
 * Демо-режим выпуска паспортов: помощник раскройщика выбирает размер,
 * указывает количество рулонов, заполняет сетку количеств по рулонам и
 * одним нажатием выпускает серию паспортов на выбранный размер.
 *
 * Контракт с backend не меняем — внутри server action крутится цикл
 * по существующему `POST /api/passports` (по паспорту на каждый рулон
 * с qty > 0). Дата кроя и раскройщик подставляются автоматически, как
 * и в обычном flow `/orders/:id/passports/new`.
 */
export default async function NewPassportDemoPage({
  params,
}: {
  params: { id: string };
}) {
  let order;
  try {
    order = await getOrder(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  const passports = await listOrderPassports(params.id);
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

  const me = await getCurrentUserOrNull();
  const isCutterAssistant = me?.user.role === 'CUTTER_ASSISTANT';
  const isCutter = me?.user.role === 'CUTTER';

  // Раскройщик подставляется так же, как в обычной форме: для creator
  // с ролью CUTTER select прячется (backend подставит самого creator),
  // иначе берём первого активного CUTTER. См. `docs/api.md §24a`.
  const cutterEmployees = isCutter
    ? []
    : await listEmployees({ active: true, role: 'CUTTER' });
  const cutterOptions = cutterEmployees.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    login: e.login,
  }));

  const backHref = isCutterAssistant ? '/work' : `/orders/${order.id}`;
  const backLabel = isCutterAssistant ? '← На рабочее место' : '← К заказу';

  return (
    <div>
      <div className="page-header">
        <h1>Демо: выпуск паспортов по заказу {order.number}</h1>
        <Link className="btn" href={backHref}>
          {backLabel}
        </Link>
      </div>
      {blocked && (
        <div className="error-box">
          Выпуск паспорта разрешён только для заказа в статусе{' '}
          <strong>IN_PRODUCTION</strong>. Текущий статус: {order.status}.
        </div>
      )}
      <NewPassportDemoForm
        orderId={order.id}
        orderNumber={order.number}
        productName={order.productName ?? '—'}
        color={order.color ?? '—'}
        sizes={sizeOptions}
        today={today}
        disabled={blocked}
        creatorIsCutter={isCutter}
        cutterOptions={cutterOptions}
      />
    </div>
  );
}
