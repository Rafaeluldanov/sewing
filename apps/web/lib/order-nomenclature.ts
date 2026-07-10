/**
 * Единый resolver «номенклатура заказа» для UI карточки заказа.
 *
 * Контекст: до этапа «Номенклатура = Лекала» в карточке заказа были
 * два разных источника названия изделия — `productName` (legacy
 * `Product.name`) в блоке «Изделие» и `patternName` /
 * `patternNameSnapshot` (карточка лекала / её snapshot) в превью.
 * Менеджер мог увидеть в одной и той же карточке два разных
 * названия одного и того же изделия, потому что после переименования
 * `PatternItem` legacy `Product.name` сознательно НЕ синхронизируется
 * (Product — скрытая техническая сущность, см.
 * `OrdersService.ensureLegacyProductForPattern`).
 *
 * Resolver применяет единое правило выбора:
 *
 *   nomenclatureName =
 *     order.patternNameSnapshot ??
 *     order.patternName ??
 *     order.productName ??
 *     null;
 *
 *   nomenclatureArticle =
 *     order.patternArticleSnapshot ??
 *     order.patternArticle ??
 *     null;
 *
 *   nomenclaturePreviewImageUrl =
 *     order.patternPreviewSnapshotUrl ??
 *     order.patternPreviewImageUrl ??
 *     null;
 *
 * Дополнительно фиксируется `source` — откуда пришло название.
 * UI пользуется им, чтобы корректно показать бейдж
 * («снимок» / «актуальное» / «legacy») и/или решить, рисовать ли
 * ссылку на карточку лекала. Семантика:
 *
 *   - `'snapshot'`     — `patternNameSnapshot` есть; заказ был
 *                        переведён в «Расчёт» или производство и
 *                        зафиксировал имя на момент снапшота.
 *                        Текущий `PatternItem.name` мог поменяться
 *                        после этого — UI карточки заказа всё равно
 *                        обязан показывать snapshot.
 *   - `'pattern'`      — snapshot пуст, но live-привязка к
 *                        `PatternItem` есть. Используется в DRAFT-заказе
 *                        до перевода в «Расчёт».
 *   - `'legacyProduct'` — ни snapshot, ни live `PatternItem` нет, но
 *                         есть `productName` (старый flow). На пилоте
 *                         все новые заказы создаются по `PatternItem`,
 *                         поэтому сюда попадают только исторические
 *                         заказы без лекала.
 *   - `'none'`         — ни одного источника. UI рисует «—».
 *
 * Resolver — pure: ничего не читает из БД и не зависит от стороны
 * (server / client). Вход — `OrderDetailDto` или его подмножество с
 * нужными полями (см. `OrderNomenclatureSource`-тип ниже).
 */

import type { OrderDetailDto } from '@sewing/shared/orders';

/**
 * Минимальный набор полей, нужных resolver-у. Принимаем `Pick`
 * вместо полного `OrderDetailDto`, чтобы вызывающие компоненты
 * могли явно декларировать, какие поля они используют (это упрощает
 * локальную типизацию `Pick`-ов в `pattern-preview-card.tsx`).
 */
export type OrderNomenclatureSource = Pick<
  OrderDetailDto,
  | 'patternItemId'
  | 'patternName'
  | 'patternArticle'
  | 'patternPreviewImageUrl'
  | 'patternNameSnapshot'
  | 'patternArticleSnapshot'
  | 'patternPreviewSnapshotUrl'
  | 'productName'
>;

export type OrderNomenclatureSourceTag =
  | 'snapshot'
  | 'pattern'
  | 'legacyProduct'
  | 'none';

export interface ResolvedOrderNomenclature {
  /**
   * Полное имя изделия в карточке заказа. `null` — если ни один
   * источник не задан; UI обычно рисует «—».
   */
  name: string | null;
  /**
   * Артикул лекала (если применимо). У legacy `Product` артикула
   * нет, поэтому при `source = 'legacyProduct'` поле всегда `null`.
   */
  article: string | null;
  /**
   * Превью лекала (snapshot имеет приоритет над live, как в
   * `PatternPreviewCard`). У legacy `Product` превью нет.
   */
  previewImageUrl: string | null;
  /**
   * Какой источник победил (см. JSDoc к модулю выше). UI
   * пользуется им, чтобы решить, какой бейдж рисовать рядом с
   * именем («снимок» / «актуальное» / «legacy») и стоит ли
   * показывать ссылку на карточку лекала.
   */
  source: OrderNomenclatureSourceTag;
}

