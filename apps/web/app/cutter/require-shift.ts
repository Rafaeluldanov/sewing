import { redirect } from 'next/navigation';
import { ApiRequestError } from '@/lib/api';
import { getCurrentShift } from '@/lib/shifts-api';

/**
 * Гейт активной смены для вкладок кабинета раскройщика
 * (`/cutter/release*`, `/cutter/shelf`, `/cutter/passports*`).
 *
 * Раскрой — scan-shift роль (как ОТК/ВТО/упаковка): сначала смена сканом
 * QR раскройного стола, потом работа. Сама доска `/cutter` без смены
 * показывает форму старта (`SeamstressShiftStart`), а вкладки в этом
 * состоянии вообще не рендерятся (см. `cutter/layout.tsx`) — значит на
 * них можно попасть только прямой ссылкой/закладкой. Отправляем такого
 * гостя на доску, где ему предложат начать смену.
 *
 * Почему гейт на каждой вкладке, а не один раз в layout: layout в App
 * Router не знает текущий путь, а для `/cutter` редирект был бы
 * бесконечным (там как раз и живёт форма старта смены).
 *
 * Смена нужна не только для табеля: печать паспорта берёт принтер по роли
 * сотрудника, но часовая оплата и «Мой день» считаются от `ShiftSession`
 * (см. `ShiftsService.start` → `SalaryService.syncDailySalary`).
 *
 * fail-soft на `ApiRequestError`: временный сбой `GET /shifts/current`
 * трактуем как «смены нет» — это хуже для UX, но безопаснее, чем пустить
 * работу без табеля.
 */
export async function requireActiveCutterShift(): Promise<void> {
  let currentShift = null;
  try {
    currentShift = await getCurrentShift();
  } catch (e) {
    if (!(e instanceof ApiRequestError)) throw e;
  }
  if (!(currentShift && currentShift.active)) redirect('/cutter');
}
