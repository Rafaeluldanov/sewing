/**
 * Контракты модуля «Заявка конструктору» (этап «Отправить изделие
 * конструктору»).
 *
 * См.:
 *   - `prisma/schema.prisma::ConstructorTask` / `ConstructorTaskSizeRow`
 *     / `ConstructorTaskFile`;
 *   - `apps/api/src/modules/constructor-tasks/*`;
 *   - `apps/web/app/admin/orders/new/create-product-inline.tsx`
 *     (вкладка `constructor`).
 *
 * При клике «Сохранить изделие» на вкладке конструктора server action
 * создаёт `PatternItem (status='DRAFT')` + `PatternMaterialArea[]`
 * (конверсия м пог × ширина → м²) + `ConstructorTask (status='NEW')`
 * + размеры/файлы. Возвращает `patternItemId` родительской форме.
 *
 * Zod-схемы здесь — источник истины для валидации запросов на API.
 * Backend (`ConstructorTasksController`) и web (server action) обе
 * стороны валидируют через эти же схемы.
 */

import { z } from 'zod';
import { CreateOrderNewProductCalculationSchema } from './orders';

// ---------------------------------------------------------------------------
// Статусы задачи
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл задачи конструктору (расширен 14.05.2026 ради цикла
 * приёмки и доработки на стороне админа):
 *
 *   NEW ──assignSelf──▶ IN_PROGRESS ──complete──▶ PENDING_ACCEPT
 *                            ▲                          │
 *                            │                  ┌───────┴───────┐
 *                            │                  ▼               ▼
 *                            └─────assignSelf── REWORK         DONE
 *                                                              + pattern → ACTIVE
 *
 * - `NEW`            — менеджер отправил, конструктор ещё не взял.
 * - `IN_PROGRESS`    — конструктор взял в работу.
 * - `PENDING_ACCEPT` — конструктор завершил (загрузил DXF), лекало
 *                      ждёт приёмки менеджером. PatternItem ещё DRAFT.
 * - `REWORK`         — менеджер вернул на доработку с комментарием и,
 *                      возможно, файлами замечаний (`direction='REWORK'`).
 * - `DONE`           — менеджер принял; PatternItem.status='ACTIVE'.
 * - `CANCELLED`      — менеджер отменил.
 *
 * В БД хранится как `String` (без Prisma enum) — расширение без миграции.
 */
export const CONSTRUCTOR_TASK_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'PENDING_ACCEPT',
  'REWORK',
  'DONE',
  'CANCELLED',
] as const;

export const ConstructorTaskStatusSchema = z.enum(CONSTRUCTOR_TASK_STATUSES);
export type ConstructorTaskStatus = z.infer<typeof ConstructorTaskStatusSchema>;

export const CONSTRUCTOR_TASK_STATUS_LABELS: Record<
  ConstructorTaskStatus,
  string
> = {
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  PENDING_ACCEPT: 'На приёмке',
  REWORK: 'Доработка',
  DONE: 'Принята',
  CANCELLED: 'Отменена',
};

/**
 * Тон бейджа статуса (для admin-UI и кабинета конструктора). Совпадает
 * с тонами `AdminStatusBadge` (success/info/warning/danger/muted).
 */
export const CONSTRUCTOR_TASK_STATUS_TONE: Record<
  ConstructorTaskStatus,
  'success' | 'info' | 'warning' | 'danger' | 'muted'
> = {
  NEW: 'warning',
  IN_PROGRESS: 'info',
  PENDING_ACCEPT: 'warning',
  REWORK: 'danger',
  DONE: 'success',
  CANCELLED: 'muted',
};

// ---------------------------------------------------------------------------
// Конверсия погонных метров → м² (для PatternMaterialArea)
// ---------------------------------------------------------------------------

/**
 * Дефолтная ширина рулона ткани (м), используемая для конверсии
 * `areaM2 = linearMeters × CONSTRUCTOR_TASK_DEFAULT_FABRIC_WIDTH_M`
 * при сохранении задачи конструктору. 1.8 м — типичная ширина рулона
 * кулирки/кашкорсе по российскому рынку.
 *
 * После возврата лекала от конструктора area может быть пересчитана
 * по реальным `PatternSizeFile`-ам — этот дефолт используется только
 * до возврата лекала, чтобы расчёт «Потребности цеха» давал
 * приближённый, но осмысленный результат.
 */
export const CONSTRUCTOR_TASK_DEFAULT_FABRIC_WIDTH_M = 1.8;

// ---------------------------------------------------------------------------
// Лимит размера файла
// ---------------------------------------------------------------------------

