import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Автор действия, пришедшего через машинный токен (ERP upgifts).
 *
 * ⛔ ПРАВИЛО (зафиксировано Рафаэлем 2026-09-02, МЕНЯТЬ ТОЛЬКО ПО ЯВНОЙ ПРОСЬБЕ):
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * Пользователи цеха переедут в ERP. До переезда действие из ERP пишется от имени СЛУЖЕБНОГО
 * сотрудника «Интеграция ERP», а кто из людей ERP нажал — отдельной строкой в аудите
 * (`actor` в payload). Таблица соответствия «пользователь ERP ↔ сотрудник цеха» НЕ заводится:
 * это второй реестр людей, который разъедется с первым, а переезд делает его ненужным.
 * НЕ ВОЗВРАЩАТЬ. (service/docs/kb/sewing.md §0.1)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Хранится в `AsyncLocalStorage`, потому что пишущих мест шесть десятков, и протаскивать
 * автора параметром через каждое — значит, что первое же новое место его потеряет. Гвард
 * кладёт автора один раз на запрос, `AuditService.log` дописывает его в payload сам.
 */
export interface ActorInfo {
  /** Идентификатор пользователя ERP (uuid). */
  id: string;
  /** Отображаемое имя пользователя ERP, если ERP его прислала. */
  name: string | null;
  /** Из какой системы пришёл — сегодня всегда 'erp'. */
  source: 'erp';
}

const als = new AsyncLocalStorage<ActorInfo>();

/**
 * Выполнить обработку запроса с автором в контексте (вызывается из `ActorContextMiddleware`).
 *
 * Именно `run`, а не `enterWith`: гвард Nest вызывается после `await` внутри цепочки
 * исполнения, и контекст, положенный `enterWith` там, до хендлера и аудита не доживает
 * (проверено воспроизведением 02.09.2026). Middleware оборачивает `next()` целиком — так же,
 * как `TenantResolverMiddleware` кладёт тенанта.
 */
export function runWithActor<T>(actor: ActorInfo, fn: () => T): T {
  return als.run(actor, fn);
}

/** Автор текущего запроса или `null` (человек с cookie, фоновая задача). */
export function currentActor(): ActorInfo | null {
  return als.getStore() ?? null;
}

/**
 * Разобрать заголовки `X-Sewing-Actor` / `X-Sewing-Actor-Name`.
 *
 * Имя ERP шлёт percent-encoded: в HTTP-заголовке кириллица напрямую не живёт.
 * Некорректная кодировка — не повод ронять запрос: автор без имени лучше, чем 400.
 */
export function parseActorHeaders(
  headers: Record<string, string | string[] | undefined>,
): ActorInfo | null {
  const raw = headers['x-sewing-actor'];
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!id) return null;
  const rawName = headers['x-sewing-actor-name'];
  const encoded = (Array.isArray(rawName) ? rawName[0] : rawName)?.trim();
  let name: string | null = null;
  if (encoded) {
    try {
      name = decodeURIComponent(encoded).slice(0, 200);
    } catch {
      name = null;
    }
  }
  return { id: id.slice(0, 100), name, source: 'erp' };
}
