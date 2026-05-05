import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { listActiveCutters } from '@/lib/employees-api';
import { getOrder } from '@/lib/orders-api';
import { getPassport, listOrderPassports } from '@/lib/passports-api';
import { EditPassportForm } from './edit-passport-form';

export const dynamic = 'force-dynamic';

/**
 * Страница редактирования паспорта помощника раскройщика
 * (`/work/passports/[id]/edit`).
 *
 * Поведение:
 *   - SSR подтягивает паспорт + заказ + размерную матрицу + список
 *     активных раскройщиков, как и `/orders/[id]/passports/new`;
 *   - проверяет, что паспорт ещё editable (`status=CREATED`,
 *     `currentCellId === null`); иначе редиректит обратно на
 *     `/work/passports` — backend всё равно отдаст 409 на PATCH,
 *     но без UI-странички ошибки красивее: пользователь сразу
 *     видит свежий список без «битой» формы;
 *   - для CUTTER_ASSISTANT/CUTTER скрывает select раскройщика, если
 *     creator==CUTTER (та же логика, что на форме выпуска);
 *   - возврат — «← К списку выпущенных паспортов» (как и просили в
 *     ТЗ); из самого списка кнопка «← На рабочее место».
 */
export default async function WorkPassportEditPage({
  params,
}: {
  params: { id: string };
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect(`/login?next=/work/passports/${params.id}/edit`);

  let passport;
  try {
    passport = await getPassport(params.id);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) notFound();
    throw e;
  }

  // Помощник раскройщика правит только свой паспорт. Менеджер/админ
  // запросто открывают эту же страницу для отладки, поэтому строго
  // обнулять «чужой» доступ не будем — backend сам пробросит 403.
  // Здесь нас интересует только «можно ли в принципе править» —
  // если паспорт уже двинулся, отправим обратно в список.
  if (passport.status !== 'CREATED' || passport.currentCell !== null) {
    redirect('/work/passports');
  }

  const [order, allOrderPassports, cutters] = await Promise.all([
    getOrder(passport.orderId),
    listOrderPassports(passport.orderId),
    listActiveCutters(),
  ]);

  // Сколько уже выпущено по каждому размеру (без CANCELLED) с
  // ИСКЛЮЧЕНИЕМ редактируемого паспорта — иначе при сохранении того
  // же `qtyCut` мы бы упёрлись в собственное прежнее значение.
  const cutBySize = new Map<string, number>();
  for (const p of allOrderPassports) {
    if (p.status === 'CANCELLED') continue;
    if (p.id === passport.id) continue;
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

  const isCutter = me.user.role === 'CUTTER';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="page-header">
        <h1>Редактирование паспорта {passport.number}</h1>
        <Link className="btn" href="/work/passports">
          ← К списку выпущенных паспортов
        </Link>
      </div>
      <EditPassportForm
        passportId={passport.id}
        passportNumber={passport.number}
        orderId={passport.orderId}
        orderNumber={passport.orderNumber}
        productName={passport.productName}
        color={passport.color}
        sizes={sizeOptions}
        today={today}
        creatorIsCutter={isCutter}
        cutterOptions={isCutter ? [] : cutters}
        initial={{
          sizeId: passport.sizeId,
          cutDate: passport.cutDate.slice(0, 10),
          qtyCut: passport.qtyCut,
          rollNumber: passport.rollNumber,
          cutterId: passport.cutterId,
        }}
      />
    </div>
  );
}
