/**
 * Контракты модуля «Принтеры и печать через агент» (MVP).
 * См. `docs/domain.md §17`, `docs/api.md §16`, `docs/screens.md §18`.
 *
 * Исходный сценарий пользователя:
 *   1. Менеджер создаёт принтер и привязывает его к рабочему месту
 *      (`Equipment`).
 *   2. Жмёт «Сгенерировать код» — получает короткий `pairingCode`.
 *   3. Жмёт «Скачать агент» — забирает Node.js-агент (`apps/agent`).
 *   4. На Windows-станции рядом с принтером запускает агента,
 *      указывает URL сервера и pairingCode.
 *   5. Агент обменивает код на постоянный `agentToken`/`printerId`,
 *      каждые 2-3 секунды поллит `GET /api/print-jobs/agent`.
 *   6. Сотрудник в системе жмёт «Печать» → backend по активной смене
 *      находит принтер по `equipmentId` и создаёт `PrintJob`.
 *   7. Агент печатает, отвечает `PATCH /api/print-jobs/:id`.
 *
 * Сознательно простая модель — без ретраев, очередей и сложного RBAC:
 * на MVP важно, чтобы один тонкий цикл работал предсказуемо.
 */

import { z } from 'zod';
import { EmployeeRoleSchema, type EmployeeRole } from './employees';

// ---------------------------------------------------------------------------
// ENUMS — дублируем как литералы, чтобы shared не зависел от @prisma/client
// ---------------------------------------------------------------------------

export const PRINTER_TYPES = ['PASSPORT', 'QR', 'LABEL', 'DEFAULT'] as const;
export type PrinterType = (typeof PRINTER_TYPES)[number];

export const PRINT_JOB_STATUSES = ['PENDING', 'PRINTED', 'FAILED'] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export const PRINT_JOB_SOURCES = [
  'PASSPORT_QR',
  'PASSPORT_PRINT',
  'BOX_LABEL',
  'CELL_QR',
  /**
   * Готовая HTML-этикетка ячейки (`/api/cells/:id/print`) под формат
   * 38×58 мм (горизонтально, QR слева, номер справа). Используется
   * при массовой печати «Печать всех ячеек» из карточки склада
   * (см. `docs/api.md §15`, `docs/screens.md §10b`). Отличается от
   * `CELL_QR` тем, что это уже свёрстанная этикетка, а не голый PNG QR.
   */
  'CELL_LABEL',
  'TEST',
] as const;
export type PrintJobSource = (typeof PRINT_JOB_SOURCES)[number];

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/** Краткая запись о принтере для списка `/admin/printers`. */
export interface PrinterSummaryDto {
  id: string;
  name: string;
  type: PrinterType;
  isActive: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
  /**
   * Привязка принтера к роли сотрудника. На MVP именно по этой роли
   * `PrintJobsService` выбирает принтер для печати: при `POST
   * /api/print-jobs` без явного `printerId` backend ищет активный
   * принтер с такой же `role`, как у текущего сотрудника. NULL =
   * принтер не используется в автоматическом матчинге (только тестовая
   * печать / массовые батчи по явному `printerId`).
   */
  role: EmployeeRole | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentId: string | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentName: string | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentCode: string | null;
  /** Есть ли pairingCode прямо сейчас (само значение в списке не отдаём). */
  hasPairingCode: boolean;
  /** Сколько `PENDING` job-ов в очереди принтера. */
  pendingJobsCount: number;
}

