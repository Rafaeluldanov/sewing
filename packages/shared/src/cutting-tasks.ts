/**
 * Контракты модуля «Кабинет раскройщика» (роль `CUTTER`).
 *
 * См.:
 *   - `prisma/schema.prisma::CuttingTask` / `CuttingTaskSizeRow` /
 *     `CuttingTaskLay` / `CuttingTaskLaySize` / `CuttingTaskRoll`;
 *   - `apps/api/src/modules/cutting-tasks/*`;
 *   - `apps/web/app/cutter/*`.
 *
 * Поток:
 *   1. Менеджер запускает заказ в производство (`OrdersService.start`)
 *      → автоматически создаётся `CuttingTask` (status `NEW`) со
 *      строками-заданием по размерам (план из `OrderItem`).
 *   2. Раскройщик в кабинете видит общую очередь, берёт задачу в работу
 *      (`start` → `IN_PROGRESS`).
 *   3. Составляет один или несколько раскладов (`lays`): в каждом
 *      выбирает чекбоксом размеры с «количеством на настиле»
 *      (`perLayerQty`) и настилает рулоны (номер + слои). Итоги по
 *      размеру суммируются по всем раскладам и считаются на лету.
 *   4. Когда итог приблизился к плану — жмёт «Раскрой завершён»
 *      (`complete` → `DONE`). Завершить можно только полностью
 *      заполненный настил (`listCuttingCompletionProblems`) — иначе
 *      помощнику раскройщика нечего выпускать.
 *
 * Zod-схемы здесь — источник истины для валидации: backend
 * (`CuttingTasksController`) и web (server action) валидируют ими обе
 * стороны.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Статусы задачи
// ---------------------------------------------------------------------------

/**
 * Жизненный цикл задачи на раскрой. В БД хранится как `String` (без
 * Prisma enum) — расширение без миграции.
 *
 *   NEW ──start──▶ IN_PROGRESS ──complete──▶ DONE
 *                        │
 *                        └────(заказ отменён)────▶ CANCELLED
 */
export const CUTTING_TASK_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'DONE',
  'CANCELLED',
] as const;

export const CuttingTaskStatusSchema = z.enum(CUTTING_TASK_STATUSES);
export type CuttingTaskStatus = z.infer<typeof CuttingTaskStatusSchema>;

export const CUTTING_TASK_STATUS_LABELS: Record<CuttingTaskStatus, string> = {
  NEW: 'Новая',
  IN_PROGRESS: 'В работе',
  DONE: 'Завершена',
  CANCELLED: 'Отменена',
};

/**
 * Тон бейджа статуса (совпадает с тонами `AdminStatusBadge`:
 * success/info/warning/danger/muted).
 */
export const CUTTING_TASK_STATUS_TONE: Record<
  CuttingTaskStatus,
  'success' | 'info' | 'warning' | 'danger' | 'muted'
> = {
  NEW: 'warning',
  IN_PROGRESS: 'info',
  DONE: 'success',
  CANCELLED: 'muted',
};

// ---------------------------------------------------------------------------
// Лимиты
// ---------------------------------------------------------------------------

/** Максимум строк-размеров в одной задаче (с запасом). */
export const CUTTING_TASK_MAX_SIZE_ROWS = 64;
/** Максимум раскладов в одной задаче (с запасом). */
export const CUTTING_TASK_MAX_LAYS = 50;
/** Максимум рулонов в одном раскладе. */
export const CUTTING_TASK_MAX_ROLLS = 500;
/** Верхняя граница «штук размера на настиле» (защита от опечаток). */
export const CUTTING_TASK_MAX_PER_LAYER_QTY = 1000;
/** Верхняя граница «слоёв в рулоне». */
export const CUTTING_TASK_MAX_LAYERS = 100000;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

/** Неотрицательное целое из строки/числа; пустое → 0. */
function nonNegativeIntField(max: number, label: string) {
  return z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v, ctx): number => {
      if (v == null || v === '') return 0;
      const raw = typeof v === 'number' ? v : Number(String(v).trim());
      if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: допускаются только целые числа ≥ 0`,
        });
        return z.NEVER;
      }
      if (raw > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: значение не может превышать ${max}`,
        });
        return z.NEVER;
      }
      return raw;
    });
}

