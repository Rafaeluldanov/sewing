/**
 * Единые константы доменной стратегии.
 *
 * Источник истины для URL-ов — переменные окружения (`APP_URL`, `API_URL`).
 * Эти значения — только дефолты/fallback, чтобы исключить хардкод localhost
 * в production-коде.
 *
 * - UI production:  https://prod.teeon.ru
 * - API production: https://api.prod.teeon.ru
 * - stage:          https://stage.teeon.ru
 */

export const DOMAIN_PROD_WEB = 'https://prod.teeon.ru';
export const DOMAIN_PROD_API = 'https://api.prod.teeon.ru';
export const DOMAIN_STAGE = 'https://stage.teeon.ru';

/**
 * API-префикс для всех REST-эндпоинтов (см. `docs/api.md §12`).
 */
export const API_PREFIX = '/api';
