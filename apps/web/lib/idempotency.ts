/**
 * Ключ идемпотентности для `POST /api/print-jobs` (и любых будущих
 * «сделай ровно один раз» вызовов). Генерируется на каждое ЛОГИЧЕСКОЕ
 * действие пользователя: одно нажатие «Печать» = один ключ. Осознанная
 * повторная печать — это новое нажатие, новый ключ и новый job; а вот
 * случайная двойная доставка того же запроса свернётся на бэке в один
 * job (см. `PrintJob.idempotencyKey`).
 *
 * `crypto.randomUUID` есть и в браузере, и в Node ≥ 18, поэтому модуль
 * безопасно импортировать и из client-компонентов, и из server actions.
 */
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Крайне маловероятный fallback (очень старый рантайм): не крипто-
  // стойкий, но для дедупа ретраев уникальности за глаза.
  return `pj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
