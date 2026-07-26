/**
 * Хелперы массовых операций «архив → безвозвратное удаление»
 * (контракт — `@sewing/shared/archive`).
 *
 * Зачем отдельный файл: сценарий одинаков в девяти справочниках
 * (техкарты, маршруты, операции, заявки конструктору, цеховой монитор,
 * оборудование, принтеры, сотрудники, поставщики), а физический признак
 * архива у всех разный (`isActive` / `active` / `status` / `archivedAt`).
 * Общей осталась ровно механика: дедуп id, сохранение порядка, сбор
 * `processed` / `skipped`, идемпотентность повторной операции. Её и
 * выносим, а «что такое архив» и «когда нельзя удалять» остаётся в
 * сервисе модуля — там, где это знание и живёт.
 *
 * Сервис вызывает `runBulkArchive` с четырьмя коллбэками и получает
 * готовый `BulkArchiveResultDto`.
 */
import { HttpException } from '@nestjs/common';
import type {
  BulkArchiveResultDto,
  BulkArchiveSkipDto,
  BulkArchiveSkipReason,
} from '@sewing/shared/archive';

/** Причина пропуска, которую возвращает гейт (или `null` — «можно»). */
export interface BulkArchiveSkip {
  reason: BulkArchiveSkipReason;
  detail?: string;
}

export interface BulkArchiveOptions<TRow> {
  /** Уникальные id в порядке запроса. */
  ids: string[];
  /** Загрузить строки одним запросом. Ключ — id. */
  load: (ids: string[]) => Promise<Map<string, TRow>>;
  /**
   * Гейт: `null` — операцию выполнять, объект — пропустить с причиной.
   * Может ходить в БД (например, считать ссылки заказов).
   */
  gate: (row: TRow) => Promise<BulkArchiveSkip | null> | BulkArchiveSkip | null;
  /**
   * Строка уже в целевом состоянии (архив для archive, активна для
   * restore) — считаем обработанной, ничего не делая. Идемпотентность.
   */
  alreadyDone?: (row: TRow) => boolean;
  /**
   * Выполнить операцию над отобранными строками. Вызывается один раз
   * пачкой — сервис сам решает, `updateMany` это или цикл транзакций.
   */
  apply: (rows: TRow[], ids: string[]) => Promise<void>;
}

/**
 * Прогнать пачку id через «загрузить → гейт → применить» и собрать
 * результат с частичным успехом.
 *
 * Порядок: `processed` идёт в порядке входных id (сначала
 * идемпотентные, затем реально обработанные — для UI это неважно, там
 * считается только длина), `skipped` — в порядке входных id.
 */
export async function runBulkArchive<TRow>(
  opts: BulkArchiveOptions<TRow>,
): Promise<BulkArchiveResultDto> {
  const ids = Array.from(new Set(opts.ids));
  const byId = await opts.load(ids);

  const processed: string[] = [];
  const skipped: BulkArchiveSkipDto[] = [];
  const targets: TRow[] = [];
  const targetIds: string[] = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, reason: 'NOT_FOUND' });
      continue;
    }
    if (opts.alreadyDone?.(row)) {
      processed.push(id);
      continue;
    }
    const skip = await opts.gate(row);
    if (skip) {
      skipped.push({ id, reason: skip.reason, detail: skip.detail });
      continue;
    }
    targets.push(row);
    targetIds.push(id);
  }

  if (targets.length > 0) {
    await opts.apply(targets, targetIds);
    processed.push(...targetIds);
  }

  return { processed, skipped };
}

/**
 * `Map` по id из массива строк — типовой `load` для `runBulkArchive`.
 */
export function indexById<TRow extends { id: string }>(
  rows: TRow[],
): Map<string, TRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Человекочитаемый текст из доменного исключения (`BusinessException`
 * и любой `HttpException` с `{ message }` в теле). Нужен там, где bulk
 * оборачивает уже существующие одиночные методы с их гейтами
 * (например, `EmployeesService.archive`): текст ошибки раздела точнее
 * общей формулировки причины.
 */
export function describeBusinessError(e: unknown): string | undefined {
  if (e instanceof HttpException) {
    const body = e.getResponse();
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return e.message;
  }
  return undefined;
}

/**
 * Собрать `detail` для причины `IN_USE` из счётчиков ссылок:
 * `{ 'заказов': 3, 'паспортов': 0 }` → `«её используют заказов: 3»`.
 * Пустой результат (все нули) — `null`, значит удалять можно.
 */
export function describeUsage(
  counts: Record<string, number>,
  prefix = 'используется',
): string | null {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}: ${n}`);
  if (parts.length === 0) return null;
  return `${prefix} (${parts.join(', ')})`;
}
