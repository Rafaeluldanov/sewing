'use server';

import { revalidatePath } from 'next/cache';
import {
  StartShiftSchema,
  type StartShiftDto,
} from '@sewing/shared/shifts';
import { ApiRequestError, errorText } from '@/lib/api';
import {
  closeUnclosedOperation,
  completePassportOperation,
  completePassportOperationsBatch,
  findPassportByCode,
  getMyRework,
  getMyUnclosed,
  issuePassport,
  scanPassport,
  startShift,
  stopShift,
  switchShiftOperation,
} from '@/lib/shifts-api';
import type {
  BatchCompleteOperationsResultDto,
  ReworkPassportDto,
  UnclosedWorkPassportDto,
} from '@sewing/shared/shifts';
import type { PassportLookupResponse, WorkFormState } from './state';

/**
 * Инвалидация ВСЕХ экранов, где живёт швейный scan-flow.
 *
 * Долгое время это был один `revalidatePath('/work')`, и он был верен:
 * панель швеи рендерилась только на `/work`. Теперь `/packing` в режиме
 * некоробочной операции («Распаковка», см. `packing-terminal.tsx`)
 * рендерит те же `SeamstressActivePanel` и `OperationSwitcher` и зовёт
 * ЭТИ ЖЕ actions — значит и маршрут упаковщика обязан инвалидироваться,
 * иначе после скана он остался бы на старом SSR-снимке (`currentWork`
 * приходит из server-component, а не из ответа action'а).
 *
 * Не экспортируем: в `'use server'`-файле любой экспорт обязан быть
 * async (см. инцидент с `initialXxxFormState` — падало в рантайме, а
 * tsc/lint молчали).
 */
function revalidateWorkSurfaces(): void {
  revalidatePath('/work');
  revalidatePath('/packing');
}

/**
 * Список API error-кодов, для которых backend уже формирует
 * полностью готовый текст для отображения сотруднику — без префикса
 * `[CODE] ` от UI.
 *
 * Stage 3 «Мастер цеха» (`CUT_RELEASE_POLICY_VIOLATION`): backend
 * присылает строку вида «Сейчас разрешена выдача только: Чёрный XS,
 * лимит 100 шт.», которую ТЗ требует показать рабочему ровно как
 * inline-message — без code-префикса, без «обратитесь к мастеру»,
 * без alert-обёрток (см. также `seamstress-active-panel.tsx`).
 *
 * «Очередь выдачи кроя» (`ORDER_CUT_ISSUE_RULE_VIOLATION`):
 * backend формирует строку вида «Сначала нужно выдать: S — осталось
 * 20 шт, M — осталось 10 шт, 4XL — осталось 50 шт». UI показывает
 * её inline-сообщением — без code-префикса (см. помощник
 * `formatOrderCutIssueRuleViolationMessage` в `@sewing/shared`).
 */
const RAW_API_ERROR_CODES = new Set([
  'CUT_RELEASE_POLICY_VIOLATION',
  'ORDER_CUT_ISSUE_RULE_VIOLATION',
  'PASSPORT_SCAN_BACKWARD',
  'PASSPORT_ISSUE_BACKWARD',
  // Гейт «крой не размещён в ячейке» — backend уже присылает готовую
  // подсказку «Помощник раскройщика должен разместить паспорт в
  // ячейку…», показываем её рабочему как есть.
  'PASSPORT_NOT_PLACED_IN_CELL',
]);

function explainApiError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.code && RAW_API_ERROR_CODES.has(e.code)) {
      return e.message;
    }
    return errorText(e);
  }
  return 'Не удалось выполнить запрос';
}

function errorRequestId(e: unknown): string | undefined {
  return e instanceof ApiRequestError ? e.requestId : undefined;
}

// ---------------------------------------------------------------------------
// Shift start / stop. С MVP 1.1 employeeId берётся из сессии на API.
// ---------------------------------------------------------------------------

