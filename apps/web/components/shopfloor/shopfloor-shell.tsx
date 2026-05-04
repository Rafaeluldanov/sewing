import type { ReactNode } from 'react';

export interface ShopfloorShellProps {
  /**
   * Содержимое экрана: формы, scan-card блоки, карточки паспортов и т.п.
   * Шапку-профиль (`<RoleHeaderCard>` или `<ShopfloorPageTitle>`) и
   * меню действий (`<SeamstressActionsMenu>`) каждый терминал собирает
   * сам — ShopfloorShell отвечает только за внешний контейнер
   * (max-width, gap между секциями, safe-area через CSS-класс
   * `.seamstress-work`, см. `apps/web/app/globals.css`).
   */
  children: ReactNode;
  /**
   * Дополнительный CSS-класс к контейнеру. Полезно для частных
   * подмодификаторов экрана (например, `cutter-assistant-work` на
   * `/work` для помощника раскройщика). Значение по умолчанию —
   * `.seamstress-work`, чтобы новый и старый код сходились в DOM.
   */
  className?: string;
  /**
   * `aria-label` для контейнера. По умолчанию пуст: основной landmark
   * — `<main className="app-main">` из `app/layout.tsx`.
   */
  ariaLabel?: string;
}

/**
 * `ShopfloorShell` — единый контейнер рабочего места сотрудника.
 *
 * Под капотом — то же самое `<div className="seamstress-work">`, что
 * уже используют `/work`, `/qc`, `/wto`, `/packing` (см.
 * `apps/web/app/globals.css §"Терминал швеи"`). Класс намеренно
 * сохраняем — на нём построены mobile-first отступы, safe-area и
 * gap между секциями. Переименование сломает действующие layout'ы и
 * smoke-тесты пилота.
 *
 * Зачем тогда обёртка:
 *   - даёт новому коду один очевидный entry-point
 *     (`@/components/shopfloor`), не плодя дубли существующей разметки;
 *   - позволяет добавить дополнительный модификатор через `className`
 *     (например, `cutter-assistant-work`) без копирования CSS;
 *   - служит «ярлыком» в коде — `<ShopfloorShell>` читается понятнее,
 *     чем `<div className="seamstress-work">`.
 *
 * См. `docs/design-cleanup-recon.md §5` и `docs/ui-mobile.md` —
 * там зафиксировано, что shopfloor-семейство компонентов должно
 * переиспользовать существующие классы дизайн-токенов.
 */
export function ShopfloorShell({
  children,
  className,
  ariaLabel,
}: ShopfloorShellProps) {
  const cls = `seamstress-work${className ? ` ${className}` : ''}`;
  return (
    <div className={cls} aria-label={ariaLabel}>
      {children}
    </div>
  );
}
