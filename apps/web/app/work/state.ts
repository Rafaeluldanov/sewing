import type { PassportRouteHintDto } from '@sewing/shared/passports';

export interface WorkFormState {
  error?: string;
  /**
   * Сквозной идентификатор запроса (Шаг 12, Pilot Rollout).
   * Если у ошибки есть `requestId`, /work показывает его рядом с
   * сообщением — оператор называет его поддержке (см. `docs/pilot/faq.md`).
   */
  errorRequestId?: string;
  info?: string;
  passport?: {
    id: string;
    number: string;
    sizeCode: string;
    qtyCut: number;
    qtyGood: number;
    productName: string;
    color: string;
    status: string;
    rollNumber?: string;
  };
}

/**
 * Результат «найти паспорт по коду» (используется в seamstress flow для
 * визуальной сверки перед issue/scan). Это узкий контракт без побочных
 * эффектов — отдельно от `WorkFormState`, чтобы не путать с finalize-формами.
 *
 * Soft-route MVP (STEP 8 ТЗ): прокидываем `routeHint` из backend (поле
 * `PassportDetailDto.routeHint`), чтобы модалка `PassportConfirmModal`
 * показала текущий/следующий шаг маршрута и warning, если активная
 * смена не совпадает с ожидаемым шагом. Никакой блокировки — только
 * визуальная подсказка.
 */
export interface PassportLookupResult {
  ok: true;
  passport: {
    id: string;
    number: string;
    sizeCode: string;
    qtyCut: number;
    qtyGood: number;
    productName: string;
    color: string;
    status: string;
    rollNumber: string;
    routeHint: PassportRouteHintDto | null;
  };
}

export interface PassportLookupError {
  ok: false;
  error: string;
  errorRequestId?: string;
}

export type PassportLookupResponse = PassportLookupResult | PassportLookupError;

export const initialWorkFormState: WorkFormState = {};