/**
 * Максимальный размер одного файла (байт). 50 MB — компромисс между
 * «PDF/DWG конструктору» и «не плодить гигабайтные загрузки в админке».
 * Frontend и backend валидируют против этой константы.
 */
export const CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Лимит количества файлов на одну задачу. Защита от случайного
 * массового drag-drop. 20 — достаточно для всех адекватных сценариев
 * (несколько эскизов, спецификация, ТЗ, фотореференс).
 */
export const CONSTRUCTOR_TASK_FILE_MAX_COUNT = 20;

// ---------------------------------------------------------------------------
// Input schema: строка таблицы «Размер / Кулирка / Кашкорсе»
// ---------------------------------------------------------------------------

const DecimalMetersField = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): string | null => {
    if (v == null) return null;
    const raw =
      typeof v === 'number' ? String(v) : String(v).trim().replace(',', '.');
    if (raw === '') return null;
    if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Допускаются положительные числа с точкой/запятой (до 4 знаков после точки)',
      });
      return z.NEVER;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 99999) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Значение должно быть в диапазоне 0..99999',
      });
      return z.NEVER;
    }
    return raw;
  });

/**
 * Одна строка таблицы «Размер / Кулирка / Кашкорсе» в payload-е
 * `saveConstructorDraftAction`. `sizeId` — id из `Size`, должен быть
 * валидным cuid (защита от подделки). `kulirkaMeters` / `kashkorseMeters`
 * — строки-числа, пустые → null. Хотя бы одно из двух чисел желательно
 * заполнить, но это валидируется на уровне всей задачи (см. ниже —
 * task должен иметь хоть какую-то полезную нагрузку).
 */
export const ConstructorTaskSizeRowInputSchema = z.object({
  sizeId: z.string().min(1, 'Размер обязателен'),
  sizeCodeSnapshot: z
    .string()
    .trim()
    .min(1, 'Код размера обязателен')
    .max(64, 'Слишком длинный код размера'),
  kulirkaMeters: DecimalMetersField,
  kashkorseMeters: DecimalMetersField,
});

export type ConstructorTaskSizeRowInputDto = z.infer<
  typeof ConstructorTaskSizeRowInputSchema
>;

// ---------------------------------------------------------------------------
// Input schema: «Сохранить изделие» на вкладке `constructor`
// ---------------------------------------------------------------------------

/**
 * Payload для `saveConstructorDraftAction` / эндпоинта
 * `POST /api/constructor-tasks`. Файлы передаются отдельно через
 * multipart — этот schema валидирует только JSON-часть.
 *
 * Структура:
 *   - `calcPayload` — это то, что менеджер уже заполнил на вкладке
 *     «Сделать расчёт» внутри модалки «Изделие» (категория, техкарта,
 *     размеры с тиражом, расход в м² по ролям категории). Backend
 *     использует его для создания DRAFT-PatternItem и
 *     `PatternMaterialArea[]` (так же, как `OrdersService.createWithInlinePattern`
 *     создаёт ACTIVE-pattern для `CREATE_FOR_CALCULATION`). Тут
 *     reused-schema из `@sewing/shared/orders` — единый источник
 *     истины формата.
 *   - `comment` — свободный текст для конструктора (опционально).
 *   - `sizeRows` — таблица «Размер / Кулирка / Кашкорсе» в **погонных
 *     метрах** на одно изделие. Хранится в `ConstructorTaskSizeRow`
 *     и попадёт в номенклатуру (`PatternItemSizeParameterValue`)
 *     при активации лекала, поэтому именно м пог — caz та же единица,
 *     что использует форма «Погонные метры» на /admin/patterns/[id].
 */
/**
 * Общая проверка таблицы «Размер / Кулирка / Кашкорсе» для всех
 * сценариев отправки конструктору: хотя бы одно значение метража
 * заполнено + нет дублей размеров. Вынесена в функцию, чтобы
 * `SaveConstructorDraftSchema` (новое лекало) и
 * `CreateConstructorTaskForPatternSchema` (существующее лекало)
 * валидировали одинаково.
 */
function refineConstructorTaskSizeRows(
  rows: ConstructorTaskSizeRowInputDto[],
  ctx: z.RefinementCtx,
): void {
  const hasAnyMeters = rows.some(
    (r) => r.kulirkaMeters != null || r.kashkorseMeters != null,
  );
  if (!hasAnyMeters) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Заполните хотя бы одно значение Кулирки или Кашкорсе — иначе нечего отправлять конструктору',
    });
  }
  const seenSizeIds = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const sid = rows[i]!.sizeId;
    if (seenSizeIds.has(sid)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i, 'sizeId'],
        message: 'Размер уже добавлен — дубликаты не допускаются',
      });
    }
    seenSizeIds.add(sid);
  }
}

