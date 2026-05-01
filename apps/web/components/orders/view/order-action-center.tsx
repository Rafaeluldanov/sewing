/**
 * `OrderActionCenter` — компактный блок задач/предупреждений под
 * управленческой шапкой `/admin/orders/[id]`.
 *
 * Цель (см. ТЗ «Action center»): одним взглядом дать менеджеру список
 * проблем по заказу + быстрые ссылки в нужную вкладку. Никаких таблиц
 * и метрик внутри — только короткое текстовое алерт-сообщение и
 * action-link «открыть нужную вкладку / выполнить действие».
 *
 * Все алерты считаются на сервере **из существующих DTO** заказа:
 * `OrderDetailDto`, `PassportListItemDto[]`. Никаких новых API мы не
 * заводим. Если данных для какого-то алерта недостаточно (например,
 * нет endpoint-а на список открытых коробок по заказу) — мы его
 * не выводим, чтобы не зависеть от воображаемого backend-контракта.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  ClipboardList,
  Layers,
  Palette,
  Rocket,
  Route,
  Scale,
} from 'lucide-react';
import type { OrderDetailDto } from '@sewing/shared/orders';
import type { PassportListItemDto } from '@sewing/shared/passports';

type AlertTone = 'danger' | 'warning' | 'info';

interface Alert {
  id: string;
  tone: AlertTone;
  icon: React.ReactNode;
  title: string;
  hint?: string | null;
  /** `?tab=…`-навигация. `null` — нет соответствующей вкладки. */
  cta?: { label: string; href: string } | null;
}

interface Props {
  order: OrderDetailDto;
  passports: PassportListItemDto[];
}

/**
 * Собираем алерты строго от состояния заказа. Порядок важен — самые
 * критичные (`danger`) выводим первыми.
 */
