import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon';

export interface DetailPageHeaderProps {
  /** Маленький eyebrow-лейбл над заголовком (например, «Сотрудник»). */
  eyebrow: ReactNode;
  /** Иконка eyebrow и заголовка (одна и та же — UI самодокументируется). */
  icon: IconName;
  /** H1 заголовок. Может быть строкой или составным узлом (паспорт N°…). */
  title: ReactNode;
  /** Подзаголовок / helper text. Опциональный. */
  subtitle?: ReactNode;
  /** Back-link к списку (например, «← К списку сотрудников»). */
  backHref?: string;
  backLabel?: string;
  /** Доп. строка meta под заголовком (код, login, дата, и т.п.). */
  meta?: ReactNode;
  /** Status badges / pills (active / inactive, pricingMode, статус паспорта). */
  badges?: ReactNode;
  /** Action-блок справа (Печать, Редактировать, ←). */
  actions?: ReactNode;
}

/**
 * DetailPageHeader — единый шаблон верхней части любой detail-страницы
 * (см. `docs/screens.md §«Detail-page standard»`).
 *
 * Структура (фиксированная):
 *   1. Back-link / breadcrumb       [optional]
 *   2. page-eyebrow + icon
 *   3. page-title + icon
 *   4. page-subtitle                 [optional]
 *   5. meta-line                     [optional]
 *   6. status-badges                 [optional]
 *   7. actions справа                [optional]
 *
 * Никакой бизнес-логики — только верстка. Используется в RSC и в
 * клиентских компонентах (форм internals и т.п. кладут сюда готовый
 * JSX через `actions`/`badges`).
 */
export function DetailPageHeader({
  eyebrow,
  icon,
  title,
  subtitle,
  backHref,
  backLabel,
  meta,
  badges,
  actions,
}: DetailPageHeaderProps) {
  return (
    <header className="detail-header">
      <div className="detail-header__main">
        {backHref ? (
          <Link href={backHref} className="detail-header__back">
            <Icon name="arrow-right" style={{ transform: 'rotate(180deg)' }} />
            {backLabel ?? 'Назад'}
          </Link>
        ) : null}
        <div className="page-eyebrow">
          <Icon name={icon} />
          {eyebrow}
        </div>
        <h1 className="page-title">
          <Icon name={icon} />
          {title}
        </h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        {meta ? <div className="detail-header__meta">{meta}</div> : null}
        {badges ? <div className="detail-header__badges">{badges}</div> : null}
      </div>
      {actions ? (
        <div className="detail-header__aside">
          <div className="detail-header__actions">{actions}</div>
        </div>
      ) : null}
    </header>
  );
}
