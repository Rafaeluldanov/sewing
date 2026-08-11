import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import {
  canSeeAdmin,
  canSeeHome,
  canSeeOrdersMenu,
  canSeePackingMenu,
  canSeeProductionCost,
  canSeeQcMenu,
  canSeeShopfloorMenu,
  canSeeWorkTab,
  canSeeWtoMenu,
  isSingleWorkspaceRole,
} from '@/lib/rbac';
import { LogoutButton } from '@/components/logout-button';
import { MobileNav } from '@/components/mobile-nav';
import { AppHeader } from '@/components/app-header';
import { EmployeeQrButton } from '@/components/employees/employee-qr-button';
import { canSeeEmployeeQrButton } from '@/lib/rbac';
import { SwitchWorkplaceButton } from '@/components/workplace/switch-workplace-button';
import { ChunkErrorGuard } from '@/components/chunk-error-guard';
import { Icon } from '@/components/icon';

export const metadata: Metadata = {
  title: 'Sewing — управление производством',
  description: 'Система управления швейным производством (MVP)',
  // PWA: manifest + иконки нужны, чтобы приложение можно было
  // установить на «Домой». На iOS это ОБЯЗАТЕЛЬНО для Web Push —
  // фоновые пуши приходят только в установленную PWA (iOS 16.4+).
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Sewing',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const me = await getCurrentUserOrNull();
  const isStaff = !!me;
  const role = me?.user.role;
  // Фича «несколько ролей»: навигация/доступ считаются по полному
  // набору ролей (`me.user.roles`), а не только по основной. Fallback
  // `[role]` — для старых сессий без поля в payload.
  const roles = me?.user.roles ?? (role ? [role] : []);
  // Назначенный набор (без раскрытия наследования) — по нему считается
  // «совместитель ли это» для кнопки смены участка.
  const assignedRoles =
    me?.user.assignedRoles ?? me?.user.roles ?? (role ? [role] : []);
  // Backend всё равно режет доступ через `@Roles(...)`, но для UX
  // прячем недоступные ссылки, чтобы роль не упиралась в forbidden
  // экран. Матрица — `apps/web/lib/rbac.ts`.
  //
  // Для CUTTER_ASSISTANT сознательно используем `canSeeOrdersMenu` /
  // `canSeeShopfloorMenu` (а не технические `canSeeOrders`): backend
  // оставляет ему read-доступ к `/orders/*` для flow «Выпустить
  // паспорт» (`/work` → `/work/cut-orders` → `/orders/:id/passports/new`),
  // но в шапке и mobile-nav пункты «Заказы» и «Цех» не показываем —
  // у роли единственная точка входа `/work`.
  //
  // `canSeeHome` / `canSeeWorkTab` реализуют модель «одно рабочее
  // окно на роль» (см. `docs/screens.md §1`):
  //   - производственным ролям пункт «Главная» не нужен — `/`
  //     редиректит в их primary workspace (см. `app/page.tsx`);
  //   - дублирующая вкладка «Работа» скрыта у тех, у кого `/work` уже
  //     primary workspace (CUTTER_ASSISTANT, SEAMSTRESS, CUTTER,
  //     IRONING) и у тех, кому `/work` не нужен (QC, PACKING,
  //     SHOP_MANAGER).
  // Для пунктов терминалов (`/qc`, `/wto`, `/packing`) используем
  // `canSee*Menu`, а не технические `canSee*`: SHOP_MANAGER сохраняет
  // доступ к страницам по прямой ссылке (см. `/qc/layout.tsx` и т.д.),
  // но в меню начальника цеха эти scan-driven терминалы не нужны.
  // У SEAMSTRESS и CUTTER_ASSISTANT (`isSingleWorkspaceRole`) ниже
  // целиком прячем `MobileNav` — экран должен выглядеть как один
  // сфокусированный терминал, без глобальной навигации.
  const showHome = canSeeHome(roles);
  const showWork = canSeeWorkTab(roles);
  const showQc = canSeeQcMenu(roles);
  const showWto = canSeeWtoMenu(roles);
  const showPacking = canSeePackingMenu(roles);
  const showOrders = canSeeOrdersMenu(roles);
  const showShopfloor = canSeeShopfloorMenu(roles);
  const showProductionCost = canSeeProductionCost(roles);
  const showAdmin = canSeeAdmin(roles);
  // «Одно рабочее окно» считает СЕРВЕР по справочнику ролей
  // (`AppRole.singleWorkspace`, приходит в `/api/auth/me`) — иначе
  // кастомная роль ломала бы правило: `me.user.roles` теперь ЭФФЕКТИВНЫЙ
  // набор с раскрытым наследованием, и роль «Швея-бригадир» выглядела бы
  // как совместитель с двумя ролями. `isSingleWorkspaceRole` остаётся
  // fallback-ом для старых сессий, где поля ещё нет.
  const singleWorkspace =
    me?.user.singleWorkspace ??
    isSingleWorkspaceRole(me?.user.assignedRoles ?? roles);
  return (
    <html lang="ru">
      <body>
        <AppHeader role={role}>
          <div className="app-header__brand">
            <Link href="/">
              <span className="brand-mark" aria-hidden>
                <Icon name="sewing" size={16} />
              </span>
              <span>Sewing</span>
            </Link>
          </div>
          <nav className="app-header__nav">
            {showWork && <Link href="/work"><Icon name="work" /><span>Рабочее место</span></Link>}
            {showQc && <Link href="/qc"><Icon name="qc" /><span>ОТК</span></Link>}
            {showWto && <Link href="/wto"><Icon name="wto" /><span>ВТО</span></Link>}
            {showPacking && <Link href="/packing"><Icon name="packing" /><span>Упаковка</span></Link>}
            {showOrders && <Link href="/orders"><Icon name="orders" /><span>Заказы</span></Link>}
            <Link href="/earnings"><Icon name="earnings" /><span>Зарплата</span></Link>
            {showShopfloor && <Link href="/shopfloor"><Icon name="shopfloor" /><span>Цех</span></Link>}
            {showProductionCost && (
              <Link href="/production-cost"><Icon name="production-cost" /><span>Себестоимость</span></Link>
            )}
            {showAdmin && (
              <>
                <Link href="/admin/production-dashboard"><Icon name="dashboard" /><span>Дашборд</span></Link>
                <Link href="/admin/overview"><Icon name="overview" /><span>Обзор</span></Link>
                <Link href="/admin/equipment"><Icon name="equipment" /><span>Оборудование</span></Link>
                <Link href="/admin/warehouses"><Icon name="warehouses" /><span>Склад</span></Link>
                <Link href="/admin/operations"><Icon name="operations" /><span>Операции</span></Link>
                <Link href="/admin/routes"><Icon name="arrow-right" /><span>Маршруты</span></Link>
                <Link href="/admin/tech-cards"><Icon name="orders" /><span>Техкарты</span></Link>
                <Link href="/admin/employees"><Icon name="employees" /><span>Сотрудники</span></Link>
                <Link href="/admin/printers"><Icon name="equipment" /><span>Принтеры</span></Link>
              </>
            )}
          </nav>
          <div className="app-header__user">
            {me ? (
              <>
                <span className="app-header__user-name" title={me.user.login}>
                  {me.user.fullName}
                </span>
                <span className="app-header__user-role">{me.user.role}</span>
                {canSeeEmployeeQrButton(roles) ? (
                  <EmployeeQrButton variant="inline" />
                ) : null}
                <LogoutButton />
              </>
            ) : (
              <Link className="app-header__login" href="/login">
                <Icon name="login" />
                <span>Войти</span>
              </Link>
            )}
          </div>
        </AppHeader>
        <main className="app-main">{children}</main>
        <ChunkErrorGuard />
        {isStaff && !singleWorkspace ? (
          <MobileNav
            showHome={showHome}
            showWork={showWork}
            showQc={showQc}
            showWto={showWto}
            showPacking={showPacking}
            showOrders={showOrders}
          />
        ) : null}
        {/*
          Фича «несколько ролей»: плавающая кнопка «Сменить участок» —
          только для совместителей. Считаем по НАЗНАЧЕННЫМ ролям
          (`assignedRoles`), а не по эффективным: у кастомной роли с
          `inherits` эффективный набор длиннее одного элемента, и кнопка
          показывалась человеку с единственным участком (та же ловушка,
          что уже обошли для `singleWorkspace` выше).
        */}
        {isStaff && assignedRoles.length > 1 ? <SwitchWorkplaceButton /> : null}
      </body>
    </html>
  );
}