/**
 * Строка ввода размера в раскладе «размер → количество на настиле».
 * `qtyPlan` НЕ принимаем от клиента — план фиксируется при создании
 * задачи и read-only для раскройщика. Присутствие строки = размер
 * выбран чекбоксом в этот расклад.
 */
export const CuttingTaskLaySizeInputSchema = z.object({
  sizeId: z.string().min(1, 'Размер обязателен'),
  perLayerQty: nonNegativeIntField(
    CUTTING_TASK_MAX_PER_LAYER_QTY,
    'Количество на настиле',
  ),
});
export type CuttingTaskLaySizeInputDto = z.infer<
  typeof CuttingTaskLaySizeInputSchema
>;

/** Строка ввода рулона «номер → слои» (в рамках расклада). */
export const CuttingTaskRollInputSchema = z.object({
  ordinal: z
    .number({ invalid_type_error: 'Номер рулона должен быть числом' })
    .int('Номер рулона — целое')
    .min(1, 'Номер рулона начинается с 1')
    .max(CUTTING_TASK_MAX_ROLLS, `Номер рулона не больше ${CUTTING_TASK_MAX_ROLLS}`),
  layers: nonNegativeIntField(CUTTING_TASK_MAX_LAYERS, 'Слоёв в рулоне'),
  /**
   * Ф3 «Расцветки»: id расцветки заказа (`OrderVariant`), в цвет которой
   * пойдут паспорта из этого рулона. `null`/не задан — рулон без явной
   * расцветки (выпуск падёт на расцветку #0 / `Order.color`). Backend
   * проверяет принадлежность расцветки заказу задачи.
   */
  variantId: z.string().min(1).nullable().optional(),
});
export type CuttingTaskRollInputDto = z.infer<typeof CuttingTaskRollInputSchema>;

/**
 * Один расклад в payload сохранения: выбранные размеры (`laySizes`) и
 * рулоны (`rolls`) этого расклада. Порядок раскладов в массиве задаёт
 * их нумерацию («Расклад 1» — первый элемент). Оба поля опциональны:
 * на ранних автосейвах раскройщик мог ещё ничего не выбрать / не
 * настелить.
 */
export const CuttingTaskLayInputSchema = z.object({
  /**
   * Частичное завершение раскроя: `ordinal` существующего расклада —
   * идентичность строки при merge-сохранении (`persistProgress`).
   *
   * Было (до фичи): идентичность позиционная — индекс в массиве `lays`
   * становился `ordinal`, а сохранение делало полный replace
   * (`deleteMany` + create). После появления закрытых раскладов так
   * нельзя: `Passport.cuttingLayOrdinal` ссылается на номер расклада,
   * и любой автосейв пересоздал бы расклады, оторвав выпущенные
   * паспорта от их настила.
   *
   * Не задан — это НОВЫЙ расклад, backend выдаст ему следующий
   * свободный `ordinal` (append-only, номера не переиспользуются).
   */
  ordinal: z
    .number({ invalid_type_error: 'Номер расклада должен быть числом' })
    .int('Номер расклада — целое')
    .min(1, 'Номер расклада начинается с 1')
    .optional(),
  laySizes: z
    .array(CuttingTaskLaySizeInputSchema)
    .max(CUTTING_TASK_MAX_SIZE_ROWS, 'Слишком много размеров в раскладе')
    .default([])
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < rows.length; i += 1) {
        const sid = rows[i]!.sizeId;
        if (seen.has(sid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'sizeId'],
            message: 'Размер повторяется в раскладе — дубликаты не допускаются',
          });
        }
        seen.add(sid);
      }
    }),
  rolls: z
    .array(CuttingTaskRollInputSchema)
    .max(CUTTING_TASK_MAX_ROLLS, 'Слишком много рулонов')
    .default([])
    .superRefine((rolls, ctx) => {
      const seen = new Set<number>();
      for (let i = 0; i < rolls.length; i += 1) {
        const ord = rolls[i]!.ordinal;
        if (seen.has(ord)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'ordinal'],
            message: `Рулон №${ord} повторяется в раскладе`,
          });
        }
        seen.add(ord);
      }
    }),
});
export type CuttingTaskLayInputDto = z.infer<typeof CuttingTaskLayInputSchema>;

