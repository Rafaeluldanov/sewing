/**
 * Незакрытая работа, оставшаяся ПОЗАДИ паспорта (чистая логика, без
 * Prisma).
 *
 * Контекст. Паспорт уходит вперёд по маршруту сканом на следующей
 * операции, а закрытие предыдущей — отдельное осознанное действие швеи
 * («Завершить»). Между этими двумя фактами нет никакой связи:
 * маршрутный гейт `PassportsService.evaluateRouteOrder` проверяет
 * только шаги, лежащие СТРОГО МЕЖДУ текущим и целевым
 * (`rep > currentRep && rep < targetRep`), — то есть шаг, на котором
 * паспорт стоит прямо сейчас, не проверяется вообще. Плюс
 * `scanOnOperation` не смотрит, у кого паспорт на руках. Итог: любой
 * следующий исполнитель (включая ОТК) уводит паспорт вперёд, а взятая
 * и не закрытая операция остаётся долгом — без `OPERATION_FINISHED`,
 * а значит и без `OperationEntry`: сделка за эту работу не начислена
 * никому.
 *
 * Инцидент 17-18.08.2026, заказ 02-00013: швея взяла 10 паспортов на
 * «Ф РАСПОШИВ» 14-17.08 и ни одного не закрыла; 18.08 контролёр
 * отсканировала их на ОТК, паспорта прошли ОТК и ВТО. 146 изделий,
 * 3 743,44 руб. не начислено. Ни один экран этого не показывал: вкладка
 * «Расхождения» ловит закрытие операции ВНЕ маршрута
 * (`route-divergence.ts`), а здесь ровно наоборот — операция В
 * маршруте, но закрытия НЕТ.
 *
 * Почему чистая функция — та же причина, что у соседнего
 * `route-divergence.ts`: расчёт нужен двум потребителям (вкладка
 * «Расхождения» кабинета мастера и проверка `ORDER_WORK_LEFT_UNCLOSED`
 * отчёта диагностики), а две копии правил гарантированно разъедутся.
 * Тестируется без базы (`tests/unit/route-debt.test.ts`).
 */

/** Шаг маршрута заказа, сведённый к минимуму. */
export interface RouteDebtStepInput {
  index: number;
  operationId: string;
  operationCode: string;
  operationName: string;
  /** `OrderRouteStep.parallelGroup` — см. правило SEWING/вне группы ниже. */
  parallelGroup: number | null;
  /** `Operation.category === SEWING`. */
  isSewing: boolean;
}

/** Кто и когда взял шаг в работу (последнее `ISSUED_TO_EMPLOYEE`). */
export interface RouteDebtIssue {
  employeeName: string | null;
  at: Date;
}

/** Паспорт с уже выбранной историей закрытий и взятий. */
export interface RouteDebtPassportInput {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  currentRouteStepIndex: number | null;
  /** `qtyGood` — во сколько изделий обошёлся долг. */
  qty: number;
  /**
   * `operationId` каждого `OPERATION_FINISHED` этого паспорта, С
   * ПОВТОРАМИ: одна и та же операция может стоять в маршруте несколько
   * раз (чередующиеся ОТК/ВТО между швейными шагами), и первое закрытие
   * не должно засчитывать второй проход. Считаем проходы, как
   * `evaluateRouteOrder`.
   */
  finishedOperationIds: readonly string[];
  /** `operationId` -> взятие. Отличает «взяли и бросили» от «проехали мимо». */
  issuedByOperation: ReadonlyMap<string, RouteDebtIssue>;
}

/** Одно правило замены (`OperationSubstitution` + наряд-допуск). */
export interface RouteDebtSubstitutionInput {
  satisfiesOpId: string;
  substituteOpId: string;
}

/**
 * Почему шаг остался незакрытым. Разные причины — разный разговор:
 *   - `ABANDONED` — шаг БРАЛИ в работу (`ISSUED_TO_EMPLOYEE`), но не
 *     закрыли. Работа физически сделана, сделка не начислена: у долга
 *     есть конкретный автор и конкретная сумма;
 *   - `SKIPPED` — шаг никто не брал, паспорт просто проехал мимо.
 *     Это уже вопрос к технологии, а не к сотруднику.
 */
export type RouteDebtReason = 'ABANDONED' | 'SKIPPED';

/**
 * Долг, свёрнутый до тройки (заказ, операция, причина).
 *
 * Единица такая же, как у расхождений, и по той же причине: мастеру
 * нужно одно решение на всю пачку, а не 10 одинаковых строк. Причина
 * входит в ключ, потому что «взяли и не закрыли» и «шаг проехали мимо»
 * — это два разных разбора, и смешивать их в одной строке нельзя.
 */
export interface RouteDebtGroup {
  orderId: string;
  orderNumber: string;
  operationId: string;
  operationCode: string;
  operationName: string;
  reason: RouteDebtReason;
  passportCount: number;
  /** Сумма `qtyGood` паспортов группы — масштаб неначисленной сделки. */
  qty: number;
  /** Кто брал (только для `ABANDONED`) — с кем мастеру говорить. */
  employees: string[];
  /** Когда брали: `null` у `SKIPPED` — брать было некому. */
  firstAt: Date | null;
  lastAt: Date | null;
}