/** Подробная карточка принтера `/admin/printers/:id`. */
export interface PrinterDetailDto {
  id: string;
  name: string;
  type: PrinterType;
  isActive: boolean;
  isOnline: boolean;
  lastSeenAt: string | null;
  /** См. одноимённое поле в `PrinterSummaryDto`. */
  role: EmployeeRole | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentId: string | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentName: string | null;
  /** @deprecated Старое поле; в новых UI больше не показывается. */
  equipmentCode: string | null;
  /**
   * Текущий pairingCode (если есть). Виден только админам/менеджерам
   * — это короткое значение, которое они вводят на Windows-станции
   * при первом запуске агента.
   */
  pairingCode: string | null;
  createdAt: string;
  /**
   * Hostname Windows-машины, на которой запущен агент. Заполняется
   * агентом при upload-е списка системных принтеров (см.
   * `AgentWindowsPrintersSchema`). NULL = ещё ни разу не присылал.
   */
  agentHostName: string | null;
  /**
   * Список системных Windows-принтеров, найденных на машине агента
   * (`Get-Printer | Select-Object -ExpandProperty Name`). Пустой
   * массив = «агент пока не прислал список». Передаётся в UI
   * `/admin/printers/:id` как варианты для select-а «Печатать на».
   */
  availableWindowsPrinters: string[];
  /** Когда агент в последний раз обновил `availableWindowsPrinters`. */
  windowsPrintersUpdatedAt: string | null;
  /**
   * Имя выбранного менеджером Windows-принтера (один из
   * `availableWindowsPrinters`). NULL = ещё не выбран — печать
   * через агент в этом случае помечается FAILED с
   * `WINDOWS_PRINTER_NOT_SELECTED`.
   */
  selectedWindowsPrinter: string | null;
}

export interface PrintJobDto {
  id: string;
  printerId: string;
  sourceType: PrintJobSource;
  sourceId: string | null;
  payloadUrl: string;
  status: PrintJobStatus;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  /**
   * Имя физического Windows-принтера, на который должен печатать
   * агент в момент выдачи job-а (`Printer.selectedWindowsPrinter`).
   * NULL = выбор ещё не сделан — агент должен пометить job FAILED с
   * `WINDOWS_PRINTER_NOT_SELECTED` (см. `apps/agent/src/runtime.mjs`).
   * Управленческий UI для печати выбирает принтер сам, в свою
   * очередь, по `equipmentId` смены — этим полем агент только
   * адресует физический принтер на своей Windows-машине.
   */
  selectedWindowsPrinter: string | null;
}

/**
 * Что отдаёт `POST /api/printers/agent/pair` агенту в ответ на
 * пары-код. Агент сохраняет `printerId` и `agentToken` в локальный
 * конфиг и дальше живёт по ним.
 */
export interface AgentPairResultDto {
  printerId: string;
  printerName: string;
  agentToken: string;
}

/**
 * Что отдаёт `POST /api/printers/agent/windows-printers` обратно
 * агенту: текущий выбор менеджера (если уже есть) — чтобы агент
 * сразу знал, на какой системный принтер печатать, без отдельного
 * вызова GET. На MVP больше ничего не нужно.
 */
export interface AgentWindowsPrintersResultDto {
  printerId: string;
  selectedWindowsPrinter: string | null;
  availableWindowsPrinters: string[];
  agentHostName: string | null;
}

// ---------------------------------------------------------------------------
// ZOD SCHEMAS (request bodies)
// ---------------------------------------------------------------------------

const NonEmptyString = (max = 200) => z.string().trim().min(1).max(max);

