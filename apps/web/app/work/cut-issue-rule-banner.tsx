'use client';

import type { OrderCutIssueRuleBannerDto } from '@sewing/shared';

/**
 * Постоянный баннер «Очередь выдачи кроя» на /work для швеи.
 *
 * Контракт (ТЗ §4): когда у активной смены операция категории
 * `CUTTING` или это первый шаг маршрута заказа с активной
 * очередью — швея видит, какой размер сейчас разрешён к
 * сканированию и в каких ячейках лежат паспорта этого размера.
 * Если правило не применимо к этой операции — `applicable = false`
 * и компонент возвращает `null`.
 *
 * Модалка «не тот размер» здесь не рисуется: она поднимается из
 * `seamstress-active-panel`, когда `lookupPassportAction` нашёл
 * паспорт, но его `sizeCode` не совпадает с `currentSizeCode`
 * этого заказа в баннере.
 */
export function CutIssueRuleBanner({
  banner,
}: {
  banner: OrderCutIssueRuleBannerDto;
}) {
  if (!banner.applicable || banner.orders.length === 0) return null;
  return (
    <div className="cut-issue-banner" role="region" aria-label="Очередь выдачи кроя">
      {banner.orders.map((order) => (
        <div key={order.orderId} className="cut-issue-banner__card">
          <div className="cut-issue-banner__head">
            <span className="cut-issue-banner__order">Заказ №{order.orderNumber}</span>
            {order.productLabel && (
              <span className="cut-issue-banner__product">{order.productLabel}</span>
            )}
          </div>
          <div className="cut-issue-banner__row">
            <span className="cut-issue-banner__label">Сканируйте размер</span>
            <span className="cut-issue-banner__size">{order.currentSizeCode}</span>
          </div>
          <div className="cut-issue-banner__row">
            <span className="cut-issue-banner__label">Осталось</span>
            <span className="cut-issue-banner__remaining">
              {order.remainingQty} шт ({order.issuedQty}/{order.requiredQty})
            </span>
          </div>
          <div className="cut-issue-banner__row cut-issue-banner__row--cells">
            <span className="cut-issue-banner__label">Ячейки</span>
            {order.cells.length > 0 ? (
              <ul className="cut-issue-banner__cells">
                {order.cells.map((c) => (
                  <li key={c.cellId} className="cut-issue-banner__cell">
                    <span className="cut-issue-banner__cell-code">{c.cellCode}</span>
                    <span className="cut-issue-banner__cell-qty">
                      {c.passportsCount}&nbsp;шт
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="cut-issue-banner__cells-empty">
                Нет паспортов в ячейках
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