/**
 * Решает, какое название/артикул/превью показать в карточке заказа.
 * См. JSDoc модуля для подробностей.
 *
 * @example
 *   const r = resolveOrderNomenclature(order);
 *   // r.name — что показать в блоке «Изделие»
 *   // r.source === 'legacyProduct' → можно показать badge «legacy»
 */
export function resolveOrderNomenclature(
  order: OrderNomenclatureSource,
): ResolvedOrderNomenclature {
  const snapshotName = order.patternNameSnapshot ?? null;
  const liveName = order.patternName ?? null;
  const legacyName = order.productName ?? null;

  const snapshotArticle = order.patternArticleSnapshot ?? null;
  const liveArticle = order.patternArticle ?? null;

  const snapshotPreview = order.patternPreviewSnapshotUrl ?? null;
  const livePreview = order.patternPreviewImageUrl ?? null;

  let source: OrderNomenclatureSourceTag;
  let name: string | null;
  let article: string | null;
  let previewImageUrl: string | null;

  if (snapshotName) {
    source = 'snapshot';
    name = snapshotName;
    article = snapshotArticle ?? liveArticle;
    previewImageUrl = snapshotPreview ?? livePreview;
  } else if (liveName) {
    source = 'pattern';
    name = liveName;
    article = liveArticle;
    previewImageUrl = livePreview;
  } else if (legacyName) {
    source = 'legacyProduct';
    name = legacyName;
    article = null;
    previewImageUrl = null;
  } else {
    source = 'none';
    name = null;
    article = null;
    previewImageUrl = null;
  }

  return { name, article, previewImageUrl, source };
}

/**
 * URL карточки лекала (`/admin/patterns/[id]`) для заказа — или
 * `null`, если карточки нет и ссылку рисовать не нужно.
 *
 * Ссылка живёт только пока у заказа есть live-привязка к
 * `PatternItem`: `source` = `'snapshot'` | `'pattern'` И задан
 * `patternItemId`. Для legacy-заказов (`source = 'legacyProduct'`)
 * и пустых (`'none'`) карточки лекала нет — legacy `Product`
 * сознательно скрыт (см. `OrdersService.ensureLegacyProductForPattern`),
 * поэтому ссылку не даём.
 *
 * Единая точка правды: href отсюда берут `PatternPreviewCard`
 * (на обеих карточках заказа) и мета-блок «Изделие / лекало» в
 * админ-карточке `/admin/orders/[id]`, чтобы «проваливание» в
 * карточку лекала было доступно из одного и того же набора
 * состояний заказа независимо от точки клика.
 */
export function resolveOrderPatternHref(
  order: OrderNomenclatureSource,
): string | null {
  const { source } = resolveOrderNomenclature(order);
  if ((source === 'snapshot' || source === 'pattern') && order.patternItemId) {
    return `/admin/patterns/${order.patternItemId}`;
  }
  return null;
}

/**
 * Человеческие лейблы для бейджа источника. Используются и в
 * `PatternPreviewCard`, и в блоке «Изделие» — чтобы менеджер видел
 * один и тот же текст в обоих местах.
 *
 * Для `'legacyProduct'` отдаём подпись `'legacy'`: визуально
 * нейтрально, и менеджер сразу понимает, что заказ исторический,
 * без `PatternItem`. Для `'none'` бейдж не показываем.
 */
export const ORDER_NOMENCLATURE_SOURCE_BADGE: Record<
  OrderNomenclatureSourceTag,
  string | null
> = {
  snapshot: 'снимок',
  pattern: 'актуальное',
  legacyProduct: 'legacy',
  none: null,
};
