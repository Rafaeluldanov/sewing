import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Машинный (сервер-серверный) токен доступа к API.
 *
 * Зачем отдельная сущность, а не переиспользование session-cookie: cookie-путь
 * (`AuthService.resolvePrincipal`) намеренно завязан на политику сессий сотрудника —
 * idle-TTL и рубильник «Завершить все сеансы» (`CompanySettings.sessionsValidFrom`).
 * Для интеграции это означало бы, что один клик в настройках компании молча рвёт обмен
 * с ERP. Машинный токен живёт своей жизнью и отзывается явно.
 *
 * Почему не HMAC-токен как в `session.ts`: `JWT_SECRET` один на процесс, а тенантов
 * несколько — самопроверяемый токен был бы валиден в ЛЮБОМ тенанте. Здесь же токен
 * ищется в БД тенанта, и токен чужого тенанта просто не найдётся.
 */

/** Префикс плейнтекста — чтобы токен опознавался в логах и не путался с cookie. */
export const SERVICE_TOKEN_PREFIX = 'sew_';

/** Достать токен из заголовка `Authorization: Bearer sew_…`. */
export function readServiceToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const raw = m?.[1];
  // Строгая проверка префикса: браузер `Authorization` не шлёт вовсе, а посторонний
  // Bearer (чужой сервис, копипаста) не должен уводить запрос в машинную ветку —
  // пусть лучше упрётся в обычный 401 по отсутствию cookie.
  return raw && raw.startsWith(SERVICE_TOKEN_PREFIX) ? raw : null;
}

/** Сгенерировать новый плейнтекст. Показывается владельцу ОДИН раз при выпуске. */
export function generateServiceToken(): string {
  return SERVICE_TOKEN_PREFIX + randomBytes(32).toString('hex');
}

/** Хеш для хранения. Плейнтекст в БД не попадает никогда. */
export function hashServiceToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** Опознавательный кусок для UI: «sew_ab12…». Не секрет. */
export function previewOf(raw: string): string {
  return raw.slice(0, SERVICE_TOKEN_PREFIX.length + 6);
}

/**
 * Сравнение хешей за постоянное время. Поиск идёт по уникальному индексу, но сверку
 * делаем явно: побайтовое сравнение строк даёт таймингу подсказку о длине совпадения.
 */
export function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Скоупы «окна ERP» — полный набор, которым ERP upgifts рисует у себя экраны цеха.
 *
 * Раньше здесь было два справочника, и это было верно, пока ERP показывала два справочника.
 * Решение владельца 02.09.2026: заказы, лекала, маршруты, операции, заявки конструктору,
 * принтеры, роли и зарплата, себестоимость и настройки открываются в ERP так, чтобы человек
 * не понимал, что систем две. Окно без данных — пустое окно, поэтому набор такой широкий.
 *
 * Deny-by-default при этом никуда не делся и остаётся смыслом всей конструкции: маршрут без
 * `@MachineScopes(...)` машине закрыт, и в этом списке нет ни одного скоупа, под который не
 * открыт конкретный контроллер. Денег машина не двигает: `payroll`, `costs`, `roles` — только
 * чтение, казначейство, выплаты и цеховые экраны (раскрой, смены, паспорта) не открыты вовсе.
 */
export const ERP_WINDOW_SCOPES = [
  'equipment:read', 'equipment:write',
  'operations:read', 'operations:write',
  'orders:read', 'orders:write',
  'patterns:read', 'patterns:write',
  'routes:read', 'routes:write',
  'constructor:read', 'constructor:write',
  'printers:read', 'printers:write',
  'settings:read', 'settings:write',
  'needs:read', 'needs:write',
  'stock:read', 'stock:write',
  'catalog:read',
  'employees:read',
  'roles:read',
  'payroll:read',
  'costs:read',
];
