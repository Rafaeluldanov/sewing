/**
 * Контракты scan-driven терминала ВТО (role-terminal `/wto`).
 *
 * Полный аналог `qc.ts`: backend двигает паспорт по экранам без
 * изменения `Passport.status`, фронт показывает «работа сейчас» и
 * свернутую «ВТО завершено» строку. Источник истины и инварианты —
 * `docs/flows.md §F6`, `docs/screens.md §10`,
 * `docs/adr/0013-shopfloor-stage-mapping.md` (раздел «WTO_DONE bucket»).
 *
 * Доступ — роли `IRONING` (основная) и `SHOP_MANAGER`/`ADMIN`
 * (наблюдение). RBAC проверяется в `tests/integration/role-rbac.test.ts`.
 *
 * Скоуп MVP-роли:
 * - принять паспорт по сканированию (создать `OPERATION_SCAN` на
 *   операции ВТО — это делает существующий `POST /api/passports/:id/scan`,
 *   ВТО-модуль только проксирует ради единого терминала и общего
 *   error-mapping'а);
 * - завершить ВТО кнопкой «Завершить ВТО» — создаёт
 *   `PassportEvent(WTO_PASSED)` через `POST /api/wto/passports/:id/complete`;
 * - получать карточку ВТО, в которой backend сообщает фронту, надо ли
 *   уже убирать свернутую строку (`removedFromWto`).
 *
 * Ключевое бизнес-правило (gate): ВТО не может принять паспорт, по
 * которому ещё нет `PassportEvent(QC_PASSED)`. Проверяется в
 * `PassportsService.scanOnOperation` и в `WtoService.acceptOnWto`,
 * чтобы scan-driven flow нельзя было обойти ни через `/api/passports`,
 * ни через `/api/wto`.
 */

import type { PassportStatus } from './passports';

// ---------------------------------------------------------------------------
// View-models
// ---------------------------------------------------------------------------

/**
 * Карточка ВТО (`GET /api/wto/passports/:id`).
 *
 * Структурно близка к `QcPassportDetailDto`, но без полей про дефекты:
 * фиксация брака — прерогатива ОТК (`docs/flows.md §F5`), ВТО только
 * подтверждает, что обработка сделана.
 */
export interface WtoPassportDetailDto {
  passportId: string;
  passportNumber: string;
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  sizeId: string;
  sizeCode: string;
  sizeSortOrder: number;
  qtyCut: number;
  qtyDefect: number;
  qtyGood: number;
  qtyPlan: number;
  status: PassportStatus;
  rollNumber: string;
  cutDate: string; // ISO
  createdAt: string; // ISO
  updatedAt: string; // ISO
  currentOperationCode: string | null;
  currentOperationName: string | null;
  currentEmployeeId: string | null;
  currentEmployeeName: string | null;
  /**
   * Когда ВТО последний раз нажал «Завершить ВТО» по этому паспорту
   * (`PassportEvent(WTO_PASSED)`). `null` — ВТО ещё не подтвердил.
   * Аудит-маркер: `Passport.status` не меняется.
   */
  wtoCompletedAt: string | null;
  /**
   * Можно ли сейчас нажать «Завершить ВТО». MVP-правило: статус
   * `IN_PROGRESS` И `currentOperation.category = IRONING` (т.е. паспорт
   * реально сейчас на операции ВТО, иначе кнопка бессмысленна).
   * Доп. правило `qcPassedAt != null` уже гарантировано QC-gate'ом на
   * входном скане — но `canCompleteWto` его не повторяет, чтобы UI
   * мог явно показать причину «не на ВТО» и «нет ОТК» по разным полям.
   */
  canCompleteWto: boolean;
  /**
   * Когда по паспорту последний раз был зафиксирован `QC_PASSED`.
   * UI использует, чтобы предупреждать «без ОТК нельзя» до момента,
   * когда сотрудник ВТО физически отсканирует паспорт. На MVP
   * показываем как просто метку «ОТК прошло такого-то».
   */
  qcPassedAt: string | null;
  /**
   * Backend-сигнал «паспорт уже ушёл с ВТО» — полный аналог
   * `removedFromQc` в `qc.ts`. `true`, если ВТО уже подтверждал
   * «Завершить ВТО» И паспорт после этого либо стал терминальным
   * (`PACKED`/`CANCELLED`), либо был отсканирован на следующей
   * операции (свежий `OPERATION_SCAN` после `wtoCompletedAt`). В этом
   * случае scan-driven терминал ВТО (`apps/web/app/wto/wto-terminal.tsx`)
   * убирает свернутую строку «ВТО завершено» из окна.
   */
  removedFromWto: boolean;
}
