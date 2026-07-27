/**
 * Загрузка данных для формы правки выпущенного паспорта — ОДНА для двух
 * кабинетов:
 *   - помощник раскройщика: `/work/passports/[id]/edit`;
 *   - раскройщик: `/cutter/passports/[id]/edit` (чистая учётка `CUTTER`
 *     заперта middleware на префикс `/cutter`, см. `apps/web/middleware.ts`).
 *
 * Зачем отдельный модуль, а не копия в каждой странице: подготовка данных
 * здесь — это ЛОГИКА, а не разметка. Главный её кусок — остатки плана по
 * размерам с ИСКЛЮЧЕНИЕМ самого редактируемого паспорта: иначе при
 * сохранении того же `qtyCut` пользователь упирался бы в собственное
 * прежнее значение («остаток 0»). Такое правило должно жить в одном месте,
 * иначе один кабинет неизбежно отстанет от другого (см. memory
 * «Проверять взаимосвязанные места при правке»).
 *
 * Модуль НЕ решает, куда редиректить: адрес списка у кабинетов разный.
 * Вместо `notFound()` / `redirect()` возвращается размеченный результат,
 * а страница переводит его в свою навигацию.
 */

import type { ActiveCutterListItemDto } from '@sewing/shared/employees';
import type { PassportDetailDto } from '@sewing/shared/passports';
import { ApiRequestError } from './api';
import { listActiveCutters } from './employees-api';
import { getOrder } from './orders-api';
import { getPassport, listOrderPassports } from './passports-api';
import { moscowToday } from './time-tracker-period';

/** Один размер заказа с остатком, посчитанным без правимого паспорта. */
export interface PassportEditSizeOption {
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyPlan: number;
  /** Уже раскроено по ДРУГИМ паспортам этого размера (без CANCELLED). */
  qtyCutFact: number;
  /** `qtyPlan - qtyCutFact`, но не меньше нуля (перекрой не даёт минус). */
  remaining: number;
}

/** Готовый набор пропов для `EditPassportForm`. */
export interface PassportEditFormData {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizes: PassportEditSizeOption[];
  today: string;
  /**
   * Смотрящий сам раскройщик (роль `CUTTER`) — тогда select «Раскройщик»
   * в форме не показываем: начисление и так его, выбирать не из чего.
   */
  creatorIsCutter: boolean;
  cutterOptions: ActiveCutterListItemDto[];
  initial: {
    sizeId: string;
    cutDate: string;
    qtyCut: number;
    rollNumber: string;
    cutterId: string;
  };
}

/**
 * Результат загрузки:
 *   - `not-found` — `GET /api/passports/:id` ответил 404 (страница → `notFound()`);
 *   - `not-editable` — паспорт уже двинулся (не `CREATED` или лежит в
 *     ячейке). PATCH всё равно вернёт 409 `PASSPORT_NOT_EDITABLE`, поэтому
 *     форму не рисуем — страница возвращает в свой список;
 *   - `ok` — пропы формы.
 */
export type PassportEditDataResult =
  | { kind: 'ok'; data: PassportEditFormData }
  | { kind: 'not-found' }
  | { kind: 'not-editable' };

export async function loadPassportEditData(
  passportId: string,
  viewerRole: string,
): Promise<PassportEditDataResult> {
  let passport: PassportDetailDto;
  try {
    passport = await getPassport(passportId);
  } catch (e) {
    if (e instanceof ApiRequestError && e.statusCode === 404) {
      return { kind: 'not-found' };
    }
    throw e;
  }

  // «Свой ли паспорт» проверяет backend (`creatorId === me` в
  // `PassportsService.update`): менеджер/админ открывают ту же страницу для
  // отладки, и строго обнулять им доступ на фронте смысла нет. Здесь нас
  // интересует только «можно ли в принципе править».
  if (passport.status !== 'CREATED' || passport.currentCell !== null) {
    return { kind: 'not-editable' };
  }

  // Раскройщик правит СВОЙ выпуск — select «Раскройщик» ему не нужен
  // (начисление за раскрой и так его).
  const creatorIsCutter = viewerRole === 'CUTTER';

  const [order, allOrderPassports, cutters] = await Promise.all([
    getOrder(passport.orderId),
    listOrderPassports(passport.orderId),
    // Список активных раскройщиков нужен ТОЛЬКО для этого select-а,
    // поэтому самому `CUTTER` его не запрашиваем: ручка
    // `GET /api/employees/cutters` в `@Roles` его не содержит и отдала бы
    // 403, уронив весь экран правки из-за неиспользуемых данных.
    creatorIsCutter
      ? Promise.resolve<ActiveCutterListItemDto[]>([])
      : listActiveCutters(),
  ]);

  // Сколько уже выпущено по каждому размеру (без CANCELLED) с ИСКЛЮЧЕНИЕМ
  // редактируемого паспорта — см. докстринг модуля.
  const cutBySize = new Map<string, number>();
  for (const p of allOrderPassports) {
    if (p.status === 'CANCELLED') continue;
    if (p.id === passport.id) continue;
    cutBySize.set(p.sizeId, (cutBySize.get(p.sizeId) ?? 0) + p.qtyCut);
  }
  const sizes: PassportEditSizeOption[] = order.items.map((it) => {
    const fact = cutBySize.get(it.sizeId) ?? 0;
    return {
      sizeId: it.sizeId,
      sizeCode: it.sizeCode,
      sizeSortOrder: it.sizeSortOrder,
      qtyPlan: it.qtyPlan,
      qtyCutFact: fact,
      remaining: Math.max(it.qtyPlan - fact, 0),
    };
  });

  return {
    kind: 'ok',
    data: {
      passportId: passport.id,
      passportNumber: passport.number,
      orderId: passport.orderId,
      orderNumber: passport.orderNumber,
      productName: passport.productName,
      color: passport.color,
      sizes,
      // Московский день, а не `toISOString()`: в ночную смену UTC-дата
      // отстаёт на сутки (см. memory feedback про таймзоны).
      today: moscowToday(),
      creatorIsCutter,
      cutterOptions: cutters,
      initial: {
        sizeId: passport.sizeId,
        cutDate: passport.cutDate.slice(0, 10),
        qtyCut: passport.qtyCut,
        rollNumber: passport.rollNumber,
        cutterId: passport.cutterId,
      },
    },
  };
}
