/**
 * Admin home (`/admin`) — стартовая страница админки (Admin UI 2.6).
 *
 * После финальной чистки (см. ТЗ Admin Final Cleanup) — это просто
 * dashboard разделов: цветные soft-bubble иконки, реальные счётчики
 * сущностей и быстрый переход в раздел. Производственные виджеты
 * (KPI выпуска и тепловая карта потока) убраны, чтобы /admin не
 * дублировал /shopfloor/display и /admin/overview и оставался лёгкой
 * стартовой страницей для менеджера.
 *
 * Стратегия загрузки счётчиков — `Promise.allSettled`-style через
 * `safeCount`: если конкретный список упал, остальные карточки
 * продолжают работать и показывают «нет данных».
 */
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Box,
  CheckCircle2,
  ClipboardList,
  Clock,
  Factory,
  HelpCircle,
  Home,
  Package,
  Printer,
  Scissors,
  Search,
  TrendingUp,
  Users,
  Warehouse,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  ORDER_DEADLINE_LABELS,
  type OrderDeadlineStatus,
} from '@sewing/shared/order-deadlines';
import { listEmployees } from '@/lib/employees-api';
import { listEquipment } from '@/lib/equipment-api';
import { listOperations } from '@/lib/operations-api';
import { listOrders } from '@/lib/orders-api';
import { listRouteTemplates } from '@/lib/routes-api';
import { listWarehouses } from '@/lib/warehouses-api';
import { listPrinters } from '@/lib/printers-api';

export const dynamic = 'force-dynamic';

type DashboardTone = 'blue' | 'green' | 'orange' | 'purple';

interface DashboardCard {
  href: string;
  title: string;
  description: string;
  Icon: LucideIcon;
  tone: DashboardTone;
  count: number | null;
  unitForms?: [string, string, string];
}

function pluralizeRu(value: number, forms: [string, string, string]): string {
  const pr = new Intl.PluralRules('ru-RU');
  const cat = pr.select(value);
  if (cat === 'one') return forms[0];
  if (cat === 'few') return forms[1];
  return forms[2];
}

async function safeCount<T>(p: Promise<T[]>): Promise<number | null> {
  try {
    return (await p).length;
  } catch {
    return null;
  }
}

/**
 * Сводка «бакетов контроля сроков» для KPI-полосы. Тянем все заказы
 * один раз и считаем 4 счётчика на месте: backend `OrdersService.list`
 * уже отдаёт `deadline.status`, и переиспользовать его дешевле, чем
 * заводить отдельный endpoint. На MVP-объёмах (тысячи заказов)
 * pageSize=200 + один запрос даёт стабильную верхнюю границу:
 * 4 KPI всегда показывают актуальную картину «что требует внимания».
 *
 * Если запрос упал (auth/down), возвращаем `null` — UI покажет
 * «нет данных», остальные блоки `/admin` продолжают работать.
 */
type DeadlineKpis = Record<
  Exclude<OrderDeadlineStatus, 'DONE'>,
  number
> | null;

async function loadDeadlineKpis(): Promise<DeadlineKpis> {
  try {
    const data = await listOrders({ pageSize: 200, page: 1 });
    const counts: Record<Exclude<OrderDeadlineStatus, 'DONE'>, number> = {
      OVERDUE: 0,
      AT_RISK: 0,
      ON_TRACK: 0,
      NO_DUE_DATE: 0,
    };
    for (const o of data.items) {
      const s = o.deadline?.status;
      if (s && s !== 'DONE') counts[s] += 1;
    }
    return counts;
  } catch {
    return null;
  }
}

const HOME_BUBBLE_CLASS: Record<DashboardTone, string> = {
  blue: 'admin-home-card__icon--blue',
  green: 'admin-home-card__icon--green',
  orange: 'admin-home-card__icon--orange',
  purple: 'admin-home-card__icon--purple',
};