export const SaveConstructorDraftSchema = z.object({
  calcPayload: CreateOrderNewProductCalculationSchema,
  /**
   * Этап «Клиент — обязательный атрибут заказа»: клиент, выбранный в
   * блоке «Основное» формы создания заказа. Нужен ТОЛЬКО в связке с
   * `?createDraftOrder=1` — иначе DRAFT-заказ, который заводит
   * `ConstructorTasksService.saveDraft`, терял бы уже заполненного
   * менеджером клиента и упирался в `ORDER_CLIENT_REQUIRED` на
   * «Перевести в расчёт».
   *
   * Опционально: flow «Отправить конструктору» без создания заказа
   * (`/admin/patterns`) клиента не знает.
   */
  clientId: z.string().min(1).optional(),
  comment: z
    .string()
    .max(4000, 'Комментарий слишком длинный (макс. 4000 символов)')
    .transform((v) => v.trim())
    .default(''),
  sizeRows: z
    .array(ConstructorTaskSizeRowInputSchema)
    .min(1, 'Добавьте хотя бы один размер')
    .max(64, 'Слишком много строк размеров (макс. 64)')
    .superRefine(refineConstructorTaskSizeRows),
});

export type SaveConstructorDraftDto = z.infer<typeof SaveConstructorDraftSchema>;

// ---------------------------------------------------------------------------
// Input schema: «Отправить конструктору» для УЖЕ существующего лекала
// ---------------------------------------------------------------------------

/**
 * Payload для `POST /api/constructor-tasks/for-pattern`. В отличие от
 * {@link SaveConstructorDraftSchema}, НЕ создаёт новое лекало: задача
 * привязывается к уже существующему `PatternItem` (`patternItemId`).
 * Используется, когда менеджер отправляет конструктору номенклатуру,
 * созданную через «Сохранить изделие» (она уже в БД, но без файла
 * лекала) — из карточки заказа `/admin/orders/[id]/edit` или из
 * карточки номенклатуры `/admin/patterns/[id]`.
 *
 * `calcPayload` тут не нужен — категория/площади уже лежат у лекала
 * (`PatternMaterialArea`). Нужны только `sizeRows` (погонные метры
 * Кулирка/Кашкорсе на изделие), комментарий и файлы (multipart).
 */
export const CreateConstructorTaskForPatternSchema = z.object({
  patternItemId: z.string().min(1, 'Не указано лекало'),
  comment: z
    .string()
    .max(4000, 'Комментарий слишком длинный (макс. 4000 символов)')
    .transform((v) => v.trim())
    .default(''),
  sizeRows: z
    .array(ConstructorTaskSizeRowInputSchema)
    .min(1, 'Добавьте хотя бы один размер')
    .max(64, 'Слишком много строк размеров (макс. 64)')
    .superRefine(refineConstructorTaskSizeRows),
});

export type CreateConstructorTaskForPatternDto = z.infer<
  typeof CreateConstructorTaskForPatternSchema
>;

// ---------------------------------------------------------------------------
// Output DTOs
// ---------------------------------------------------------------------------

/**
 * Источник вложенного файла:
 *   - `INITIAL` — бриф от менеджера при создании задачи;
 *   - `REWORK`  — замечания менеджера при возврате на доработку;
 *   - `null`    — старая запись до введения поля (трактуем как `INITIAL`).
 */
export type ConstructorTaskFileDirection = 'INITIAL' | 'REWORK' | null;

export interface ConstructorTaskFileDto {
  id: string;
  fileUrl: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  direction: ConstructorTaskFileDirection;
}

export interface ConstructorTaskSizeRowDto {
  id: string;
  sortOrder: number;
  sizeId: string | null;
  sizeCodeSnapshot: string;
  /** Decimal-строка или null (см. `DecimalMetersField`). */
  kulirkaMeters: string | null;
  /** Decimal-строка или null. */
  kashkorseMeters: string | null;
}

export interface ConstructorTaskSummaryDto {
  id: string;
  patternItemId: string;
  patternName: string;
  patternArticle: string;
  status: ConstructorTaskStatus;
  comment: string;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  /** Момент финальной приёмки менеджером (`PENDING_ACCEPT` → `DONE`). */
  acceptedAt: string | null;
  createdByName: string | null;
  assignedToName: string | null;
  filesCount: number;
  sizeRowsCount: number;
  /**
   * Этап «Архив справочников»: момент мягкой архивации заявки (ISO)
   * или `null`, если заявка в активном списке. Опционально (`?`),
   * чтобы старые потребители без пересборки shared компилировались;
   * backend всегда отдаёт значение.
   */
  archivedAt?: string | null;
}

