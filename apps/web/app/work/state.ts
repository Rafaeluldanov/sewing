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
    /**
     * ID и id размера паспорта — нужны UI-проверке очереди выдачи
     * кроя на /work: сравниваем `orderId`/`sizeCode` с активным
     * баннером и, если паспорт «не очередного» размера, поднимаем
     * модалку «не тот размер» вместо `PassportConfirmModal`.
     * Реальная защита остаётся на бэке (`evaluateForIssue` бросит
     * 409, даже если фронт проворонит); это UX-оптимизация, чтобы
     * швея не тратила шаг на визуальную сверку зря.
     */
    orderId: string;
    sizeId: string;
    sizeCode: string;
    qtyCut: number;
    qtyGood: number;
    productName: string;
    color: string;
    status: string;
    rollNumber: string;
    routeHint: PassportRouteHintDto | null;
    /**
     * Soft-route MVP: индекс текущего шага маршрута
     * (`Passport.currentRouteStepIndex`). Используется UI-логикой /work
     * как **единственный признак route-WIP паспорта** — backend по тому же
     * правилу разрешает приём без `currentCell` (см.
     * `PassportsService.issueToEmployee`, `docs/domain.md §«Маршруты
     * производства»`). Если `null` — паспорт идёт по legacy cell-based
     * flow и UI продолжает требовать ячейку, как раньше.
     */
    currentRouteStepIndex: number | null;
    /**
     * Текущая ячейка паспорта (lite). `null` для route-WIP в маршрутном
     * потоке (между шагами без буфера) и для свежих CREATED паспортов
     * до размещения. UI использует это, чтобы не показывать тревожный
     * текст «ячейка не указана» там, где её и не должно быть.
     */
    currentCellCode: string | null;
  };
}

export interface PassportLookupError {
  ok: false;
  error: string;
  errorRequestId?: string;
}

export type PassportLookupResponse = PassportLookupResult | PassportLookupError;

export const initialWorkFormState: WorkFormState = {};