export const CreatePrinterSchema = z.object({
  name: NonEmptyString(120),
  type: z.enum(PRINTER_TYPES).default('DEFAULT'),
  /**
   * Привязка к роли сотрудника. На MVP можно создать без привязки и
   * доцепить позже — но без `role` принтер не будет матчиться в
   * автоматической печати по смене.
   */
  role: EmployeeRoleSchema.nullable().optional(),
  /** @deprecated Старое поле; backend принимает, новые UI не передают. */
  equipmentId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CreatePrinterDto = z.infer<typeof CreatePrinterSchema>;

export const UpdatePrinterSchema = z
  .object({
    name: NonEmptyString(120).optional(),
    type: z.enum(PRINTER_TYPES).optional(),
    role: EmployeeRoleSchema.nullable().optional(),
    /** @deprecated Старое поле; backend принимает, новые UI не передают. */
    equipmentId: z.string().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
    /**
     * Имя выбранного Windows-принтера. Должно совпадать с одной из
     * строк, которые агент прислал через
     * `POST /api/printers/agent/windows-printers` (валидация — на
     * сервере, ошибка `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT`).
     * `null` — снять выбор (агент будет помечать job-ы FAILED с
     * `WINDOWS_PRINTER_NOT_SELECTED`).
     */
    selectedWindowsPrinter: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .nullable()
      .optional(),
  })
  .refine(
    (obj) => Object.values(obj).some((v) => v !== undefined),
    'Нечего обновлять: укажите хотя бы одно поле',
  );
export type UpdatePrinterDto = z.infer<typeof UpdatePrinterSchema>;

/**
 * Тело `POST /api/printers/agent/pair` — обмен короткого pairingCode на
 * постоянные `printerId + agentToken`. Endpoint @Public, так что
 * pairingCode — единственный «секрет», по которому агент авторизуется
 * первый раз. После pair-а pairingCode на сервере очищается.
 */
export const AgentPairSchema = z.object({
  pairingCode: z
    .string()
    .trim()
    .min(4, 'Слишком короткий код подключения')
    .max(64),
});
export type AgentPairDto = z.infer<typeof AgentPairSchema>;

/**
 * Тело `POST /api/printers/agent/windows-printers` — агент сообщает
 * серверу, какие системные принтеры он видит на своей Windows-машине
 * (`Get-Printer | Select-Object -ExpandProperty Name`) и под каким
 * hostname он живёт. Запрос идёт под `X-Printer-Agent-Token`, и
 * сервер по нему сам определяет логический `Printer`.
 *
 * Список перезаписывается полностью при каждом upload-е — без diff-а
 * и истории, см. `docs/domain.md §17b` и комментарий поля в Prisma.
 */
export const AgentWindowsPrintersSchema = z.object({
  hostName: z.string().trim().min(1).max(255),
  printers: z.array(z.string().trim().min(1).max(255)).max(200),
});
export type AgentWindowsPrintersDto = z.infer<
  typeof AgentWindowsPrintersSchema
>;

/**
 * Тело `POST /api/printers/agent/select-windows-printer` — агент сам
 * выставляет физический Windows-принтер, выбранный оператором в его
 * локальном wizard-е (см. `apps/agent/src/wizard.mjs`). Раньше это
 * мог сделать только менеджер через UI `/admin/printers/:id`; теперь
 * оператор может всё настроить с своей машины при первом запуске.
 *
 * Защищено `AgentAuthGuard` (`X-Printer-Agent-Token`), так что нельзя
 * выставить чужой принтер. Имя обязательно должно быть в
 * `availableWindowsPrinters`, иначе сервер вернёт
 * `WINDOWS_PRINTER_NOT_FOUND_FOR_AGENT` (422). `name=null` снимает
 * выбор — оставлено для симметрии с UI, агент сейчас этим не
 * пользуется.
 */
export const AgentSelectWindowsPrinterSchema = z.object({
  name: z.string().trim().min(1).max(255).nullable(),
});
export type AgentSelectWindowsPrinterDto = z.infer<
  typeof AgentSelectWindowsPrinterSchema
>;

/**
 * Ответ `POST /api/printers/agent/select-windows-printer`. Возвращаем
 * подтверждённый `selectedWindowsPrinter` (то, что реально лежит в
 * БД после апдейта) — агент сразу пишет это в свой лог и больше не
 * ходит на сервер за подтверждением.
 */
export interface AgentSelectWindowsPrinterResultDto {
  printerId: string;
  selectedWindowsPrinter: string | null;
}

/**
 * Тело `POST /api/print-jobs` — создание задания на печать сотрудником
 * системы. `printerId` опционален: если не передан, backend сам ищет
 * активный принтер по `equipmentId` текущей смены.
 */
export const CreatePrintJobSchema = z.object({
  sourceType: z.enum(PRINT_JOB_SOURCES),
  sourceId: z.string().min(1).optional(),
  /**
   * Явный выбор принтера. На MVP используется только для «Тестовая
   * печать» из карточки принтера. Обычная кнопка «Печать» оставляет
   * это поле пустым и опирается на смену.
   */
  printerId: z.string().min(1).optional(),
});
export type CreatePrintJobDto = z.infer<typeof CreatePrintJobSchema>;

/**
 * Тело `PATCH /api/print-jobs/:id` от агента: «напечатано» или
 * «упало». На MVP допускаем только переход PENDING → PRINTED/FAILED.
 */
export const UpdatePrintJobStatusSchema = z
  .object({
    status: z.enum(['PRINTED', 'FAILED']),
    errorMessage: z.string().max(2000).optional(),
  })
  .refine(
    (v) => v.status !== 'FAILED' || !!v.errorMessage,
    'Для FAILED нужен errorMessage',
  );
export type UpdatePrintJobStatusDto = z.infer<typeof UpdatePrintJobStatusSchema>;
