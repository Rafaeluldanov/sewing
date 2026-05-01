import type { ReactNode } from 'react';

export type StatusPillTone = 'default' | 'accent' | 'ok' | 'warn' | 'danger' | 'ghost';

export interface StatusPillProps {
  children: ReactNode;
  tone?: StatusPillTone;
  title?: string;
}

/**
 * StatusPill — мелкий круглый бейдж для состояний и meta-инфо
 * на новых mobile-экранах. Не вытесняет .status-badge (тот всё ещё
 * нужен в админ/ОТК-таблицах для строгих статусов заказа), а
 * дополняет его для произвольных подписей.
 */
export function StatusPill({ children, tone = 'default', title }: StatusPillProps) {
  const cls = `pill${tone !== 'default' ? ` pill--${tone}` : ''}`;
  return (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}
