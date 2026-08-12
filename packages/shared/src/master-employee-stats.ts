/**
 * Контракты «Статистика по сотрудникам» для кабинета мастера
 * (`apps/api/src/modules/master-employee-stats/*`, вкладка «Сотрудники»
 * в `apps/web/app/master`).
 *
 * Назначение: дать `SHOPFLOOR_MASTER` (и `SHOP_MANAGER` / `ADMIN`)
 * сводку «кто сколько сделал» за произвольный период. Таблица —
 * строка = сотрудник, колонки = его операции + итоги; провал в строку →
 * полная разбивка по операциям и по дням.
 *
 * Источник «сделанного» — события `PassportEvent.type =
 * OPERATION_FINISHED` (см. memory `project_no_operation_scan_events`:
 * реальный флоу = `ISSUED_TO_EMPLOYEE → OPERATION_FINISHED` без SCAN).
 * Это универсальная метка «операция закрыта» для ЛЮБОГО типа оплаты
 * (сдельщина/оклад) — в отличие от `OperationEntry`, который есть только
 * у сдельных. Считаем по `OPERATION_FINISHED.employeeId`:
 *   - `qty` штук = Σ `PassportEvent.qty` (он = `Passport.qtyGood` на
 *     момент закрытия операции);
 *   - паспортов = число РАЗНЫХ `passportId`;
 *   - операций = число самих событий `OPERATION_FINISHED` (один акт
 *     закрытия операции; rework по той же паре даёт второй акт).
 *
 * Брак (`defects`) атрибутируется ИСПОЛНИТЕЛЮ операции, а не тому, кто
 * его зафиксировал. `DEFECT_RECORDED` привязан к `(passportId,
 * operationId)`; владелец брака = сотрудник, закрывший эту же пару
 * `OPERATION_FINISHED` (последний финишёр). Семантика — «брак, найденный
 * на операциях, которые закрыл сотрудник». Окно брака — по
 * `DEFECT_RECORDED.createdAt` (день фиксации), финиш ищется без окна.
 *
 * Окно периода выработки — по `OPERATION_FINISHED.createdAt`. Период
 * задаёт сам мастер (`from`/`to`, UTC-`YYYY-MM-DD`), без фиксированных
 * 7/14/30; по умолчанию UI стартует с одного дня (сегодня).
 * Статистика — read-only (сервис только агрегирует).
 *
 * Вторая часть вкладки — режим «Активные» (`MasterActiveShift*`):
 * список открытых смен (`ShiftSession.endedAt = null`) прямо сейчас
 * плюс единственная мутация — принудительное завершение смены мастером
 * (сотрудники забывают закрываться сами).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Период статистики по сотрудникам — произвольный диапазон по дате
 * закрытия операции (`OPERATION_FINISHED.createdAt`, UTC-день).
 * `from`/`to` включительны: `to` разворачивается в конец дня на бэке.
 */
export const MasterEmployeeStatsQuerySchema = z.object({
  from: z.string().regex(DAY_RE),
  to: z.string().regex(DAY_RE),
});
export type MasterEmployeeStatsQuery = z.infer<
  typeof MasterEmployeeStatsQuerySchema
>;

/** Тот же период + конкретный сотрудник (провал в строку таблицы). */
export const MasterEmployeeStatsDrillQuerySchema =
  MasterEmployeeStatsQuerySchema.extend({
    employeeId: z.string().min(1),
  });
export type MasterEmployeeStatsDrillQuery = z.infer<
  typeof MasterEmployeeStatsDrillQuerySchema
>;

// ---------------------------------------------------------------------------
// Response: list
// ---------------------------------------------------------------------------

export interface MasterEmployeeOpStatDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  /** Разных паспортов, закрытых сотрудником на этой операции. */
  passports: number;
  /** Σ `qty` (штук) по этой операции. */
  qty: number;
  /** Σ брака (`DEFECT_RECORDED.qty`), найденного на этой операции. */
  defects: number;
}

/**
 * Кусок мини-ленты дня в строке списка: та же раскраска участков, что в
 * табеле, только без подписей. Заполняется ТОЛЬКО когда период = одни
 * сутки (`from === to`) — на неделе лента превратилась бы в кашу.
 *
 * `startMinute` — минут от начала московских суток (0–1440), чтобы UI
 * не парсил даты ради процента ширины.
 */