function buildAlerts(
  order: OrderDetailDto,
  passports: PassportListItemDto[],
): Alert[] {
  const alerts: Alert[] = [];
  const orderTabHref = (tab: string) =>
    `/admin/orders/${order.id}?tab=${tab}`;
  const status = order.status;

  // ----- Не хватает данных для расчёта/запуска (DRAFT/CALCULATION) -----
  // Без `items` заказ нельзя ни перевести в расчёт, ни запустить
  // (`OrdersService.startCalculation` отдаст ORDER_ITEMS_REQUIRED).
  if (
    (status === 'DRAFT' ||
      status === 'CALCULATION' ||
      status === 'CALCULATION_DONE') &&
    order.qtyPlanTotal === 0
  ) {
    alerts.push({
      id: 'no-plan',
      tone: 'danger',
      icon: <AlertTriangle size={16} strokeWidth={1.7} aria-hidden />,
      title: 'План по размерам не заполнен',
      hint: 'Без хотя бы одной строки заказ нельзя запустить в производство.',
      cta: order.status === 'DRAFT'
        ? {
            label: 'Открыть редактирование',
            href: `/admin/orders/${order.id}/edit`,
          }
        : { label: 'Открыть план', href: orderTabHref('plan') },
    });
  }

  // ----- Этап «Указать в заказе» (см. ТЗ §4): по строкам техкарты
  // нужен цвет, но менеджер ещё не указал --------------------------
  //
  // Source of truth — `OrderMaterialRequirement.selectedColorText`
  // (через DTO `OrderMaterialRequirementDto`). `WorkshopNeed` тут
  // намеренно не используется: он остаётся derived view + warning,
  // а не source of truth.
  //
  // Алерт показываем для статусов, где действие ещё имеет смысл:
  // DRAFT / CALCULATION / CALCULATION_DONE / IN_PRODUCTION (backend
  // позволяет править пустой `selectedColorText` до тех пор, пока
  // строка не заморожена терминальным DONE/CANCELLED). На
  // DONE/CANCELLED менеджеру уже нечего исправлять, не шумим.
  const colorRequirementsMissing = order.materialRequirements.some(
    (r) =>
      r.requiresColorSelection === true &&
      !r.selectedColorText &&
      !r.resolvedColorText,
  );
  if (
    colorRequirementsMissing &&
    (status === 'DRAFT' ||
      status === 'CALCULATION' ||
      status === 'CALCULATION_DONE' ||
      status === 'IN_PRODUCTION')
  ) {
    alerts.push({
      id: 'material-color-missing',
      tone: status === 'IN_PRODUCTION' ? 'danger' : 'warning',
      icon: <Palette size={16} strokeWidth={1.7} aria-hidden />,
      title: 'По строкам техкарты нужно указать цвет для заказа',
      hint:
        'Откройте вкладку «План» и заполните цвет для строк техкарты с правилом «Указать в заказе».',
      cta: {
        label: 'Указать цвет',
        href: `${orderTabHref('plan')}#order-material-colors`,
      },
    });
  }

  // ----- План ещё не запущен в производство --------------------------
  if (status === 'DRAFT' && order.qtyPlanTotal > 0) {
    alerts.push({
      id: 'not-started',
      tone: 'warning',
      icon: <Rocket size={16} strokeWidth={1.7} aria-hidden />,
      title: 'Заказ ещё в черновике',
      hint: 'Переведите в расчёт, а затем запустите в производство — действия в шапке выше.',
      cta: { label: 'Открыть план', href: orderTabHref('plan') },
    });
  } else if (status === 'CALCULATION') {
    alerts.push({
      id: 'in-calc',
      tone: 'info',
      icon: <ClipboardList size={16} strokeWidth={1.7} aria-hidden />,
      title: 'Заказ в расчёте',
      hint: 'Закупщик готовит потребности и себестоимость. Запуск возможен из этого статуса либо после «Расчёт завершён».',
      cta: { label: 'Открыть потребности', href: orderTabHref('needs') },
    });
  } else if (status === 'CALCULATION_DONE') {
    alerts.push({
      id: 'calc-done',
      tone: 'info',
      icon: <ClipboardList size={16} strokeWidth={1.7} aria-hidden />,
      title: 'Расчёт завершён — план готов к запуску',
      hint: 'Запустите заказ в производство кнопкой выше или верните на пересчёт.',
      cta: { label: 'Открыть потребности', href: orderTabHref('needs') },
    });
  }

  // ----- Запущен, но паспорта ещё не выпущены -----------------------
  if (status === 'IN_PRODUCTION' && passports.length === 0) {
    alerts.push({
      id: 'no-passports',
      tone: 'warning',
      icon: <ClipboardList size={16} strokeWidth={1.7} aria-hidden />,
      title: 'По заказу не выпущен ни один паспорт',
      hint: 'Раскрой ещё не пошёл. Помощник раскройщика выпускает паспорта со страницы выпуска.',
      cta: {
        label: 'Перейти к выпуску паспорта',
        href: `/orders/${order.id}/passports/new`,
      },
    });
  }

  // ----- Брак ------------------------------------------------------
  if (order.summary.qtyDefectTotal > 0) {
    alerts.push({
      id: 'defects',
      tone: 'danger',
      icon: <AlertTriangle size={16} strokeWidth={1.7} aria-hidden />,
      title: `Зафиксирован брак: ${order.summary.qtyDefectTotal.toLocaleString('ru-RU')} шт`,
      hint: 'Подробности — в производственном срезе по размерам.',
      cta: { label: 'Открыть производство', href: orderTabHref('production') },
    });
  }

  // ----- Расхождение план/факт по крою -----------------------------
  // `qtyDeltaTotal = qtyCutFact - qtyPlanTotal`.
  // Положительный — раскроили больше плана; отрицательный — отстаём.
  if (order.summary.qtyDeltaTotal !== 0 && status === 'IN_PRODUCTION') {
    const delta = order.summary.qtyDeltaTotal;
    alerts.push({
      id: 'cut-delta',
      tone: delta < 0 ? 'warning' : 'info',
      icon: <Scale size={16} strokeWidth={1.7} aria-hidden />,
      title:
        delta > 0
          ? `Раскроено больше плана на ${delta.toLocaleString('ru-RU')} шт`
          : `Отставание по крою: ${Math.abs(delta).toLocaleString('ru-RU')} шт`,
      hint:
        delta > 0
          ? 'План иммутабельный после запуска (ADR-0006). Проверьте, нужна ли заявка на закрытие раскроя.'
          : 'План иммутабельный после запуска (ADR-0006). Раскройщик ещё не закрыл норму по части размеров.',
      cta: { label: 'Открыть производство', href: orderTabHref('production') },
    });
  }

  // ----- «В работе осталось N шт» сознательно НЕ алерт -------------
  // Это нормальное production status, а не проблема, требующая
  // действий менеджера. Прогресс выпуска уже виден в шапке
  // (`OrderManagementHeader` → поле «Прогресс»), а размерный
  // breakdown — во вкладке «Производство». Дублировать как алерт не
  // нужно; ActionCenter держим строго для проблем.

  // ----- Маршрут не выбран → операции не подтянутся ---------------
  // Этап «План операций до запуска»: маршрут — обязательный вход для
  // операций (см. `OrderOperationPlanService.calculateForOrder`,
  // `OrderRouteStep[]` snapshot). Если в DRAFT/CALCULATION его нет,
  // менеджер не увидит ни строк операций, ни их вклада в
  // себестоимость.
  //
  // CTA только в DRAFT — там форма редактирования действительно даёт
  // выбрать шаблон маршрута. В CALCULATION/CALCULATION_DONE поле
  // `routeTemplateId` уже нельзя сменить (общий ORDER_LOCKED guard
  // в `OrdersService.update` + `disabled={!isDraft}` на форме edit),
  // и единственный путь — отменить заказ и завести новый. Поэтому в
  // этих статусах мы НЕ даём CTA: ссылка во вкладку «Операции»
  // никуда не ведёт пользователя по делу (вкладка read-only),
  // а ссылка в edit-форму ведёт на disabled-поле и вводит в
  // заблуждение. Лучше явная информационная подсказка без CTA, чем
  // тыкающий в стенку «Открыть операции».
  if (
    !order.routeTemplateId &&
    (status === 'DRAFT' ||
      status === 'CALCULATION' ||
      status === 'CALCULATION_DONE')
  ) {
    alerts.push({
      id: 'no-route',
      tone: status === 'DRAFT' ? 'warning' : 'danger',
      icon: <Route size={16} strokeWidth={1.7} aria-hidden />,
      title: 'Маршрут не выбран — операции не рассчитаются',
      hint:
        status === 'DRAFT'
          ? 'Выберите шаблон маршрута, чтобы система сразу подтянула операции и их стоимость.'
          : 'Без маршрута операции и их стоимость не учитываются в себестоимости. Сменить маршрут уже нельзя — заказ заблокирован после перевода в расчёт.',
      cta:
        status === 'DRAFT'
          ? {
              label: 'Открыть редактирование',
              href: `/admin/orders/${order.id}/edit`,
            }
          : null,
    });
  }

  // ----- План операций требует пересчёта ---------------------------
  if (order.operationPlanIsStale) {
    alerts.push({
      id: 'operation-plan-stale',
      tone: 'warning',
      icon: <Layers size={16} strokeWidth={1.7} aria-hidden />,
      title: 'План операций устарел',
      hint:
        order.operationPlanStaleReason ??
        'После расчёта менялись операции, ставки или нормы времени.',
      cta: { label: 'Открыть операции', href: orderTabHref('operations') },
    });
  }

  // ----- Нет техкарты при попытке расчёта --------------------------
  if (
    (status === 'CALCULATION' ||
      status === 'CALCULATION_DONE' ||
      status === 'IN_PRODUCTION') &&
    order.materialRequirements.length === 0 &&
    order.outsourceRequirements.length === 0
  ) {
    alerts.push({
      id: 'no-snapshot',
      tone: 'warning',
      icon: <Layers size={16} strokeWidth={1.7} aria-hidden />,
      title: 'Не зафиксирован snapshot техкарты',
      hint: 'Snapshot материалов и внешних потребностей пуст — потребности не посчитаются.',
      cta: { label: 'Открыть потребности', href: orderTabHref('needs') },
    });
  }

  return alerts;
}

