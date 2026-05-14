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
 * Жизненный цикл задачи конструктору:
 *   - `NEW`         — менеджер отправил, конструктор ещё не взял;
 *   - `IN_PROGRESS` — конструктор взял в работу (из своего кабинета);
 *   - `DONE`        — конструктор завершил, лекало готово;
 *   - `CANCELLED`   — менеджер отменил заявку.
 *
 * В БД хранится как `String` (без Prisma enum) — расширение возможно
 * без миграции.
 */
export const CONSTRUCTOR_TASK_STATUSES = [
  'NEW',
  'IN_PROGRESS',
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
  DONE: 'Готова',
  CANCELLED: 'Отменена',
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
export const SaveConstructorDraftSchema = z.object({
  calcPayload: CreateOrderNewProductCalculationSchema,
  comment: z
    .string()
    .max(4000, 'Комментарий слишком длинный (макс. 4000 символов)')
    .transform((v) => v.trim())
    .default(''),
  sizeRows: z
    .array(ConstructorTaskSizeRowInputSchema)
    .min(1, 'Добавьте хотя бы один размер')
    .max(64, 'Слишком много строк размеров (макс. 64)')
    .superRefine((rows, ctx) => {
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
    }),
});

export type SaveConstructorDraftDto = z.infer<typeof SaveConstructorDraftSchema>;

// ---------------------------------------------------------------------------
// Output DTOs
// ---------------------------------------------------------------------------

export interface ConstructorTaskFileDto {
  id: string;
  fileUrl: string;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
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
  createdByName: string | null;
  assignedToName: string | null;
  filesCount: number;
  sizeRowsCount: number;
}

export interface ConstructorTaskDetailDto extends ConstructorTaskSummaryDto {
  sizeRows: ConstructorTaskSizeRowDto[];
  files: ConstructorTaskFileDto[];
}

/**
 * Лёгкий ответ от server action `saveConstructorDraftAction` — то,
 * что нужно родительской форме заказа, чтобы прицепить созданное
 * изделие как `patternItemId` и показать summary.
 */
export interface SaveConstructorDraftResultDto {
  taskId: string;
  patternItemId: string;
  patternName: string;
  patternArticle: string;
  sizeRowsCount: number;
  filesCount: number;
}

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
