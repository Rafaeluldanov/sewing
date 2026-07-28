/**
 * Расхождение факта с маршрутом заказа (чистая логика, без Prisma).
 *
 * Контекст. Швея выбирает операцию из списка своего СТАНКА — маршрут
 * заказа в этом выборе не участвует вообще. Если операции нет в снимке
 * маршрута, гейт `PassportsService.evaluateRouteOrder` возвращает пустой
 * результат и НЕ enforce'ит ничего: работа принимается молча, сделка
 * начисляется, партия шьётся до конца — и упирается только в AND-гейт
 * перед ОТК, недели спустя, сразу десятками паспортов. Шесть инцидентов
 * этого класса с 13.05.2026; последний (28.07) — 70 паспортов в 8
 * заказах, лаг обнаружения 27 дней.
 *
 * Почему чистая функция. Один и тот же расчёт нужен ДВУМ потребителям:
 *   - `DiagnosticsService` (проверка `ORDER_WORK_OUTSIDE_ROUTE`,
 *     администраторский отчёт);
 *   - `ProductionBoardService` (вкладка «Расхождения» в кабинете
 *     мастера — тот, кто реально может что-то сделать утром).
 * Держать две копии правил «что считать расхождением» — гарантированный
 * дрейф: один экран скажет «всё чисто», другой покажет находку, и
 * доверия не будет ни к одному. Правила живут здесь, оба сервиса только
 * подставляют данные из БД. Тестируется без базы (`tests/unit`).
 */

/** Событие закрытия операции, сведённое к минимуму. */
export interface DivergenceEventInput {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  operationId: string;
  operationCode: string;
  operationName: string;
  employeeName: string | null;
  createdAt: Date;
}

/** Одно правило замены (`OperationSubstitution`). */
export interface DivergenceSubstitutionInput {
  satisfiesOpId: string;
  substituteOpId: string;
}

/**
 * Расхождение, свёрнутое до ПАРЫ (заказ, операция).
 *
 * Единица именно такая, а не паспорт: мастеру нужно одно решение на всю
 * пачку («так и должно быть» / «делают не то»), а не 70 одинаковых
 * строк, среди которых он потеряет остальные заказы.
 */
export interface RouteDivergenceGroup {
  orderId: string;
  orderNumber: string;
  operationId: string;
  operationCode: string;
  operationName: string;
  passportCount: number;
  /** Кто закрывал — для разговора мастера с конкретными людьми. */
  employees: string[];
  firstAt: Date;
  lastAt: Date;
}

/**
 * Считает расхождения по уже выбранным из БД данным.
 *
 * @param events    закрытия ШВЕЙНЫХ операций по живым заказам за окно
 *                  (фильтрация по категории/статусу заказа — на стороне
 *                  вызывающего, это дешевле сделать в SQL);
 * @param routeOperationsByOrder  снимок маршрута: заказ → его операции;
 * @param substitutions           правила замены целиком.
 *
 * Событие НЕ считается расхождением, если:
 *   - у заказа нет снимка маршрута (сравнивать не с чем — это отдельная
 *     находка `ORDER_IN_PRODUCTION_WITHOUT_ROUTE_STEPS_BUT_ROUTE_TEMPLATE`,
 *     дублировать её здесь нельзя);
 *   - операция входит в снимок маршрута;
 *   - операция ЗАМЕЩАЕТ какой-нибудь шаг маршрута по правилам замены
 *     (закрытие заместителя засчитывает замещаемую — см.
 *     `evaluateRouteOrder` и `QcService`).
 *
 * Результат отсортирован по «с какого дня идёт» — самые застарелые
 * сверху: чем дольше расхождение живёт, тем больше паспортов оно
 * успевает испортить.
 */
export function computeRouteDivergences(
  events: readonly DivergenceEventInput[],
  routeOperationsByOrder: ReadonlyMap<string, ReadonlySet<string>>,
  substitutions: readonly DivergenceSubstitutionInput[],
): RouteDivergenceGroup[] {
  // Заместитель → множество операций, которые он закрывает.
  const satisfiedBySubstitute = new Map<string, Set<string>>();
  for (const s of substitutions) {
    const set = satisfiedBySubstitute.get(s.substituteOpId) ?? new Set<string>();
    set.add(s.satisfiesOpId);
    satisfiedBySubstitute.set(s.substituteOpId, set);
  }

  const groups = new Map<
    string,
    RouteDivergenceGroup & { passportIds: Set<string>; employeeSet: Set<string> }
  >();

  for (const e of events) {
    const route = routeOperationsByOrder.get(e.orderId);
    if (!route || route.size === 0) continue;
    if (route.has(e.operationId)) continue;

    const satisfied = satisfiedBySubstitute.get(e.operationId);
    if (satisfied) {
      let legal = false;
      for (const opId of satisfied) {
        if (route.has(opId)) {
          legal = true;
          break;
        }
      }
      if (legal) continue;
    }

    const key = `${e.orderId}\u0000${e.operationId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.passportIds.add(e.passportId);
      if (e.employeeName) existing.employeeSet.add(e.employeeName);
      if (e.createdAt < existing.firstAt) existing.firstAt = e.createdAt;
      if (e.createdAt > existing.lastAt) existing.lastAt = e.createdAt;
      continue;
    }
    groups.set(key, {
      orderId: e.orderId,
      orderNumber: e.orderNumber,
      operationId: e.operationId,
      operationCode: e.operationCode,
      operationName: e.operationName,
      passportCount: 0,
      employees: [],
      firstAt: e.createdAt,
      lastAt: e.createdAt,
      passportIds: new Set([e.passportId]),
      employeeSet: new Set(e.employeeName ? [e.employeeName] : []),
    });
  }

  return [...groups.values()]
    .map((g) => ({
      orderId: g.orderId,
      orderNumber: g.orderNumber,
      operationId: g.operationId,
      operationCode: g.operationCode,
      operationName: g.operationName,
      passportCount: g.passportIds.size,
      employees: [...g.employeeSet].sort((a, b) => a.localeCompare(b)),
      firstAt: g.firstAt,
      lastAt: g.lastAt,
    }))
    .sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime());
}