export function OrderActionCenter({ order, passports }: Props) {
  const alerts = buildAlerts(order, passports);
  const isEmpty = alerts.length === 0;

  return (
    <section
      className="order-action-center"
      aria-label="Задачи и предупреждения по заказу"
    >
      <header className="order-action-center__head">
        <h3 className="order-action-center__title">Задачи и предупреждения</h3>
        <span className="order-action-center__count">
          {isEmpty
            ? 'нет открытых задач'
            : `${alerts.length} ${pluralAlerts(alerts.length)}`}
        </span>
      </header>

      {isEmpty ? (
        <p className="order-action-center__empty">
          Сейчас по заказу нет открытых проблем — производство идёт штатно.
        </p>
      ) : (
        <ul className="order-action-center__list" role="list">
          {alerts.map((a) => (
            <li
              key={a.id}
              className={`order-action-center__item order-action-center__item--${a.tone}`}
            >
              <div className="order-action-center__item-icon" aria-hidden>
                {a.icon}
              </div>
              <div className="order-action-center__item-body">
                <strong className="order-action-center__item-title">
                  {a.title}
                </strong>
                {a.hint && (
                  <span className="order-action-center__item-hint">
                    {a.hint}
                  </span>
                )}
              </div>
              {a.cta && (
                <Link
                  href={a.cta.href}
                  className="order-action-center__item-cta"
                  prefetch={false}
                >
                  {a.cta.label}
                  <ArrowRight size={14} strokeWidth={1.7} aria-hidden />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Плюрализация «1 задача / 3 задачи / 5 задач». Минимум, без icu. */
function pluralAlerts(n: number): string {
  const abs = Math.abs(n) % 100;
  const tail = abs % 10;
  if (abs >= 11 && abs <= 14) return 'задач';
  if (tail === 1) return 'задача';
  if (tail >= 2 && tail <= 4) return 'задачи';
  return 'задач';
}