export interface ConstructorTaskDetailDto extends ConstructorTaskSummaryDto {
  sizeRows: ConstructorTaskSizeRowDto[];
  files: ConstructorTaskFileDto[];
}

/**
 * Лёгкий ответ от server action `saveConstructorDraftAction` — то,
 * что нужно родительской форме заказа, чтобы прицепить созданное
 * изделие как `patternItemId` и показать summary.
 *
 * `orderId` присутствует, если запрос пришёл с
 * `?createDraftOrder=true` — backend в той же транзакции создал
 * DRAFT-заказ с привязкой patternItemId. UI на `/admin/orders/new`
 * после получения orderId редиректит менеджера на edit-страницу,
 * чтобы заявка КБ всегда жила в контексте заказа.
 */
export interface SaveConstructorDraftResultDto {
  taskId: string;
  patternItemId: string;
  patternName: string;
  patternArticle: string;
  sizeRowsCount: number;
  filesCount: number;
  orderId?: string | null;
}

// ---------------------------------------------------------------------------
// Кабинет конструктора (`apps/web/app/constructor/`) — list / actions
// ---------------------------------------------------------------------------

/**
 * Фильтр для `GET /api/constructor-tasks/my?scope=...`:
 *   - `mine` — только назначенные на меня (`assignedToId == me`),
 *     статусы `NEW` (если успели «забронировать» в UI) + `IN_PROGRESS`;
 *   - `pool` — общий пул свободных (`assignedToId IS NULL` и
 *     `status == 'NEW'`);
 *   - `all`  — мои активные + общий пул (default для главного экрана
 *     кабинета). DONE и CANCELLED скрыты.
 *
 * История завершённых задач конструктора (DONE) появится отдельным
 * срезом позже — в первой итерации не показываем (комментарий-doc
 * к `listForConstructor` в сервисе).
 */
export const CONSTRUCTOR_TASK_LIST_SCOPES = ['mine', 'pool', 'all'] as const;
export const ConstructorTaskListScopeSchema = z.enum(
  CONSTRUCTOR_TASK_LIST_SCOPES,
);
export type ConstructorTaskListScope = z.infer<
  typeof ConstructorTaskListScopeSchema
>;

/**
 * Префикс multipart-полей с файлами лекал в `POST /:id/complete`.
 * Frontend для каждой строки `task.sizeRows` отправляет файл с
 * `name = ${COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX}${sizeId}`,
 * backend по этому префиксу матчит файлы с записями в payload-е.
 */
export const COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX = 'file_';

/**
 * Payload `PATCH /api/constructor-tasks/:id/comment`. Перезаписывает
 * `ConstructorTask.comment` целиком (не diff/append). Ограничение по
 * длине совпадает с `SaveConstructorDraftSchema.comment`.
 */
export const UpdateConstructorTaskCommentSchema = z.object({
  comment: z
    .string()
    .max(4000, 'Комментарий слишком длинный (макс. 4000 символов)')
    .transform((v) => v.trim())
    .default(''),
});
export type UpdateConstructorTaskCommentDto = z.infer<
  typeof UpdateConstructorTaskCommentSchema
>;

/**
 * Payload `POST /api/constructor-tasks/:id/complete`. Сами файлы лекал
 * передаются отдельным multipart-полем (см. `COMPLETE_..._FIELD_PREFIX`).
 * В JSON-payload-е — только маппинг `sizeId -> fileFieldName`, чтобы
 * backend знал, какой файл к какому размеру относится.
 *
 * Один файл на размер. Версия в `PatternSizeFile.version` инкрементится
 * сервисом (не клиентом).
 */
/**
 * Скорректированные значения «Кулирка / Кашкорсе» (м пог. на изделие)
 * по одному размеру задачи. Конструктор может изменить значения,
 * заданные менеджером при создании задачи, и отправить вместе с
 * лекалом. Применяются `updateMany((taskId, sizeId))` ДО переноса в
 * `PatternItemSizeParameterValue`, поэтому в номенклатуру попадают
 * уже скорректированные числа.
 */
export const CompleteConstructorTaskSizeRowInputSchema = z.object({
  sizeId: z.string().min(1, 'sizeId обязателен'),
  kulirkaMeters: DecimalMetersField,
  kashkorseMeters: DecimalMetersField,
});
export type CompleteConstructorTaskSizeRowInputDto = z.infer<
  typeof CompleteConstructorTaskSizeRowInputSchema