export default async function AdminHomePage() {
  const [
    employeesCount,
    equipmentCount,
    operationsCount,
    routesCount,
    warehousesCount,
    printersCount,
    deadlineKpis,
  ] = await Promise.all([
    safeCount(listEmployees()),
    safeCount(listEquipment()),
    safeCount(listOperations()),
    safeCount(listRouteTemplates()),
    safeCount(listWarehouses()),
    safeCount(listPrinters()),
    loadDeadlineKpis(),
  ]);

  const cards: DashboardCard[] = [
    {
      href: '/admin/orders',
      title: 'Заказы',
      description: 'Партии в производстве.',
      Icon: Package,
      tone: 'blue',
      count: null,
    },
    {
      href: '/admin/overview',
      title: 'Обзор смены',
      description: 'Активные смены и открытые коробки.',
      Icon: Home,
      tone: 'blue',
      count: null,
    },
    {
      href: '/admin/employees',
      title: 'Сотрудники',
      description: 'Роли, ставки, PIN.',
      Icon: Users,
      tone: 'green',
      count: employeesCount,
      unitForms: ['сотрудник', 'сотрудника', 'сотрудников'],
    },
    {
      href: '/admin/equipment',
      title: 'Оборудование',
      description: 'Станки и рабочие места.',
      Icon: Factory,
      tone: 'orange',
      count: equipmentCount,
      unitForms: ['станок', 'станка', 'станков'],
    },
    {
      href: '/admin/operations',
      title: 'Операции',
      description: 'Тарифы и режим оплаты.',
      Icon: Scissors,
      tone: 'orange',
      count: operationsCount,
      unitForms: ['операция', 'операции', 'операций'],
    },
    {
      href: '/admin/routes',
      title: 'Маршруты',
      description: 'Шаблоны последовательности операций.',
      Icon: Activity,
      tone: 'blue',
      count: routesCount,
      unitForms: ['шаблон', 'шаблона', 'шаблонов'],
    },
    {
      href: '/admin/warehouses',
      title: 'Склады',
      description: 'Склады и ячейки хранения.',
      Icon: Warehouse,
      tone: 'green',
      count: warehousesCount,
      unitForms: ['склад', 'склада', 'складов'],
    },
    {
      href: '/admin/printers',
      title: 'Принтеры',
      description: 'Принтеры и печать этикеток.',
      Icon: Printer,
      tone: 'orange',
      count: printersCount,
      unitForms: ['принтер', 'принтера', 'принтеров'],
    },
    {
      href: '/admin/diagnostics',
      title: 'Диагностика',
      description: 'Read-only отчёт по состояниям БД.',
      Icon: Search,
      tone: 'purple',
      count: null,
    },
    {
      href: '/admin/production-cost',
      title: 'Себестоимость',
      description: 'Аналитика затрат и ФОТ.',
      Icon: Box,
      tone: 'green',
      count: null,
    },
  ];

  return (
    <div className="admin-page-shell">
      <header className="admin-page-shell__header">
        <div className="admin-page-shell__heading">
          <span className="admin-page-shell__icon" aria-hidden>
            <TrendingUp size={22} strokeWidth={1.6} />
          </span>
          <div className="admin-page-shell__title-block">
            <h1 className="admin-page-title">Обзор</h1>
            <p className="admin-page-shell__subtitle">
              Стартовая страница админки.
            </p>
          </div>
        </div>
      </header>

      <DeadlineKpiBlock kpis={deadlineKpis} />

      <div className="admin-home-grid">
        {cards.map((c) => {
          const Icon = c.Icon;
          return (
            <Link key={c.href} href={c.href} className="admin-home-card">
              <span
                className={`admin-home-card__icon ${HOME_BUBBLE_CLASS[c.tone]}`}
                aria-hidden
              >
                <Icon size={22} strokeWidth={1.6} />
              </span>
              <h2 className="admin-home-card__title">{c.title}</h2>
              <p className="admin-home-card__desc">{c.description}</p>
              {c.count !== null && c.unitForms ? (
                <span className="admin-home-card__stat">
                  <span className="admin-home-card__stat-num">
                    {c.count.toLocaleString('ru-RU')}
                  </span>
                  <span className="admin-home-card__stat-unit">
                    {pluralizeRu(c.count, c.unitForms)}
                  </span>
                </span>
              ) : c.unitForms ? (
                <span className="admin-home-card__stat admin-home-card__stat--muted">
                  <span className="admin-home-card__stat-unit">
                    нет данных
                  </span>
                </span>
              ) : null}
              <span className="admin-home-card__cta">
                Открыть
                <ArrowRight size={16} strokeWidth={1.6} />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Блок «Контроль сроков» на /admin: 4 KPI-карточки (Просрочено / В риске
 * / В срок / Без срока) с кликом в `/admin/orders?deadline=…`.
 *
 * Дизайн намеренно minimal: число + лейбл + цвет тона. Никакой
 * heatmap, никаких длинных описаний (см. ТЗ §6). Переход по карточке —
 * это сразу отфильтрованный список, чтобы менеджер за один клик видел
 * заказы, требующие внимания.
 */
function DeadlineKpiBlock({ kpis }: { kpis: DeadlineKpis }) {
  const tiles: Array<{
    status: Exclude<OrderDeadlineStatus, 'DONE'>;
    Icon: LucideIcon;
    cls: string;
  }> = [
    { status: 'OVERDUE', Icon: AlertTriangle, cls: 'admin-deadline-kpi--danger' },
    { status: 'AT_RISK', Icon: Clock, cls: 'admin-deadline-kpi--warning' },
    { status: 'ON_TRACK', Icon: CheckCircle2, cls: 'admin-deadline-kpi--success' },
    { status: 'NO_DUE_DATE', Icon: HelpCircle, cls: 'admin-deadline-kpi--muted' },
  ];
  return (
    <section className="admin-deadline-kpis" aria-label="Контроль сроков">
      <header className="admin-deadline-kpis__header">
        <h2 className="admin-deadline-kpis__title">Контроль сроков</h2>
        <p className="admin-deadline-kpis__hint">
          Заказы, требующие внимания. Кликните, чтобы открыть отфильтрованный
          список.
        </p>
      </header>
      <div className="admin-deadline-kpis__grid">
        {tiles.map((t) => {
          const value = kpis ? kpis[t.status] : null;
          const Icon = t.Icon;
          return (
            <Link
              key={t.status}
              href={`/admin/orders?deadline=${t.status}`}
              className={`admin-deadline-kpi ${t.cls}`}
            >
              <span className="admin-deadline-kpi__icon" aria-hidden>
                <Icon size={20} strokeWidth={1.6} />
              </span>
              <span className="admin-deadline-kpi__value">
                {value === null ? '—' : value.toLocaleString('ru-RU')}
              </span>
              <span className="admin-deadline-kpi__label">
                {ORDER_DEADLINE_LABELS[t.status]}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
