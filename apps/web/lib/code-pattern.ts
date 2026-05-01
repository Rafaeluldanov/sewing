/**
 * Безопасное HTML-attribute значение `pattern` для полей `code`
 * (techcards / route templates / прочие латинские «коды» в админке).
 *
 * Современные браузеры (Chrome / Firefox с поддержкой `v`-flag в
 * `RegExp` и атрибуте `pattern`) считают неэкранированный дефис
 * внутри character-class ошибкой и выводят в консоль:
 *
 *   Pattern attribute value [A-Z0-9][A-Z0-9_-]+ is not a valid
 *   regular expression: Invalid regular expression.
 *
 * Поэтому в HTML-формах используем экранированный дефис: '\\-'.
 *
 * Это чисто frontend-константа — backend-валидация остаётся в
 * `packages/shared` (`TECH_CARD_CODE_PATTERN`,
 * `ROUTE_TEMPLATE_CODE_PATTERN` и т.п.), там JS-RegExp с дефисом
 * в конце класса валиден и не требует правки.
 */
export const CODE_PATTERN = '[A-Z0-9][A-Z0-9_\\-]*';

/**
 * Унифицированный `title` (tooltip браузера, если pattern не сошёлся)
 * для полей `code`. Держим рядом, чтобы admin-формы не расходились
 * по тексту подсказки.
 */
export const CODE_PATTERN_TITLE =
  "Латинские заглавные буквы, цифры, '-' и '_'";