export interface MasterEmployeeRibbonPartDto {
  startMinute: number;
  minutes: number;
  /** `OperationCategory` — цвет участка. */
  category: string;
}

export interface MasterEmployeeStatRowDto {
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (enum) — UI вешает свою подпись. */
  role: string;
  /** Разных паспортов, которых касался сотрудник (по всем операциям). */
  totalPassports: number;
  /** Σ `qty` (штук) по всем операциям. */
  totalQty: number;
  /** Σ брака, найденного на операциях этого сотрудника за период. */
  totalDefects: number;
  /** Число актов закрытия операции (`OPERATION_FINISHED`). */
  totalOperations: number;
  /**
   * Разбивка по операциям, отсортирована по `qty` убыв. Список короткий
   * (типов операций немного) — UI показывает топ-N как «операции
   * сотрудника» и полный список при провале.
   */
  operations: MasterEmployeeOpStatDto[];
  /**
   * Время в смене за период, минут (сумма `ShiftSegment`). Ответ на
   * вопрос, которого в списке не было вовсе: «289 штук» без «за сколько
   * часов» не оценивается.
   */
  workedMinutes: number;
  /** Смена открыта прямо сейчас (зелёная точка в списке). */
  hasOpenSegment: boolean;
  /**
   * Открытый отрезок тянется с прошлых суток — сотрудник забыл
   * закрыться (жёлтая плашка). Считается только для `from === to`.
   */
  staleShift: boolean;
  /** Мини-лента дня; пустая, если период больше суток. */
  ribbon: MasterEmployeeRibbonPartDto[];
}

export interface MasterEmployeeStatsDto {
  /** Московские `YYYY-MM-DD`, эхо запроса. */
  from: string;
  to: string;
  /**
   * Сотрудники периода, по `totalQty` убыв.
   *
   * Строка появляется у любого, кто ЛИБО закрыл операцию, ЛИБО был на
   * смене: «отработал 8 часов и не закрыл ничего» — ровно тот случай,
   * ради которого мастер и открывает вкладку, а раньше такой сотрудник
   * в список не попадал вообще.
   */
  rows: MasterEmployeeStatRowDto[];
  /** Серверное «сейчас» (ISO) — от него считаются открытые отрезки. */
  now: string;
}

// ---------------------------------------------------------------------------
// Response: drill (провал в одного сотрудника)
// ---------------------------------------------------------------------------

export interface MasterEmployeeDayStatDto {
  /** UTC-`YYYY-MM-DD`. */
  day: string;
  passports: number;
  qty: number;
  defects: number;
  operations: number;
}

export interface MasterEmployeeDrillDto {
  employeeId: string;
  employeeName: string;
  role: string;
  from: string;
  to: string;
  totalPassports: number;
  totalQty: number;
  totalDefects: number;
  totalOperations: number;
  /** Полная разбивка по операциям, по `qty` убыв. */
  operations: MasterEmployeeOpStatDto[];
  /** Выработка по дням, новые сверху. */
  byDay: MasterEmployeeDayStatDto[];
}

// ---------------------------------------------------------------------------
// Активные смены (режим «Активные» вкладки «Сотрудники»)
// ---------------------------------------------------------------------------

/**
 * Одна открытая смена (`ShiftSession.endedAt = null`) для режима
 * «Активные»: сотрудники забывают закрывать смены, мастер видит список
 * «кто открыт прямо сейчас» и может принудительно завершить смену
 * (`POST /api/master/employee-stats/active-shifts/:shiftId/close`).
 */
export interface MasterActiveShiftDto {
  shiftId: string;
  employeeId: string;
  employeeName: string;
  /** `Employee.role` (enum) — UI вешает свою подпись. */
  role: string;
  equipmentId: string;
  equipmentCode: string;
  equipmentName: string;
  /** Крупный номер стола для цеха (`Equipment.displayNumber`). */
  equipmentDisplayNumber: string | null;
  operationId: string;
  operationName: string;
  /** ISO-8601, момент открытия смены. */
  startedAt: string;
  /**
   * Паспортов `IN_PROGRESS` на руках у сотрудника прямо сейчас
   * (`Passport.currentEmployeeId = employee`). При `> 0` завершение
   * без `force` вернёт `409 SHIFT_HAS_ACTIVE_PASSPORTS`.
   */
  passportsInProgress: number;
  /**
   * У сотрудника идёт подкрой (`RecutSession.status = ACTIVE`) — время
   * доплаты продолжает тикать. Закрытие смены подкрой НЕ останавливает,
   * это только предупреждение мастеру.
   */
  hasActiveRecut: boolean;
}