/**
 * Payload для `PATCH /api/cutting-tasks/:id` (автосохранение прогресса)
 * и `POST /api/cutting-tasks/:id/complete` (финальное сохранение +
 * перевод в DONE). Полностью перезаписывает набор раскладов задачи
 * (replace, не diff) — индекс элемента в `lays` = `ordinal` расклада
 * (1-based).
 *
 * `lays` опционален: на ранних автосейвах раскладов может ещё не быть.
 */
export const SaveCuttingTaskProgressSchema = z.object({
  lays: z
    .array(CuttingTaskLayInputSchema)
    .max(CUTTING_TASK_MAX_LAYS, 'Слишком много раскладов')
    .default([]),
});
export type SaveCuttingTaskProgressDto = z.infer<
  typeof SaveCuttingTaskProgressSchema
>;

// ---------------------------------------------------------------------------
// Готовность к завершению раскроя
// ---------------------------------------------------------------------------

/**
 * Проверка «можно ли завершать раскрой» — общая для клиента (кнопка
 * «Раскрой завершён» в `apps/web/app/cutter/[id]/cutting-form.tsx`) и
 * backend (`CuttingTasksService.complete` →
 * `CUTTING_TASK_COMPLETION_INCOMPLETE`). Автосохранение (`saveProgress`)
 * НЕ проверяется: нули в процессе заполнения — норма.
 *
 * Правила: есть хотя бы один расклад, и каждый расклад заполнен целиком —
 * выбран хотя бы один размер, у всех выбранных размеров «на настиле» > 0,
 * есть хотя бы один рулон и у всех рулонов слои > 0. Иначе задача уходит
 * на доску помощника раскройщика пустой: выпускать паспорта не из чего
 * (все тройки «расклад × размер × рулон» нулевые), а раскрой выглядит
 * завершённым.
 *
 * Возвращает список проблем человеческим языком (пустой = можно
 * завершать). `sizeLabel` — подпись размера в сообщениях (код размера);
 * по умолчанию падаем на `sizeId`.
 *
 * `opts.hasClosedLays` — в задаче есть ЗАКРЫТЫЕ расклады, которых нет в
 * `lays`. Проверяется только то, что реально уходит в сохранение: закрытые
 * расклады свою проверку прошли при «Расклад готов», форма их не шлёт
 * (`CUTTING_LAY_LOCKED`), и когда закрыты ВСЕ — payload пуст. Без этого
 * флага «нет ни одного расклада» ловило валидный кейс «остались только
 * закрытые, добивать нечего» и запирало раскрой: задача навсегда
 * `IN_PROGRESS`, заказ — в «Ждём расклад».
 */
export function listCuttingCompletionProblems(
  lays: CuttingTaskLayInputDto[],
  sizeLabel: (sizeId: string) => string = (id) => id,
  opts: { hasClosedLays?: boolean } = {},
): string[] {
  if (lays.length === 0) {
    return opts.hasClosedLays ? [] : ['нет ни одного расклада'];
  }

  const problems: string[] = [];
  lays.forEach((lay, i) => {
    const n = lay.ordinal ?? i + 1;
    for (const p of listLayCompletionProblems(lay, sizeLabel)) {
      problems.push(`расклад ${n}: ${p}`);
    }
  });
  return problems;
}

/**
 * Те же правила заполненности, но для ОДНОГО расклада — гейт кнопки
 * «Расклад готов» (частичное завершение раскроя, см.
 * `CuttingTasksService.completeLay` → `CUTTING_LAY_COMPLETION_INCOMPLETE`).
 *
 * Сообщения возвращаются БЕЗ префикса «расклад N:» — префикс добавляет
 * `listCuttingCompletionProblems`, когда проверяет всю задачу целиком.
 * Формулировки специально те же: раскройщик видит одинаковый текст,
 * закрывает он один расклад или весь раскрой.
 */
