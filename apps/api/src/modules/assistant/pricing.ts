/**
 * Прайс моделей и пересчёт стоимости обращения.
 *
 * Считаем в МИКРОДОЛЛАРАХ (1 000 000 микро = $1), потому что типовой
 * вопрос стоит доли цента: в центах всё округлилось бы в ноль, и
 * месячный потолок расхода перестал бы работать.
 *
 * Прайс из публичного прайс-листа Anthropic (цена за миллион токенов):
 *   claude-opus-5    — $5 вход / $25 выход
 *   claude-sonnet-5  — $3 вход / $15 выход
 * Чтение из кэша префикса стоит ~10% от цены входа — именно поэтому
 * системный промпт и описания инструментов держатся байт-в-байт
 * стабильными (см. `assistant.service.ts::buildSystemPrompt`).
 *
 * ВАЖНО: прайс живёт на бэкенде, а не в shared. UI показывает только
 * человеческую подсказку («≈ $0,03 за вопрос»), а деньги считает сервер.
 */

/** Цена за ОДИН токен в микродолларах. */
interface ModelPrice {
  input: number;
  cachedInput: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  // $5 / 1e6 токенов = 5 микродолларов за токен.
  'claude-opus-5': { input: 5, cachedInput: 0.5, output: 25 },
  // $3 / 1e6 = 3 микродоллара за токен.
  'claude-sonnet-5': { input: 3, cachedInput: 0.3, output: 15 },
};

/**
 * Прайс неизвестной модели. Берём самый дорогой из известных, чтобы
 * незнакомая модель не «прокатилась бесплатно» мимо месячного потолка.
 */
const FALLBACK_PRICE: ModelPrice = { input: 5, cachedInput: 0.5, output: 25 };

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** Стоимость обращения в микродолларах (округление вверх, не в пользу нас). */
export function costUsdMicros(model: string, usage: TokenUsage): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  return Math.ceil(
    usage.inputTokens * p.input +
      usage.cachedInputTokens * p.cachedInput +
      usage.outputTokens * p.output,
  );
}

/** Микродоллары → центы (для сравнения с месячным потолком). */
export function microsToCents(micros: number): number {
  return micros / 10_000;
}
