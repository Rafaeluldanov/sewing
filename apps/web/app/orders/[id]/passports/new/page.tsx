import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listActiveCutters } from '@/lib/employees-api';
import { getOrder } from '@/lib/orders-api';
import { listOrderPassports } from '@/lib/passports-api';
import { NewPassportForm } from './new-passport-form';

export const dynamic = 'force-dynamic';

export default async function NewPassportPage({
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

  // Помощник раскройщика приходит сюда из упрощённого `/work` flow
  // (см. `/work/cut-orders` и ТЗ «упрощение UX помощника раскройщика»),
  // поэтому back-ссылку для него ведём не в admin-карточку заказа, а
  // обратно в его рабочий экран. Менеджеры остаются на привычной
  // ссылке «← К заказу».
  const me = await getCurrentUserOrNull();
  const isCutterAssistant = me?.user.role === 'CUTTER_ASSISTANT';
  const isCutter = me?.user.role === 'CUTTER';
  const backHref = isCutterAssistant ? '/work' : `/orders/${order.id}`;
  const backLabel = isCutterAssistant ? '← На рабочее место' : '← К заказу';

  // PHASE 2 STEP 3: select раскройщика для не-CUTTER ролей. Backend
  // требует явный `cutterId`, чтобы immediate-начисление пошло
  // правильному сотруднику (см. `PassportsService.create`,
  // `docs/api.md §24a`). Для creator с role=CUTTER select прячется —
  // backend подставит самого creator. Загружаем активных CUTTER-ов
  // через узкий read-only endpoint `/api/employees/cutters` —
  // широкий `/api/employees` под `SHOP_MANAGER, ADMIN` и отдаёт
  // payroll-поля; помощник раскройщика там получает 403.
  // См. `docs/cutter-assistant-passport-release-recon.md §5`.
  const cutterOptions = isCutter ? [] : await listActiveCutters();

  return (
    <div>
      <div className="page-header">
        <h1>Новый паспорт по заказу {order.number}</h1>
        <Link className="btn" href={backHref}>
          {backLabel}
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
        canRequestCuttingClosure={isCutterAssistant}
        isCutterAssistant={isCutterAssistant}
        creatorIsCutter={isCutter}
        cutterOptions={cutterOptions}
      />
    </div>
  );
}