export function listLayCompletionProblems(
  lay: CuttingTaskLayInputDto,
  sizeLabel: (sizeId: string) => string = (id) => id,
): string[] {
  const problems: string[] = [];
  if (lay.laySizes.length === 0) {
    problems.push('не выбран ни один размер');
  } else {
    const zeroSizes = lay.laySizes.filter((s) => s.perLayerQty <= 0);
    if (zeroSizes.length > 0) {
      problems.push(
        `не заполнено «на настиле» у размеров ${zeroSizes
          .map((s) => sizeLabel(s.sizeId))
          .join(', ')}`,
      );
    }
  }
  if (lay.rolls.length === 0) {
    problems.push('нет ни одного рулона');
  } else {
    const zeroRolls = lay.rolls.filter((r) => r.layers <= 0);
    if (zeroRolls.length > 0) {
      problems.push(
        `не заполнены слои у рулонов ${zeroRolls
          .map((r) => `№${r.ordinal}`)
          .join(', ')}`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Output DTOs
// ---------------------------------------------------------------------------

/**
 * Строка плана по размеру (снимок заказа) — список размеров, из которого
 * раскройщик выбирает чекбоксом размеры в каждый расклад. `qtyPlan`
 * общий для всех раскладов и read-only.
 */
export interface CuttingTaskSizeRowDto {
  id: string;
  sortOrder: number;
  sizeId: string | null;
  sizeCodeSnapshot: string;
  /** Плановое количество штук этого размера (read-only). */
  qtyPlan: number;
}

/** Выбранный в раскладе размер с «количеством на настиле». */
export interface CuttingTaskLaySizeDto {
  sizeId: string | null;
  sizeCodeSnapshot: string;
  sortOrder: number;
  /** Введённое раскройщиком «количество размера на настиле» в раскладе. */
  perLayerQty: number;
}

export interface CuttingTaskRollDto {
  id: string;
  ordinal: number;
  layers: number;
  /** Ф3 «Расцветки»: id расцветки рулона (`OrderVariant`) или `null`. */
  variantId: string | null;
  /** Цвет расцветки рулона (подпись/свотч), `null` если не задана. */
  variantColor: string | null;
}

/** Расцветка заказа для выбора цвета рулона в кабинете раскроя. */
export interface CuttingTaskVariantDto {
  id: string;
  ordinal: number;
  color: string;
}

/** Расклад: выбранные размеры + рулоны. `ordinal` — «Расклад N». */
export interface CuttingTaskLayDto {
  id: string;
  ordinal: number;
  sizes: CuttingTaskLaySizeDto[];
  rolls: CuttingTaskRollDto[];
  /**
   * Частичное завершение раскроя: момент «Расклад готов» (ISO) или `null`,
   * если расклад ещё настилается. Закрытый расклад read-only и по нему
   * разрешён выпуск паспортов, пока остальные расклады в работе.
   */
  completedAt: string | null;
  /** Кто закрыл расклад (для подписи «закрыл Иванов И. И.»). */
  completedByName: string | null;
  /**
   * Сколько паспортов уже выпущено по этому раскладу и сколько ожидается
   * (тройки «размер × рулон» с qty > 0) — подпись «выпущено 2 из 8».
   */
  totalPassports: number;
  releasedPassports: number;
  /**
   * Правка уже закрытого расклада: сколько живых паспортов расклада будет
   * УДАЛЕНО при «Открыть расклад».
   *
   * Открытие расклада меняет настил (слои/«на настиле»/рулоны), а
   * выпущенные по нему паспорта несут снимок этого настила (`qtyCut`,
   * `Расклад N · Рулон M`). Оставить их — значит развести бумагу с
   * данными, поэтому «свежие» паспорта (не размещены, не сканированы —
   * то же условие, что у самостоятельного удаления паспорта автором)
   * снимаются вместе с открытием расклада. Раскройщик видит это число в
   * подтверждении: «будет удалено N паспортов».
   */
  reopenDeletesPassports: number;
  /**
   * Номера паспортов расклада, которые УЖЕ ушли в работу (размещены в
   * ячейке / сканированы / упакованы) — их удалять нельзя, поэтому пока
   * список непуст, расклад открыть нельзя вовсе (409
   * `CUTTING_LAY_HAS_PASSPORTS`). Отдаём номера, а не только счётчик:
   * раскройщику надо знать, какие именно паспорта искать.
   *
   * Список подрезан до `CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN` — сообщение
   * не должно превращаться в простыню; полное число в
   * `reopenBlockedTotal`.
   */
  reopenBlockedPassports: string[];
  /** Всего «ушедших в работу» паспортов расклада (см. выше). */
  reopenBlockedTotal: number;
}

/** Сколько номеров паспортов показываем в причине «расклад не открыть». */
export const CUTTING_LAY_BLOCKING_PASSPORTS_SHOWN = 5;

export interface CuttingTaskSummaryDto {
  id: string;
  orderId: string;
  orderNumber: string;
  /** Цвет заказа (для подписи карточки), если задан. */
  orderColor: string | null;
  status: CuttingTaskStatus;
  assignedToName: string | null;
  sizeRowsCount: number;
  /** Число раскладов в задаче. */
  laysCount: number;
  /** Σ рулонов по всем раскладам. */
  rollsCount: number;
  /** Σ слоёв по всем рулонам всех раскладов — удобно показать в списке. */
  totalLayers: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CuttingTaskDetailDto extends CuttingTaskSummaryDto {
  /** Свободный текст клиента/комментарий заказа — справочно. */
  orderCustomer: string | null;
  /** План по размерам (снимок заказа) — что доступно для выбора в расклады. */
  sizeRows: CuttingTaskSizeRowDto[];
  /** Расклады задачи (≥1; «Расклад N» по `ordinal`). */
  lays: CuttingTaskLayDto[];
  /**
   * Ф3 «Расцветки»: расцветки заказа — источник выбора цвета рулона
   * (свотчи/селект в кабинете раскроя). Одна расцветка = одноцветный
   * заказ (выбор не нужен); несколько = раскройщик красит рулоны.
   */
  variants: CuttingTaskVariantDto[];
}

// ---------------------------------------------------------------------------
// Рулонный выпуск паспортов помощником раскройщика (CUTTER_ASSISTANT)
// ---------------------------------------------------------------------------

/** Размер расклада на экране выпуска: раскладка + план (read-only). */
export interface ReleaseLaySizeDto {
  sizeId: string;
  sizeCode: string;
  sortOrder: number;
  /** «Количество размера на настиле» в этом раскладе. */
  perLayerQty: number;
  /** Плановое количество штук размера в заказе (общее, не по раскладу). */
  qtyPlan: number;
}

/** Рулон расклада для выпуска. */
export interface ReleaseLayRollDto {
  ordinal: number;
  layers: number;
  /** Ф3 «Расцветки»: id расцветки рулона или `null`. */
  variantId: string | null;
  /** Цвет расцветки рулона — помощник видит, в какой цвет выпускает. */
  variantColor: string | null;
}

/** Расклад на экране выпуска: размеры + рулоны. `ordinal` — «Расклад N». */
export interface ReleaseLayDto {
  ordinal: number;
  sizes: ReleaseLaySizeDto[];
  rolls: ReleaseLayRollDto[];
  /**
   * Частичное завершение раскроя: `null` — расклад ещё настилается, выпуск
   * по нему запрещён (`CUTTING_LAY_NOT_DONE`). Форма выпуска рисует такой
   * расклад пунктиром «настилается» и не даёт выбрать.
   *
   * Для задач, закрытых ДО появления фичи, у раскладов `completedAt`
   * пустой, но сама задача `DONE` — выпуск по ним разрешён (см.
   * `OrderReleaseStateDto.cuttingTaskStatus` и гейт в
   * `PassportsService.releaseFromRolls`).
   */
  completedAt: string | null;
}

/** Уже выпущенный рулон — тройка `(layOrdinal, sizeId, ordinal)` + сам паспорт. */
export interface ReleasedRollDto {
  layOrdinal: number;
  sizeId: string;
  ordinal: number;
  /** Id уже выпущенного паспорта — для повторной печати «выпустить ещё раз». */
  passportId: string;
  /** Номер паспорта (подпись/доступность кнопки повторного выпуска). */
  passportNumber: string;
}

/**
 * Ответ `GET /api/cutting-tasks/by-order/:orderId/release-state` — всё,
 * что нужно помощнику, чтобы выпускать паспорта по рулонам без ручного
 * ввода. Расклады (с размерами и рулонами) берутся из завершённой задачи
 * раскройщика; `released` — рулоны, по которым паспорт уже выпущен
 * (рисуются как «выпущено», повторно не выпускаются, но их паспорт можно
 * распечатать ещё раз — кейс «завис принтер»).
 */
export interface OrderReleaseStateDto {
  orderId: string;
  orderNumber: string;
  productId: string | null;
  productName: string;
  color: string;
  cuttingTaskStatus: CuttingTaskStatus;
  lays: ReleaseLayDto[];
  released: ReleasedRollDto[];
}

/**
 * Статус строки очереди выпуска (`/work/cut-orders`, вкладка «Выпуск»
 * кабинета раскройщика):
 *   - `NEW`     — есть невыпущенные паспорта по ЗАКРЫТЫМ раскладам («выпускай»);
 *   - `WAITING` — по закрытым раскладам выпущено всё, но раскрой заказа
 *     ещё идёт: сейчас печатать нечего, заказ вернётся сам, когда
 *     раскройщик закроет следующий расклад;
 *   - `DONE`    — раскрой завершён целиком И выпущены все паспорта.
 *
 * `WAITING` появился вместе с частичным завершением раскроя: без него
 * «выпущено всё по закрытым раскладам» отдавало `DONE`, и помощник
 * считал заказ добитым, хотя настилался следующий расклад.
 */
export type OrderReleaseQueueStatus = 'NEW' | 'WAITING' | 'DONE';

/**
 * Строка очереди выпуска — заказ, по которому закрыт хотя бы один расклад
 * (раньше требовался `CuttingTask = DONE` целиком).
 *
 * Единица счёта — ПАСПОРТ: одна тройка «расклад × размер × рулон» с
 * qty > 0 даёт ровно один паспорт (`PassportsService.releaseFromRolls`).
 * Считается только по закрытым раскладам — открытый расклад ещё может
 * измениться.
 */
export interface OrderReadyForReleaseDto {
  orderId: string;
  orderNumber: string;
  productName: string;
  color: string;
  /** Ожидаемых паспортов по закрытым раскладам. */
  totalPassports: number;
  /** Уже выпущенных паспортов по закрытым раскладам. */
  releasedPassports: number;
  /** Всего раскладов в задаче раскроя. */
  laysTotal: number;
  /** Из них закрытых («Расклад готов»). */
  laysClosed: number;
  /** Раскрой ещё идёт (`CuttingTask.status !== 'DONE'`). */
  cuttingInProgress: boolean;
  status: OrderReleaseQueueStatus;
}

// ---------------------------------------------------------------------------
// Helpers — расчёт итогов (используют и сервер-мапперы, и клиент)
// ---------------------------------------------------------------------------

export interface CuttingTaskTotals {
  /** Σ слоёв по всем рулонам всех раскладов. */
  totalLayers: number;
  /** Σ рулонов по всем раскладам. */
  rollsCount: number;
  /**
   * Итог по каждому размеру: `sizeId → Σ по раскладам (слои расклада ×
   * perLayerQty размера в раскладе)`.
   */
  perSizeTotal: Record<string, number>;
}

/** Σ слоёв расклада = Σ `layers` по его рулонам. */
export function layTotalLayers(rolls: Array<{ layers: number }>): number {
  return rolls.reduce(
    (sum, r) => sum + (Number.isFinite(r.layers) ? r.layers : 0),
    0,
  );
}

/**
 * Считает «всего слоёв» и «итог по размеру» по набору раскладов. Чистая
 * функция — одинаково работает на сервере (мапперы summary/detail) и на
 * клиенте (живой пересчёт в форме раскроя).
 *
 * Итог по размеру суммируется по всем раскладам: один размер может
 * входить в несколько раскладов с разным `perLayerQty`.
 */
export function computeCuttingTotals(
  lays: Array<{
    laySizes: Array<{ sizeId: string | null; perLayerQty: number }>;
    rolls: Array<{ layers: number }>;
  }>,
): CuttingTaskTotals {
  let totalLayers = 0;
  let rollsCount = 0;
  const perSizeTotal: Record<string, number> = {};
  for (const lay of lays) {
    const layLayers = layTotalLayers(lay.rolls);
    totalLayers += layLayers;
    rollsCount += lay.rolls.length;
    for (const s of lay.laySizes) {
      if (!s.sizeId) continue;
      perSizeTotal[s.sizeId] =
        (perSizeTotal[s.sizeId] ?? 0) + layLayers * (s.perLayerQty ?? 0);
    }
  }
  return { totalLayers, rollsCount, perSizeTotal };
}