>;

export const CompleteConstructorTaskSchema = z.object({
  sizeFiles: z
    .array(
      z.object({
        sizeId: z.string().min(1, 'sizeId обязателен'),
        fileFieldName: z
          .string()
          .min(1, 'fileFieldName обязателен')
          .refine(
            (v) => v.startsWith(COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX),
            `fileFieldName должен начинаться с "${COMPLETE_CONSTRUCTOR_TASK_FILE_FIELD_PREFIX}"`,
          ),
      }),
    )
    // Файл лекала необязателен: задачу можно завершить без файлов вообще
    // (размеры зарегистрируются как заглушки, файлы догрузят позже).
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i += 1) {
        const sid = rows[i]!.sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер уже указан — дубликаты не допускаются',
          });
        }
        seen.add(sid);
      }
    }),
  /**
   * Опциональный массив скорректированных значений Кулирка/Кашкорсе.
   * Если пуст / не передан — исходные значения из задачи остаются как
   * есть. `sizeId` каждой строки должен соответствовать существующей
   * `ConstructorTaskSizeRow` (защита от подделки sizeId — backend
   * валидирует whitelist).
   */
  sizeRows: z
    .array(CompleteConstructorTaskSizeRowInputSchema)
    .max(64, 'Слишком много строк размеров (макс. 64)')
    .default([])
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i += 1) {
        const sid = rows[i]!.sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер уже указан — дубликаты не допускаются',
          });
        }
        seen.add(sid);
      }
    }),
});
export type CompleteConstructorTaskDto = z.infer<
  typeof CompleteConstructorTaskSchema
>;

// ---------------------------------------------------------------------------
// Приёмка / возврат на доработку (admin)
// ---------------------------------------------------------------------------

/**
 * Multipart-поле для файлов возврата на доработку (`requestRework`).
 * Менеджер прикладывает любой набор файлов (PDF/JPG/ZIP/...). Поле
 * именное (повторяющееся), как `files` в `saveDraft` — `AnyFilesInterceptor`
 * на backend-е принимает их под этим именем.
 */
export const REWORK_CONSTRUCTOR_TASK_FILE_FIELD = 'rework_files';

/**
 * Payload `POST /api/constructor-tasks/:id/rework`. Файлы передаются
 * отдельно multipart-ом под `REWORK_CONSTRUCTOR_TASK_FILE_FIELD`.
 *
 * `comment` обязателен — без явного описания «что не так» возврат
 * на доработку бессмысленен. Перезаписывает `ConstructorTask.comment`
 * (как и `updateComment`).
 */
export const RequestReworkConstructorTaskSchema = z.object({
  comment: z
    .string()
    .min(1, 'Комментарий обязателен — опишите, что нужно поправить')
    .max(4000, 'Комментарий слишком длинный (макс. 4000 символов)')
    .transform((v) => v.trim()),
});
export type RequestReworkConstructorTaskDto = z.infer<
  typeof RequestReworkConstructorTaskSchema
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Конверсия «погонные метры → м²» с дефолтной шириной рулона.
 * Используется и backend-ом (при создании `PatternMaterialArea`), и
 * frontend-ом (если понадобится показать прогноз м² в превью).
 *
 * Возвращает `null`, если входное значение тоже null/пустое — то
 * есть отсутствие данных по строке не превращается в `0 м²`.
 */
export function metersToAreaM2(
  linearMeters: number | string | null | undefined,
  widthMeters: number = CONSTRUCTOR_TASK_DEFAULT_FABRIC_WIDTH_M,
): number | null {
  if (linearMeters == null || linearMeters === '') return null;
  const n =
    typeof linearMeters === 'number'
      ? linearMeters
      : Number(String(linearMeters).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Number((n * widthMeters).toFixed(4));
}

/**
 * Сгенерировать `article` для DRAFT-PatternItem. Уникальность
 * обеспечивается timestamp-ом + случайной частью.
 */
export function generateDraftPatternArticle(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DRAFT-${ts}-${rand}`;
}

/**
 * Сгенерировать `name` для DRAFT-PatternItem. Если категория известна
 * — использует её название как префикс; иначе — просто «Черновик».
 */
export function generateDraftPatternName(
  categoryName: string | null | undefined,
): string {
  const ts = new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\..+$/, '')
    .slice(0, 16);
  const prefix = categoryName && categoryName.trim() !== ''
    ? `Черновик · ${categoryName.trim()}`
    : 'Черновик изделия';
  return `${prefix} · ${ts}`;
}