export interface MasterActiveShiftsDto {
  /**
   * ISO-8601, серверное «сейчас» на момент выборки — от него UI считает
   * длительности смен (не от часов клиента, они могут врать).
   */
  now: string;
  /** Открытые смены, `startedAt` ASC — самые давние (забытые) сверху. */
  rows: MasterActiveShiftDto[];
}

/**
 * Тело принудительного завершения смены мастером. `force: true` —
 * подтверждённый повтор после `409 SHIFT_HAS_ACTIVE_PASSPORTS`
 * (у сотрудника паспорта в работе, UI показал инлайн-подтверждение).
 */
export const ForceCloseShiftSchema = z
  .object({
    force: z.boolean().optional().default(false),
  })
  .strict();
export type ForceCloseShiftDto = z.infer<typeof ForceCloseShiftSchema>;

/**
 * Результат `POST /active-shifts/:shiftId/close`. Смена, уже закрытая к
 * моменту запроса (сотрудник успел сам между GET и POST), — успех-noop
 * (`closed: false`), а не 404/409: список у мастера просто обновится.
 */
export interface MasterCloseShiftResultDto {
  /** `true` — смена закрыта этим запросом; `false` — уже была закрыта. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Доступы (режим «Доступы» вкладки «Сотрудники»)
// ---------------------------------------------------------------------------

/**
 * Роли, которые мастер цеха может выдавать и снимать сам, — участки его
 * цеха. Белый список закрытый и проверяется НА СЕРВЕРЕ: мастер не может
 * ни выдать привилегированную роль (`ADMIN`, `SHOP_MANAGER`, свою
 * `SHOPFLOOR_MASTER`), ни отобрать её у того, кому она уже выдана.
 *
 * `CUTTER_ASSISTANT` в списке есть: помощника ставят из швей. А вот
 * связка `CUTTER + CUTTER_ASSISTANT` одному человеку бессмысленна —
 * выпуск и стеллаж у раскройщика уже во вкладках его кабинета, — и
 * бэкенд отклоняет её отдельной ошибкой (`MASTER_ROLE_PAIR_REDUNDANT`).
 */
export const MASTER_ASSIGNABLE_ROLES = [
  'SEAMSTRESS',
  'QC',
  'IRONING',
  'PACKING',
  'CUTTER',
  'CUTTER_ASSISTANT',
] as const;
export type MasterAssignableRole = (typeof MASTER_ASSIGNABLE_ROLES)[number];

const MASTER_ASSIGNABLE_SET: ReadonlySet<string> = new Set(
  MASTER_ASSIGNABLE_ROLES,
);

export function isMasterAssignableRole(code: string): boolean {
  return MASTER_ASSIGNABLE_SET.has(code);
}

/** Строка списка «Доступы»: сотрудник и его назначенные участки. */
export interface MasterEmployeeAccessDto {
  employeeId: string;
  employeeName: string;
  login: string;
  /** Основная роль (`Employee.role`) — экран по умолчанию, «★». */
  primaryRole: string;
  /** Назначенный набор (`Employee.roles`), включая `primaryRole`. */
  roles: string[];
  /** Активный участок (`activeRole ?? role`) — где сотрудник сейчас. */
  activeRole: string;
  /**
   * `false` — в наборе есть роль вне белого списка мастера (например,
   * начальник цеха). Такую карточку мастер видит, но не редактирует:
   * доступы правит админка.
   */
  editable: boolean;
  /** Открытая смена сотрудника (`null` — смены нет). */
  activeShift: {
    equipmentName: string;
    equipmentDisplayNumber: string | null;
    operationName: string;
  } | null;
}

export interface MasterEmployeeAccessListDto {
  rows: MasterEmployeeAccessDto[];
}

/**
 * Тело `PUT /api/master/employee-stats/access/:employeeId`.
 *
 * Шлём ВЕСЬ набор, а не дельту: редактор чипов работает набором, и
 * «полная замена» исключает гонку двух мастеров (иначе одновременные
 * «сними ОТК» и «добавь ВТО» дали бы неожиданный результат).
 */
export const MasterUpdateEmployeeAccessSchema = z
  .object({
    roles: z
      .array(z.string().trim().min(1))
      .min(1, 'У сотрудника должен остаться хотя бы один участок')
      .max(20),
    primaryRole: z.string().trim().min(1, 'Укажите основной участок'),
  })
  .strict()
  .refine(
    (v) => v.roles.includes(v.primaryRole),
    'Основной участок должен входить в набор',
  );
export type MasterUpdateEmployeeAccessDto = z.infer<
  typeof MasterUpdateEmployeeAccessSchema
>;

// ---------------------------------------------------------------------------
// Табель дня (`GET /api/master/employee-stats/day`)
// ---------------------------------------------------------------------------

/**
 * «Табель дня» — провал в одного сотрудника за одни сутки: где был,
 * сколько времени и сколько сделал.
 *
 * Чем отличается от `MasterEmployeeDrillDto` (соседний drill): тот
 * считает ТОЛЬКО выработку за произвольный период и ничего не знает про
 * время. Табель добавляет ось времени — присутствие, отрезки работы,
 * паузы, распределение по участкам, — поэтому и живёт отдельной ручкой,
 * а не флагом в drill.
 *
 * ВРЕМЯ. Источник — `ShiftSegment` (отрезок смены с неизменной парой
 * «рабочее место + операция», см. `prisma/schema.prisma`). Сегменты
 * появились вместе с этой фичей: до них переключение операции внутри
 * смены не сохранялось нигде, и всё время смены доставалось последней
 * операции. Историю до внедрения бэкфилл восстановил с точностью до
 * УЧАСТКА (один сегмент на смену), поэтому у старых дней разбивка по
 * операциям внутри смены будет грубее — данных для точной не
 * существует.
 *
 * СУТКИ — московские (`moscowDayWindow`), а не UTC: цех живёт по Москве,
 * и вечерняя смена, доработавшая до 01:00, должна остаться в своём дне.
 * Отрезок, пересекающий полночь, обрезается по границе суток — иначе
 * «присутствие» одного дня захватывало бы часы другого.
 *
 * ШТУКИ. По `OPERATION_FINISHED` сотрудника: в отрезке — все события,
 * попавшие в его границы (без сверки операции: при substitute-переходе
 * событие может нести другую операцию, но работа сделана в этом
 * отрезке); в разбивке «по операциям» — группировка по операции самого
 * события. Из-за этого суммы штук по отрезкам и по операциям совпадают,
 * а вот время «по операциям» может слегка разойтись с фактической
 * операцией события — это редкий substitute-случай, осознанный размен.
 *
 * БРАК. Как и везде на вкладке, `defects` — брак, найденный на
 * операциях, которые ЗАКРЫЛ сотрудник (атрибуция исполнителю).
 * Отдельно считаем `defectsFound` — брак, который сотрудник
 * ЗАФИКСИРОВАЛ сам (работа ОТК): это разные числа и путать их нельзя.
 */
export const MasterEmployeeDayQuerySchema = z.object({
  employeeId: z.string().min(1),
  /**
   * Период в МОСКОВСКИХ сутках, включительно. Для табеля одного дня
   * `from === to`; неделя и месяц — тот же контракт с более широким
   * окном (мастер листает период сегмент-контролом «День · Неделя ·
   * Месяц»).
   */
  from: z.string().regex(DAY_RE),
  to: z.string().regex(DAY_RE),
});
export type MasterEmployeeDayQuery = z.infer<
  typeof MasterEmployeeDayQuerySchema
>;

/**
 * Событие внутри отрезка: что именно сотрудник сделал и по какому
 * паспорту. Отдаётся ТОЛЬКО для однодневного периода (`from === to`):
 * за неделю таких строк набегают сотни, а лента дня на неделе всё
 * равно не показывается.
 */
export interface MasterEmployeeDayEventDto {
  /** `OPERATION_FINISHED` — закрыл операцию, `ISSUED_TO_EMPLOYEE` — взял крой. */
  type: 'OPERATION_FINISHED' | 'ISSUED_TO_EMPLOYEE';
  at: string;
  /** Штук (для взятого кроя — `null`). */
  qty: number | null;
  passportNumber: string | null;
  passportColor: string | null;
  passportSizeCode: string | null;
}

/** Строка «часы по дням» — график в режимах «Неделя»/«Месяц». */
export interface MasterEmployeeDayByDayDto {
  /** Московские сутки `YYYY-MM-DD`. */
  day: string;
  minutes: number;
  qty: number;
  defects: number;
}

/** Отрезок работы: одно рабочее место + одна операция. */
export interface MasterEmployeeDaySegmentDto {
  segmentId: string;
  /** ISO; уже обрезан границами московских суток. */
  startedAt: string;
  /** ISO; `null` — отрезок идёт прямо сейчас (считаем до `now`). */
  endedAt: string | null;
  /** Длительность в минутах (для открытого — до серверного `now`). */
  minutes: number;
  equipmentId: string;
  equipmentName: string;
  equipmentDisplayNumber: string | null;
  operationId: string;
  operationName: string;
  /** `OperationCategory` — по ней UI красит участок. */
  category: string;
  /** Штук, закрытых внутри отрезка. */
  qty: number;
  /** Отрезок не закрыт (смена идёт). */
  isOpen: boolean;
  /**
   * Что происходило внутри отрезка — по возрастанию времени. Мастер
   * раскрывает список тапом («3 паспорта»): развёрнутая целиком лента
   * листалась бы минуту и перестала отвечать на «где был» за один
   * взгляд. Пусто, если период больше суток.
   */
  events: MasterEmployeeDayEventDto[];
}

/** Строка «Где был»: участок (категория + рабочее место). */
export interface MasterEmployeeDayPlaceDto {
  /** `category:equipmentId` — ключ для React. */
  key: string;
  category: string;
  equipmentName: string;
  equipmentDisplayNumber: string | null;
  minutes: number;
  /** Доля от времени в смене, 0–100 (округлена). */
  share: number;
  /** Сколько разных операций сотрудник делал на этом месте. */
  operations: number;
}

/** Строка «По операциям» за день. */
export interface MasterEmployeeDayOperationDto {
  operationId: string;
  operationCode: string;
  operationName: string;
  category: string;
  /** Время по сегментам этой операции. */
  minutes: number;
  qty: number;
  defects: number;
  /** Брак, зафиксированный сотрудником на этой операции (ОТК). */
  defectsFound: number;
  /**
   * Норма времени на единицу, сек (`Operation.timeNormSec`). `null` —
   * норма не задана либо задана поразмерно (`timeNormMode = BY_SIZE`):
   * поразмерную без разбивки по размерам к дню не свести.
   */
  normSec: number | null;
  /**
   * Выполнение нормы, %: план (`normSec × qty`) к факту (время
   * сегментов). >100 — быстрее нормы. `null`, если нормы нет или
   * время нулевое.
   */
  normPercent: number | null;
}

export interface MasterEmployeeDayDto {
  employeeId: string;
  employeeName: string;
  role: string;
  /** Эхо запроса, московские сутки. */
  from: string;
  to: string;
  /** Серверное «сейчас» (ISO) — от него считаются открытые отрезки. */
  now: string;
  /**
   * Присутствие: от начала первого отрезка до конца последнего, минут.
   * Не сумма отрезков — включает паузы между ними.
   */
  presenceMinutes: number;
  /** Сумма отрезков, минут («в смене»). */
  workedMinutes: number;
  /** `presenceMinutes − workedMinutes` («вне смены»). */
  idleMinutes: number;
  /** Число пауз между отрезками. */
  breaks: number;
  /** Загрузка, %: `workedMinutes / presenceMinutes`. `null` при нулевом присутствии. */
  utilization: number | null;
  totalQty: number;
  totalDefects: number;
  totalDefectsFound: number;
  /** Переходов = отрезков минус первый (0, если отрезок один). */
  transitions: number;
  /** Есть открытый отрезок — сотрудник на смене прямо сейчас. */
  hasOpenSegment: boolean;
  segments: MasterEmployeeDaySegmentDto[];
  places: MasterEmployeeDayPlaceDto[];
  operations: MasterEmployeeDayOperationDto[];
  /**
   * Часы по дням периода — график в режимах «Неделя»/«Месяц». Для
   * однодневного периода это одна строка, и UI его не рисует.
   * Дни без работы В СПИСОК НЕ ПОПАДАЮТ: пустые столбики достраивает
   * фронт, чтобы не гонять по сети нули за весь месяц.
   */
  byDay: MasterEmployeeDayByDayDto[];
}
