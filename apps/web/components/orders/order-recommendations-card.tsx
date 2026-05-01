/**
 * `OrderRecommendationsCard` — rule-based рекомендации в карточке
 * заказа. Не AI, никакого ML — простой обход уже посчитанных
 * полей `OrderDetailDto` + текущего состояния расчёта.
 *
 * Источники сигналов:
 *   - сам заказ (`order.customerUnitPrice`, `order.dueDate`,
 *     `order.client`/`customer`, `order.patternItemId`,
 *     `order.items`, `order.routeTemplateId`, `order.techCardId`,
 *     `order.applications`);
 *   - snapshot планa операций (`operationCostPlanRub`,
 *     `operationPlanIsStale`, `operationPlanWarnings`);
 *   - snapshot себестоимости (`costEstimateTotalRub` и
 *     `currentCostEstimate`);
 *   - дедлайн-сводка (`order.deadline`).
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 * Никаких side-effects: только выбор и рендер.
 */
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { OrderDetailDto } from '@sewing/shared/orders';

interface Props {
  order: OrderDetailDto;
}

type Severity = 'info' | 'warning' | 'danger';

interface Recommendation {
  id: string;
  severity: Severity;
  title: string;
  hint?: string;
}

function buildRecommendations(order: OrderDetailDto): Recommendation[] {
  const out: Recommendation[] = [];

  if (!order.customerUnitPrice) {
    out.push({
      id: 'no-price',
      severity: 'warning',
      title: 'Не заполнена цена продажи за единицу',
      hint: 'Без цены не получится посчитать выручку и маржу.',
    });
  }
  if (
    order.customerUnitPrice &&
    Number(order.customerUnitPrice) > 0 &&
    !order.customerCurrency
  ) {
    out.push({
      id: 'no-currency',
      severity: 'warning',
      title: 'Не указана валюта продажи',
      hint: 'Цена есть, валюта пуста — backend подставит RUB по умолчанию.',
    });
  }
  if (!order.dueDate) {
    out.push({
      id: 'no-due',
      severity: 'warning',
      title: 'Не указан срок сдачи',
      hint: 'Без срока в Production board нельзя контролировать выпуск.',
    });
  } else if (order.deadline?.status === 'OVERDUE') {
    out.push({
      id: 'overdue',
      severity: 'danger',
      title: 'Заказ просрочен',
      hint: order.deadline.label,
    });
  } else if (order.deadline?.status === 'AT_RISK') {
    out.push({
      id: 'at-risk',
      severity: 'warning',
      title: 'Заказ под риском срыва',
      hint: order.deadline.label,
    });
  }
  if (!order.client && !order.customer) {
    out.push({
      id: 'no-client',
      severity: 'warning',
      title: 'Не выбран клиент / заказчик',
      hint: 'Без клиента сложно отчётно фиксировать заказ.',
    });
  }
  if (!order.patternItemId) {
    out.push({
      id: 'no-pattern',
      severity: 'danger',
      title: 'Не выбрана номенклатура / лекало',
      hint: 'Без лекала нельзя рассчитать материалы и крой.',
    });
  }
  if (order.items.length === 0 || order.qtyPlanTotal <= 0) {
    out.push({
      id: 'no-sizes',
      severity: 'danger',
      title: 'Пустая размерная матрица',
      hint: 'Заполните количество хотя бы по одному размеру.',
    });
  }
  if (!order.routeTemplateId && order.routeSteps.length === 0) {
    out.push({
      id: 'no-route',
      severity: 'warning',
      title: 'Не выбран маршрут',
      hint: 'Без маршрута план операций не считается.',
    });
  }
  if (!order.techCardId && order.materialRequirements.length === 0) {
    out.push({
      id: 'no-tech-card',
      severity: 'warning',
      title: 'Не выбрана техкарта',
      hint: 'Без техкарты потребность материалов не рассчитывается.',
    });
  }

  // Operation-plan freshness / warnings
  if (order.operationPlanIsStale) {
    out.push({
      id: 'op-plan-stale',
      severity: 'warning',
      title: 'План операций устарел — нужен пересчёт',
      hint:
        order.operationPlanStaleReason ??
        'После расчёта менялись операции, ставки или нормы времени.',
    });
  }
  for (const w of order.operationPlanWarnings ?? []) {
    out.push({
      id: `op-plan-w-${w}`,
      severity: 'warning',
      title: 'План операций неполный',
      hint: w,
    });
  }

  // Cost estimate state
  if (
    order.status === 'CALCULATION' &&
    !order.currentCostEstimate
  ) {
    out.push({
      id: 'calc-not-completed',
      severity: 'info',
      title: 'Расчёт не завершён',
      hint:
        'Закупщик заполняет «К закупке», цены и валюту по строкам, затем нажимает «Завершить расчёт».',
    });
  }

  // Applications: при наличии заказа в DRAFT / CALCULATION предупреждаем,
  // если у нанесений нет цвета / параметров.
  if (order.applications && order.applications.length > 0) {
    for (const app of order.applications) {
      if (!app.colorText) {
        out.push({
          id: `app-no-color-${app.id}`,
          severity: 'info',
          title: 'У нанесения не указан цвет',
          hint: `${app.typeLabel ?? app.type} · ${app.stageLabel ?? app.stage}`,
        });
      }
    }
  }

  // USD-строки в расчёте: если есть, обязательно нужен курс USD/RUB.
  if (
    order.currentCostEstimate &&
    order.currentCostEstimate.lines.some(
      (l) => l.quotedCurrency === 'USD',
    ) &&
    !order.currentCostEstimate.usdRateRub
  ) {
    out.push({
      id: 'usd-no-rate',
      severity: 'warning',
      title: 'Расчёт в USD без курса',
      hint: 'Закупщик должен указать курс USD/RUB при завершении расчёта.',
    });
  }

  return out;
}

export function OrderRecommendationsCard({ order }: Props) {
  const items = buildRecommendations(order);

  if (items.length === 0) {
    return (
      <div className="order-recommendations-card order-recommendations-card--empty">
        <CheckCircle2 size={20} strokeWidth={1.7} aria-hidden />
        <div>
          <strong>Замечаний нет</strong>
          <p className="admin-muted" style={{ margin: 0, fontSize: '0.85rem' }}>
            Заказ заполнен корректно. Никаких блокеров расчёта или
            производства не обнаружено.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="order-recommendations-card">
      <header className="order-recommendations-card__head">
        <h3 className="order-recommendations-card__title">
          Рекомендации по заказу
        </h3>
        <span className="order-recommendations-card__count">
          {items.length}
        </span>
      </header>
      <ul className="order-recommendations-card__list" role="list">
        {items.map((it) => (
          <li
            key={it.id}
            className={`order-recommendations-card__item order-recommendations-card__item--${it.severity}`}
          >
            <RecommendationIcon severity={it.severity} />
            <div className="order-recommendations-card__item-body">
              <div className="order-recommendations-card__item-title">
                {it.title}
              </div>
              {it.hint && (
                <div className="order-recommendations-card__item-hint">
                  {it.hint}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecommendationIcon({ severity }: { severity: Severity }) {
  if (severity === 'danger' || severity === 'warning') {
    return (
      <span
        className={`order-recommendations-card__icon order-recommendations-card__icon--${severity}`}
        aria-hidden
      >
        <AlertTriangle size={16} strokeWidth={1.7} />
      </span>
    );
  }
  return (
    <span
      className="order-recommendations-card__icon order-recommendations-card__icon--info"
      aria-hidden
    >
      <Info size={16} strokeWidth={1.7} />
    </span>
  );
}