export async function startShiftAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const raw: StartShiftDto = {
    equipmentId: String(form.get('equipmentId') ?? '').trim(),
    operationId: String(form.get('operationId') ?? '').trim(),
  };
  const parsed = StartShiftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? 'Невалидные данные',
    };
  }
  try {
    await startShift(parsed.data);
    revalidateWorkSurfaces();
    return { info: 'Смена начата' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

export async function stopShiftAction(
  _prev: WorkFormState,
  _form: FormData,
): Promise<WorkFormState> {
  try {
    await stopShift();
    revalidateWorkSurfaces();
    return { info: 'Смена завершена' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

/**
 * Сменить операцию в активной смене без stop/start. Backend требует,
 * чтобы у швеи сейчас не было паспортов в работе
 * (`SHIFT_HAS_ACTIVE_PASSPORTS`) — UI достаёт сообщение из ответа.
 */
export async function switchShiftOperationAction(
  operationId: string,
): Promise<WorkFormState> {
  const id = operationId.trim();
  if (!id) return { error: 'operationId обязателен' };
  try {
    await switchShiftOperation({ operationId: id });
    revalidateWorkSurfaces();
    return { info: 'Операция смены изменена' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

// ---------------------------------------------------------------------------
// Issue (получить крой) / scan (любое сканирование = переход)
// ---------------------------------------------------------------------------

async function runWithPassport(
  code: string,
  op: (passportId: string) => Promise<unknown>,
  successMessage: string,
): Promise<WorkFormState> {
  const trimmed = code.trim();
  if (!trimmed) return { error: 'Введите или отсканируйте код паспорта' };
  try {
    const passport = await findPassportByCode(trimmed);
    const updated = (await op(passport.id)) as Awaited<
      ReturnType<typeof findPassportByCode>
    >;
    revalidateWorkSurfaces();
    revalidatePath(`/passports/${passport.id}`);
    revalidatePath(`/admin/passports/${passport.id}`);
    revalidatePath(`/orders/${passport.orderId}`);
    revalidatePath(`/admin/orders/${passport.orderId}`);
    return {
      info: successMessage,
      passport: {
        id: updated.id,
        number: updated.number,
        sizeCode: updated.sizeCode,
        qtyCut: updated.qtyCut,
        qtyGood: updated.qtyGood,
        productName: updated.productName,
        color: updated.color,
        status: updated.status,
        rollNumber: updated.rollNumber,
      },
    };
  } catch (e) {
    // Гейт «крой не размещён в ячейке» — не ошибка, а ожидаемая
    // ситуация: показываем мягкое предупреждение вместо красной
    // плашки (см. `WorkFormState.warning`).
    if (e instanceof ApiRequestError && e.code === 'PASSPORT_NOT_PLACED_IN_CELL') {
      return { warning: e.message, errorRequestId: errorRequestId(e) };
    }
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

/**
 * Найти паспорт по коду — БЕЗ побочных эффектов (не делает issue/scan).
 *
 * Используется в seamstress flow на /work для модалки сверки: швея
 * сканирует QR паспорта, видит крупно номер/изделие/размер/количество и
 * либо подтверждает («Принять» → `acceptPassportForIssueAction`), либо
 * отменяет и пересканирует.
 */
export async function lookupPassportAction(
  code: string,
): Promise<PassportLookupResponse> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, error: 'Введите или отсканируйте код паспорта' };
  try {
    const p = await findPassportByCode(trimmed);
    return {
      ok: true,
      passport: {
        id: p.id,
        number: p.number,
        orderId: p.orderId,
        sizeId: p.sizeId,
        sizeCode: p.sizeCode,
        qtyCut: p.qtyCut,
        qtyGood: p.qtyGood,
        productName: p.productName,
        color: p.color,
        status: p.status,
        rollNumber: p.rollNumber,
        // Soft-route MVP (STEP 8 ТЗ): прокидываем route hint в UI
        // модалку проверки. Backend заполнил `routeHint`, сравнив
        // активную смену сотрудника с ожидаемым шагом маршрута.
        // Если у заказа нет snapshot маршрута — здесь будет null.
        routeHint: p.routeHint ?? null,
        // Route-WIP UI-критерий: симметричен серверному правилу
        // `PassportsService.issueToEmployee` — паспорт считается «в
        // маршрутном потоке», если `currentRouteStepIndex !== null`
        // (snapshot маршрута проставляется при `Passport.create()`).
        // UI на основе этого поля решает, требовать ли ячейку и какой
        // copy показывать в `PassportConfirmModal`.
        currentRouteStepIndex: p.currentRouteStepIndex,
        currentCellCode: p.currentCell?.code ?? null,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * «Принять» паспорт после визуальной сверки в модалке seamstress flow.
 *
 * Логика — та же, что у `issuePassportAction`: проксируем `id` через
 * `findPassportByCode` (поддерживает голый id, см. ADR-0008) и зовём
 * `issuePassport`. Сохраняем revalidate, чтобы `/passports/:id` и
 * связанный заказ обновили свой server-render.
 */
export async function acceptPassportForIssueAction(
  passportId: string,
): Promise<WorkFormState> {
  return runWithPassport(passportId, (id) => issuePassport(id), 'Крой принят');
}

/**
 * «Завершить операцию» после визуальной сверки в seamstress flow.
 *
 * Симметрично `acceptPassportForIssueAction`: проксируем `id` через
 * `findPassportByCode` (поддерживает голый id, см. ADR-0008), вызываем
 * `completePassportOperation` и инвалидируем кэши `/work`, `/passports/:id`
 * и связанного заказа, чтобы блок «Текущий крой» сразу освежился.
 */
export async function completePassportOperationAction(
  passportId: string,
): Promise<WorkFormState> {
  return runWithPassport(
    passportId,
    (id) => completePassportOperation(id),
    'Операция завершена',
  );
}

/**
 * Результат пакетного завершения для клиента `/work`. `ok=false` —
 * сам запрос не прошёл (сеть / 4xx-валидация); `ok=true` — запрос
 * выполнен, но внутри `result.failed` могут быть паспорта, которые
 * не закрылись (партиальный успех, см.
 * `PassportsService.completeOperationsBatch`).
 */
export interface BatchCompleteActionResult {
  ok: boolean;
  result?: BatchCompleteOperationsResultDto;
  error?: string;
  errorRequestId?: string;
}

/**
 * «Завершить выбранные» — пакетное завершение операций по паспортам,
 * отмеченным чекбоксами в блоке «Текущий крой». Паспорта уже
 * закреплены за швеёй (`currentEmployeeId = me`), повторный скан не
 * нужен. Инвалидируем `/work` (чтобы закрытые паспорта ушли из
 * «Текущий крой») и карточки успешно завершённых паспортов.
 */
export async function batchCompletePassportsAction(
  passportIds: string[],
): Promise<BatchCompleteActionResult> {
  const ids = passportIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { ok: false, error: 'Выберите хотя бы один паспорт' };
  }
  try {
    const result = await completePassportOperationsBatch(ids);
    revalidateWorkSurfaces();
    for (const c of result.completed) {
      revalidatePath(`/passports/${c.passportId}`);
      revalidatePath(`/admin/passports/${c.passportId}`);
    }
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: explainApiError(e),
      errorRequestId: errorRequestId(e),
    };
  }
}

/**
 * Лёгкий поллинг секции «К переделке от ОТК» из клиента seamstress
 * flow (`seamstress-active-panel.tsx`). Возвращает тот же список, что
 * грузит `page.tsx` при server-render, но без `router.refresh()` —
 * чтобы детектить новый брак и проиграть звуковую тревогу, не
 * перерисовывая весь экран.
 *
 * Fail-soft, как `loadMyReworkSafely` в `page.tsx`: бизнес-ошибку
 * backend гасим в пустой список (клиентский поллинг и так обёрнут в
 * try/catch), чтобы не спамить ошибками в фоне.
 */
export async function loadMyReworkAction(): Promise<ReworkPassportDto[]> {
  try {
    return await getMyRework();
  } catch (e) {
    if (e instanceof ApiRequestError) return [];
    throw e;
  }
}

/**
 * Поллинг/перечитывание секции «Не закрыто вами» из клиента
 * seamstress-flow. Fail-soft, как `loadMyReworkAction`.
 */
export async function loadMyUnclosedAction(): Promise<
  UnclosedWorkPassportDto[]
> {
  try {
    return await getMyUnclosed();
  } catch (e) {
    if (e instanceof ApiRequestError) return [];
    throw e;
  }
}

/**
 * «Закрыть операцию» из секции «Не закрыто вами». Паспорт при этом НЕ
 * двигается по маршруту (см.
 * `PassportsService.closeUnclosedOperationByEmployee`) — поэтому
 * инвалидируем только рабочие экраны и карточку самого паспорта.
 */
export async function closeUnclosedOperationAction(
  passportId: string,
): Promise<WorkFormState> {
  const id = passportId.trim();
  if (!id) return { error: 'Не указан паспорт' };
  try {
    await closeUnclosedOperation(id);
    revalidateWorkSurfaces();
    revalidatePath(`/passports/${id}`);
    revalidatePath(`/admin/passports/${id}`);
    return { info: 'Операция закрыта, работа зачтена' };
  } catch (e) {
    return { error: explainApiError(e), errorRequestId: errorRequestId(e) };
  }
}

export async function issuePassportAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const code = String(form.get('code') ?? '');
  return runWithPassport(code, (id) => issuePassport(id), 'Крой получен');
}

export async function scanPassportAction(
  _prev: WorkFormState,
  form: FormData,
): Promise<WorkFormState> {
  const code = String(form.get('code') ?? '');
  return runWithPassport(
    code,
    (id) => scanPassport(id),
    'Паспорт принят на операцию',
  );
}
