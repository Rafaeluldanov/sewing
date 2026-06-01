/**
 * Контракты модуля «Мастер цеха» (MVP, ADR/задача "shopfloor master").
 *
 * Источник истины — `apps/api/src/modules/master-calls/*`,
 * `prisma/schema.prisma` (`MasterCall`, `MasterCallStatus`, роль
 * `SHOPFLOOR_MASTER`), а также `docs/domain.md §«Мастер цеха»` и
 * `docs/flows.md §«Вызов мастера»`.
 *
 * Здесь описаны:
 *   - схемы тел запросов (`POST /api/master-calls`,
 *     `POST /api/master-calls/resolve-by-employee-qr`);
 *   - DTO открытого вызова, который backend отдаёт `/master`
 *     (`GET /api/master-calls`).
 *
 * Минимально достаточный набор полей для двух экранов:
 *   - мобильный `/master` (карточка вызова в очереди);
 *   - кнопка «Мастер» на рабочих терминалах (статус «вызван / закрыт»).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MASTER_CALL_STATUSES = ['OPEN', 'RESOLVED', 'CANCELLED'] as const;
export const MasterCallStatusSchema = z.enum(MASTER_CALL_STATUSES);
export type MasterCallStatus = z.infer<typeof MasterCallStatusSchema>;

/**
 * Префикс QR-кода сотрудника.
 *
 * QR на печатной этикетке `/api/employees/:id/print` всегда имеет
 * payload вида `EMPLOYEE:<employeeId>` (см.
 * `apps/api/src/modules/employees/employees.controller.ts`). Тот же
 * префикс используется и при resolve-by-QR на `/master` — единое
 * место константы, чтобы UI и backend не разъезжались.
 *
 * Регистр payload'а на считывателе — как есть. UI на `/master`
 * нормализует ведущий префикс case-insensitively через
 * `parseEmployeeQr` ниже, чтобы случайный `employee:abc` тоже
 * сработал.
 */
export const EMPLOYEE_QR_PREFIX = 'EMPLOYEE:';

/**
 * Парсит payload QR-кода сотрудника. Возвращает `employeeId` или
 * `null`, если строка не соответствует ожидаемому формату.
 *
 * Принимает как канонический `EMPLOYEE:<id>`, так и его lower-case
 * вариант (некоторые сканеры отдают всё в нижнем регистре).
 */
