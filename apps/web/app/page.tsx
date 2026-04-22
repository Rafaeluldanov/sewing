import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  canSeeOrdersMenu,
  canSeePackingMenu,
  canSeeQcMenu,
  canSeeWorkTab,
  canSeeWtoMenu,
  getPrimaryWorkspace,
  isWorkingRole,
} from '@/lib/rbac';
import { MobileActionCard } from '@/components/mobile-action-card';
import { Icon } from '@/components/icon';

export const dynamic = 'force-dynamic';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник закройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
};

export default async function HomePage() {
  const me = await getCurrentUserOrNull();

  if (!me) {
    return (
      <div className="card" style={{ maxWidth: 640 }}>
        <h1
          style={{
            marginTop: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.55rem',
          }}
        >
          <span className="brand-mark" aria-hidden>
            <Icon name="sewing" size={16} />
          </span>
          Sewing
        </h1>
        <p className="meta-line" style={{ marginTop: 0 }}>
          Система управления швейным производством. Войдите, чтобы открыть
          рабочее место.
        </p>
        <div className="actions-row">
          <Link className="btn btn-primary btn-lg" href="/login">
            <Icon name="login" size={18} />
            <span style={{ marginLeft: '0.4rem' }}>Войти</span>
          </Link>
        </div>
      </div>
    );
  }

  const role = me.user.role;
  // Модель «одно рабочее окно на роль»: для производственных ролей
  // корневой `/` — это всего лишь входная точка, а не отдельный
  // экран. Сразу уводим в их primary workspace (см.
  // `apps/web/lib/rbac.ts`, `docs/screens.md §1`). Менеджерам и
  // админам primary workspace = `/`, поэтому они продолжают видеть
  // плитку ниже.
  if (isWorkingRole(role)) {
    redirect(getPrimaryWorkspace(role));
  }
  const roleLabel = ROLE_LABELS[role] ?? role;
  const isManager = role === 'SHOP_MANAGER' || role === 'ADMIN';
  // Тайлы скрываются по той же матрице, что и навигация в шапке —
  // см. `apps/web/lib/rbac.ts`. Для терминалов используем `*Menu`-
  // хелперы, чтобы SHOP_MANAGER не видел плитки «Рабочее место» /
  // «ОТК» / «ВТО» / «Упаковка»: технический доступ к страницам у
  // роли остаётся (через прямую ссылку), но на главной начальника
  // цеха scan-driven терминалы операторов как точки входа не нужны.
  const showWork = canSeeWorkTab(role);
  const showQc = canSeeQcMenu(role);
  const showWto = canSeeWtoMenu(role);
  const showPacking = canSeePackingMenu(role);
  // Тайл «Заказы» на главной — entry point в admin-раздел заказов.
  // Для CUTTER_ASSISTANT технический read-доступ к `/orders/*` сохранён
  // (нужен для flow «Выпустить паспорт»: `/work` → `/work/cut-orders` →
  // `/orders/:id/passports/new`), но точку входа в этот раздел в UI
  // помощнику не показываем — у него единственный вход `/work`.
  // Используем тот же `canSeeOrdersMenu`, что и в `layout.tsx` /
  // `mobile-nav.tsx`, чтобы не плодить третью матрицу видимости.
  const showOrders = canSeeOrdersMenu(role);

  return (
    <div className="page-shell">
      <div>
        <div className="page-eyebrow">
          <Icon name="sparkle" />
          {roleLabel}
        </div>
        <h1 className="page-title" style={{ marginBottom: '0.35rem' }}>
          Здравствуйте, {me.user.fullName.split(' ')[0]}
        </h1>
        <p className="page-subtitle">
          {isManager
            ? 'Сводка по производству, цех в реальном времени и быстрые действия — на одном экране.'
            : 'Выберите, с чего начнёте смену.'}
        </p>
      </div>

      {isManager && (
        <div className="section-header">
          <h2>
            <Icon name="dashboard" />
            Управление производством
          </h2>
          <span className="section-header__hint">Главные экраны менеджера</span>
        </div>
      )}

      <div className="action-grid">
        {isManager && (
          <MobileActionCard
            href="/admin/production-dashboard"
            variant="primary"
            icon={<Icon name="dashboard" size={20} />}
            title="Дашборд начальника"
            hint="KPI, pipeline, простой и алерты"
          />
        )}
        {isManager && (
          <MobileActionCard
            href="/shopfloor"
            icon={<Icon name="shopfloor" size={20} />}
            title="Цех"
            hint="Real-time доска"
          />
        )}
        {isManager && (
          <MobileActionCard
            href="/production-cost"
            icon={<Icon name="production-cost" size={20} />}
            title="Себестоимость"
            hint="Выпуск, оклад, простой по дням"
          />
        )}
        <MobileActionCard
          href="/earnings"
          icon={<Icon name="earnings" size={20} />}
          title="Зарплата"
          hint="Сдельные начисления"
        />
        {showOrders && (
          <MobileActionCard
            href="/orders"
            icon={<Icon name="orders" size={20} />}
            title="Заказы"
            hint="План и статусы"
          />
        )}
        {isManager && (
          <MobileActionCard
            href="/admin/employees"
            icon={<Icon name="employees" size={20} />}
            title="Сотрудники"
            hint="Тип оплаты, ставка за смену"
          />
        )}
        {isManager && (
          <MobileActionCard
            href="/admin/operations"
            icon={<Icon name="operations" size={20} />}
            title="Операции"
            hint="Тарифы и ставки операций"
          />
        )}
        {isManager && (
          <MobileActionCard
            href="/admin/warehouses"
            icon={<Icon name="warehouses" size={20} />}
            title="Склад"
            hint="Склады и ячейки, печать QR"
          />
        )}
        {showWork && (
          <MobileActionCard
            href="/work"
            variant="primary"
            icon={<Icon name="work" size={20} />}
            title="Рабочее место"
            hint="Сканировать паспорт, получить крой"
          />
        )}
        {showQc && (
          <MobileActionCard
            href="/qc"
            icon={<Icon name="qc" size={20} />}
            title="ОТК"
            hint="Зафиксировать брак, годных"
          />
        )}
        {showWto && (
          <MobileActionCard
            href="/wto"
            icon={<Icon name="wto" size={20} />}
            title="ВТО"
            hint="Принять и завершить ВТО"
          />
        )}
        {showPacking && (
          <MobileActionCard
            href="/packing"
            icon={<Icon name="packing" size={20} />}
            title="Упаковка"
            hint="Коробки, выпуск изделий"
          />
        )}
      </div>
    </div>
  );
}
