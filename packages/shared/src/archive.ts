/**
 * Общий контракт «архив → безвозвратное удаление» для справочников
 * админки.
 *
 * Сценарий один и тот же во всех разделах (`/admin/tech-cards`,
 * `/admin/routes`, `/admin/operations`, `/admin/constructor-tasks`,
 * `/admin/display-screens`, `/admin/equipment`, `/admin/printers`,
 * `/admin/employees`, `/admin/suppliers`; первым его получил
 * `/admin/patterns`):
 *
 *   1) запись мягко уходит в архив — обратимо, данные сохраняются,
 *      из активных выборок пропадает;
 *   2) только ИЗ архива её можно стереть навсегда;
 *   3) обе операции — массовые, с ЧАСТИЧНЫМ УСПЕХОМ: запись, не
 *      прошедшая гейт, попадает в `skipped` с причиной, остальные
 *      обрабатываются (а не 409 на первую же непрошедшую).
 *
 * Чем «архив» является физически — решает модуль: у одних это
 * `isActive/active = false`, у других `status = ARCHIVED/INACTIVE`,
 * у третьих дата (`archivedAt`). Наружу разница не торчит: у всех
 * одинаковые три эндпоинта `POST …/archive|restore|purge` и один
 * шейп запроса/ответа отсюда.
 *
 * Прототип контура — «Архив расчётов цеха»
 * (`@sewing/shared/workshop-needs`, `WorkshopNeedsArchiveRequestSchema`),
 * там единица операции — заказ, поэтому свой набор причин; здесь —
 * универсальный набор для справочников.
 */
import { z } from 'zod';

/**
 * Тело запроса массовых операций архива. Точечная кнопка в строке =
 * массив из одного id; «Очистить архив» = все id текущей выдачи
 * (собирает фронт).
 */
export const BulkArchiveRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
});
export type BulkArchiveRequestDto = z.infer<typeof BulkArchiveRequestSchema>;

/** Причина, по которой запись пропущена массовой операцией. */
export const BULK_ARCHIVE_SKIP_REASONS = [
  /** Записи с таким id нет. */
  'NOT_FOUND',
  /** Запись не в архиве — безвозвратное удаление недоступно. */
  'NOT_ARCHIVED',
  /** На запись ссылается история//документы — удалять навсегда нельзя. */
  'IN_USE',
  /** Операция запрещена правилами раздела (например, «нельзя на себе»
   *  для сотрудников или «последний админ»). Детали — в `detail`. */
  'FORBIDDEN',
] as const;
export type BulkArchiveSkipReason = (typeof BULK_ARCHIVE_SKIP_REASONS)[number];

export const BULK_ARCHIVE_SKIP_REASON_LABELS: Record<
  BulkArchiveSkipReason,
  string
> = {
  NOT_FOUND: 'запись не найдена',
  NOT_ARCHIVED: 'запись не в архиве',
  IN_USE: 'запись используется — удалить навсегда нельзя',
  FORBIDDEN: 'операция запрещена правилами раздела',
};

export interface BulkArchiveSkipDto {
  id: string;
  reason: BulkArchiveSkipReason;
  /** Человекочитаемое уточнение («её используют заказы: 3»). */
  detail?: string;
}

/**
 * Результат массовой операции. `processed` — id, к которым операция
 * реально применилась (в т.ч. идемпотентно: архивация уже архивной
 * записи считается успехом); `skipped` — пропущенные с причиной.
 */
export interface BulkArchiveResultDto {
  processed: string[];
  skipped: BulkArchiveSkipDto[];
}

/**
 * Собрать текст «что пропустили» для UI. Причины схлопываем в
 * уникальные, детали (если есть) показываем как есть — они точнее
 * общей формулировки.
 */
export function describeBulkArchiveSkips(
  skipped: BulkArchiveSkipDto[],
): string {
  const parts = new Set<string>();
  for (const s of skipped) {
    parts.add(s.detail ?? BULK_ARCHIVE_SKIP_REASON_LABELS[s.reason]);
  }
  return Array.from(parts).join('; ');
}
