'use client';

/**
 * Сворачиваемый блок расцветки на вкладке «Сводно по заказу»
 * (`OrderSummaryUnifiedTable`, фича «Расцветки»).
 *
 * Шапка блока видна всегда и несёт главную цифру — материальную
 * себестоимость расцветки (Σ за тираж расцветки / за 1 изделие
 * расцветки); таблица строк (server-компонент `AdminTable`)
 * передаётся как `children` и прячется под «Развернуть». По
 * умолчанию блок свёрнут: менеджер сначала видит компактный список
 * расцветок с их суммами, детали раскрывает по клику.
 *
 * Тот же блок используется для группы «Общее по заказу»
 * (`kind="common"` — строки без расцветки: нанесение / ручные /
 * прочее) и для секции «Операции» (`kind="operations"` — работа по
 * маршруту; отдельный блок, а не часть «Общего», потому что подытог
 * общего блока — материальная часть, а операции — деньги за работу
 * из снимка `Order.operationCostPlanRub`, в «Итого» они тоже
 * раздельно).
 *
 * Компонент client только ради сворачивания — паттерн
 * `OrderNeedsCollapsible` (children рендерится на сервере и
 * переключается видимостью, без повторного fetch на клиенте).
 */

import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Layers,
  Palette,
  Wrench,
} from 'lucide-react';

interface SummaryItem {
  label: string;
  value: string;
}

type BlockKind = 'colorway' | 'common' | 'operations';

const KIND_ICONS: Record<BlockKind, typeof Palette> = {
  colorway: Palette,
  common: Layers,
  operations: Wrench,
};

const KIND_TESTIDS: Record<BlockKind, string> = {
  colorway: 'order-summary-colorway-block',
  common: 'order-summary-common-block',
  operations: 'order-summary-operations-block',
};

interface Props {
  /** Заголовок блока («Чёрный» / «Общее по заказу» / «Операции»). */
  title: string;
  /** Вид блока: расцветка / общие строки заказа / операции. */
  kind: BlockKind;
  /** Число строк в блоке — бейдж у заголовка. */
  count: number;
  /** Тираж расцветки («120 шт») или `null`, если неизвестен. */
  qtyLabel?: string | null;
  /** Компактная сводка (материальная часть Σ / за 1 изделие). */
  summary?: SummaryItem[];
  /** Предупреждения группы (USD без курса / нет цены). */
  warnings?: string[];
  /** Таблица строк — server-компонент, прячется под разворотом. */
  children: ReactNode;
  /** Открыт ли блок по умолчанию (по умолчанию свёрнут). */
  defaultOpen?: boolean;
}

export function OrderSummaryColorwayCollapsible({
  title,
  kind,
  count,
  qtyLabel,
  summary,
  warnings,
  children,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = KIND_ICONS[kind];

  return (
    <section
      className="summary-colorway"
      data-open={open || undefined}
      data-kind={kind}
      data-testid={KIND_TESTIDS[kind]}
    >
      <div className="summary-colorway__head">
        <div className="summary-colorway__title-row">
          <Icon size={18} strokeWidth={1.8} aria-hidden />
          <span className="summary-colorway__title">{title}</span>
          <span className="summary-colorway__count">{count}</span>
          {qtyLabel ? (
            <span className="summary-colorway__qty">{qtyLabel}</span>
          ) : null}
        </div>
        {summary && summary.length > 0 ? (
          <div className="summary-colorway__summary">
            {summary.map((s) => (
              <div key={s.label} className="summary-colorway__sum">
                <span className="summary-colorway__sum-k">{s.label}</span>
                <span className="summary-colorway__sum-v">{s.value}</span>
              </div>
            ))}
          </div>
        ) : null}
        {warnings && warnings.length > 0 ? (
          <ul className="summary-colorway__warnings" role="status">
            {warnings.map((w) => (
              <li key={w}>
                <AlertTriangle size={12} strokeWidth={1.7} aria-hidden /> {w}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {open ? (
        <div className="summary-colorway__body">{children}</div>
      ) : null}

      <button
        type="button"
        className="summary-colorway__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Свернуть строки' : 'Развернуть строки'}
        <ChevronDown
          size={16}
          strokeWidth={2}
          aria-hidden
          className="summary-colorway__chev"
        />
      </button>
    </section>
  );
}