/**
 * Считает долги по уже выбранным из БД данным.
 *
 * Шаг считается ДОЛГОМ, когда выполнено всё сразу:
 *   1. паспорт стоит на маршруте (`currentRouteStepIndex !== null`) и
 *      шаг лежит ПОЗАДИ него (`index < currentRouteStepIndex`);
 *   2. шаг швейный (`SEWING`);
 *   3. шаг ВНЕ параллельной группы (`parallelGroup === null`);
 *   4. по нему нет закрытия — ни своего, ни через заместителя.
 *
 * Пункты 2-3 — не упрощение, а зеркало `catchUpCandidate` в
 * `PassportsService.evaluateRouteOrder`, то есть ровно тех шагов,
 * которые сотрудник может доделать сам, без мастера:
 *   - `OPERATION_FINISHED` пишут только швейные операции (крой
 *     закрывается при выпуске паспорта, ОТК/ВТО/упаковка — на
 *     собственных гейтах), поэтому для остальных категорий «нет
 *     закрытия» означало бы «всегда долг» — экран утонул бы в шуме;
 *   - шаг параллельной группы долгом быть не может: AND-гейт перед ОТК
 *     (`QcService.assertParallelGroupCompleteForQc`) не выпустит
 *     паспорт за группу, пока она не закрыта целиком. Такой шаг ещё не
 *     потерян — его держит другой гейт, и дублировать находку значило
 *     бы каждый день показывать мастеру нормально идущую работу.
 *
 * Результат отсортирован по «с какого дня висит» (самые застарелые
 * сверху), `SKIPPED` без дат — в конец.
 */
export function computeRouteDebts(
  passports: readonly RouteDebtPassportInput[],
  stepsByOrder: ReadonlyMap<string, readonly RouteDebtStepInput[]>,
  substitutions: readonly RouteDebtSubstitutionInput[],
): RouteDebtGroup[] {
  // Замещаемая операция -> чем её можно закрыть.
  const substitutesFor = new Map<string, string[]>();
  for (const s of substitutions) {
    const arr = substitutesFor.get(s.satisfiesOpId) ?? [];
    arr.push(s.substituteOpId);
    substitutesFor.set(s.satisfiesOpId, arr);
  }

  const groups = new Map<
    string,
    RouteDebtGroup & { passportIds: Set<string>; employeeSet: Set<string> }
  >();

  for (const p of passports) {
    if (p.currentRouteStepIndex === null) continue;
    const steps = stepsByOrder.get(p.orderId);
    if (!steps || steps.length === 0) continue;

    // Порядковый номер вхождения операции в маршрут (0, 1, 2...): по
    // `operationId` повторные шаги неразличимы, а различать их надо —
    // «оверлок сделан» относится к конкретному проходу.
    const ordinalByIndex = new Map<number, number>();
    const seen = new Map<string, number>();
    for (const s of [...steps].sort((a, b) => a.index - b.index)) {
      const n = seen.get(s.operationId) ?? 0;
      ordinalByIndex.set(s.index, n);
      seen.set(s.operationId, n + 1);
    }

    const passes = new Map<string, number>();
    for (const opId of p.finishedOperationIds) {
      passes.set(opId, (passes.get(opId) ?? 0) + 1);
    }
    const passesFor = (opId: string): number =>
      (passes.get(opId) ?? 0) +
      (substitutesFor.get(opId) ?? []).reduce(
        (acc, sub) => acc + (passes.get(sub) ?? 0),
        0,
      );

    for (const step of steps) {
      if (step.index >= p.currentRouteStepIndex) continue;
      if (!step.isSewing) continue;
      if (step.parallelGroup !== null) continue;
      if (passesFor(step.operationId) > (ordinalByIndex.get(step.index) ?? 0)) {
        continue;
      }

      const issue = p.issuedByOperation.get(step.operationId);
      const reason: RouteDebtReason = issue ? 'ABANDONED' : 'SKIPPED';
      const key = `${p.orderId} ${step.operationId} ${reason}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.passportIds.has(p.passportId)) {
          existing.passportIds.add(p.passportId);
          existing.qty += p.qty;
        }
        if (issue) {
          if (issue.employeeName) existing.employeeSet.add(issue.employeeName);
          if (!existing.firstAt || issue.at < existing.firstAt) {
            existing.firstAt = issue.at;
          }
          if (!existing.lastAt || issue.at > existing.lastAt) {
            existing.lastAt = issue.at;
          }
        }
        continue;
      }
      groups.set(key, {
        orderId: p.orderId,
        orderNumber: p.orderNumber,
        operationId: step.operationId,
        operationCode: step.operationCode,
        operationName: step.operationName,
        reason,
        passportCount: 0,
        qty: p.qty,
        employees: [],
        firstAt: issue?.at ?? null,
        lastAt: issue?.at ?? null,
        passportIds: new Set([p.passportId]),
        employeeSet: new Set(issue?.employeeName ? [issue.employeeName] : []),
      });
    }
  }

  return [...groups.values()]
    .map(({ passportIds, employeeSet, ...g }) => ({
      ...g,
      passportCount: passportIds.size,
      employees: [...employeeSet].sort(),
    }))
    .sort((a, b) => {
      if (a.firstAt && b.firstAt) {
        return a.firstAt.getTime() - b.firstAt.getTime();
      }
      if (a.firstAt) return -1;
      if (b.firstAt) return 1;
      return b.passportCount - a.passportCount;
    });
}