export function parseEmployeeQr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  const prefix = EMPLOYEE_QR_PREFIX.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const id = trimmed.slice(EMPLOYEE_QR_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * Тело `POST /api/master-calls`.
 *
 * Все поля опциональны: рабочему достаточно нажать одну кнопку, чтобы
 * сообщить «нужен мастер». `message` зарезервирован под будущий
 * сценарий «короткий комментарий», на MVP UI его не отправляет.
 */
export const CreateMasterCallSchema = z.object({
  message: z.string().trim().min(1).max(500).optional(),
});
export type CreateMasterCallDto = z.infer<typeof CreateMasterCallSchema>;

/**
 * Тело `POST /api/master-calls/resolve-by-employee-qr`.
 *
 * `qr` — payload, считанный камерой на `/master`. Допускаем как
 * `EMPLOYEE:<id>`, так и его lower-case вариант (см.
 * `parseEmployeeQr`). Жёсткая Zod-валидация формата сделана здесь,
 * чтобы backend сразу возвращал `VALIDATION_ERROR` без прохода в
 * сервис.
 */
export const ResolveMasterCallByQrSchema = z.object({
  qr: z
    .string()
    .trim()
    .min(EMPLOYEE_QR_PREFIX.length + 1, 'QR должен содержать EMPLOYEE:<id>')
    .max(200)
    .refine(
      (v) => parseEmployeeQr(v) !== null,
      'Некорректный QR сотрудника (ожидается EMPLOYEE:<id>)',
    ),
});
export type ResolveMasterCallByQrDto = z.infer<
  typeof ResolveMasterCallByQrSchema
>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------

/**
 * Один открытый вызов мастера, как его видит мобильный `/master`.
 *
 * Минимальный набор полей: «кто звал», «где он стоит» (оборудование +
 * операция, если есть открытая смена), «сколько ждёт» и «какие
 * паспорта сейчас на нём». Этого достаточно, чтобы мастер цеха,
 * подойдя к станку, нашёл сотрудника и понял контекст без открытия
 * других экранов.
 *
 * `currentPassports` — компактный срез по паспортам, привязанным к
 * текущей смене сотрудника (тот же fallback, что использует
 * `ShopfloorService.listEquipmentStatus` для `currentSizes`). Список
 * сознательно ограничен по длине на стороне backend'а, чтобы карточка
 * не разрасталась на телефоне.
 */
/**
 * Один шаг snapshot маршрута заказа в составе паспорта (Stage 2
 * «Действия мастера»). UI на `/master` рендерит этот список в
 * bottom-sheet «Назначить операцию», чтобы мастер мог выбрать шаг,
 * который реально известен паспорту (snapshot привязан к заказу,
 * см. `OrderRouteStep` в `prisma/schema.prisma`).
 *
 * `isCurrent` — подсказка для UI (выделить текущий шаг). Backend
 * считает её относительно `Passport.currentRouteStepIndex`.
 */
export interface MasterCallRouteStepDto {
  index: number;
  operationId: string;
  operationName: string;
  isCurrent: boolean;
}

export interface MasterCallPassportDto {
  /** `Passport.id` — нужен для action-эндпоинтов `/api/master-actions/passports/:id/...`. */
  id: string;
  /** Номер самого паспорта (`Passport.number`, например `P-20260505-0191`),
   *  НЕ номер заказа — для заказа есть отдельное поле `orderNumber`. */
  number: string;
  /** Код размера (`Size.code`, например `M`). */
  size: string;
  /** Цвет паспорта (свободная строка из заказа), может отсутствовать. */
  color: string | null;
  /**
   * Кол-во вырезанных штук в паспорте (`Passport.qtyCut`). Нужен на
   * mobile-карточке мастера: помогает быстро прикинуть «насколько
   * критична передача» и в bottom-sheet «Вернуть в ячейку» — это та
   * самая сумма, на которую увеличится `CellContent.quantity`.
   */
  qtyCut: number;
  /** Статус паспорта — `CREATED` / `IN_PROGRESS` / `PACKED` / `CANCELLED`. */
  status: 'CREATED' | 'IN_PROGRESS' | 'PACKED' | 'CANCELLED';
  /** Номер заказа (`Order.number`) — мастеру важно различить «Заказ 1024» и «Заказ 1025». */
  orderNumber: string;
  /** Текущая операция паспорта или `null`. */
  currentOperation: { id: string; name: string } | null;
  /** Текущая ячейка паспорта или `null` (если паспорт «на руках»). */
  currentCell: { id: string; code: string } | null;
  /** Индекс шага в snapshot маршрута (`Passport.currentRouteStepIndex`). */
  currentRouteStepIndex: number | null;
  /**
   * Snapshot маршрута заказа — операции, доступные мастеру для
   * «Назначить операцию маршрута». Пустой массив, если у заказа нет
   * snapshot'а (старые заказы / без RouteTemplate).
   */
  routeSteps: MasterCallRouteStepDto[];
}

export interface MasterCallDto {
  id: string;
  status: MasterCallStatus;
  /**
   * ISO-метка создания вызова. UI на `/master` использует её для
   * расчёта «ожидает N мин» прямо в браузере (тот же подход, что у
   * часов на `/shopfloor/display`).
   */
  createdAt: string;
  /** ISO-метка закрытия. `null` для `OPEN`. */
  resolvedAt: string | null;
  /** Опциональное сообщение от рабочего (на MVP всегда `null`). */
  message: string | null;
  employee: {
    id: string;
    fullName: string;
    role: string;
  };
  /**
   * Снимок оборудования, на котором сейчас работает сотрудник. `null`,
   * если у него нет активной смены (сценарий: рабочий нажал «Мастер»
   * до старта смены — мы всё равно создаём вызов).
   */
  equipment: {
    id: string;
    code: string;
    name: string;
    displayNumber: string | null;
  } | null;
  /** Текущая операция активной смены сотрудника. */
  operation: {
    id: string;
    name: string;
  } | null;
  /**
   * Срез паспортов сотрудника на текущей смене. Пустой массив, если
   * паспорта на сотруднике нет / смена не открыта.
   */
  currentPassports: MasterCallPassportDto[];
}
