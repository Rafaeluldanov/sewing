/**
 * `MaterialIssuesSection` — блок «Фактический расход материалов»
 * в карточке заказа (`/admin/orders/[id]?tab=needs`). Добавляется
 * ПОСЛЕ существующей `OrderMaterialsUnifiedTable` во вкладке
 * «Потребности» (см.
 * `apps/web/components/orders/view/tabs/order-needs-tab.tsx`).
 *
 * UI-решение владельца (см. ТЗ frontend-итерации):
 *   - блок живёт ТОЛЬКО в карточке заказа;
 *   - отдельная страница `/admin/material-issues` НЕ создаётся;
 *   - новый пункт меню / вкладка НЕ добавляются.
 *
 * Что делает:
 *   1. Загружает список документов через `GET /api/orders/:orderId/material-issues`;
 *   2. Параллельно подтягивает `GET /api/material-issues/:id` по
 *      каждому документу, чтобы в таблице можно было раскрыть
 *      preview строк (`MaterialIssueLinesPreview`). Документов на
 *      заказе мало, это дешёвый параллельный fetch;
 *   3. Показывает сводку «Всего / DRAFT / POSTED / CANCELLED / Σ POSTED»;
 *   4. Для ADMIN / SHOP_MANAGER показывает кнопку «Создать расход»,
 *      которая раскрывает `CreateMaterialIssueDialog`. Для остальных
 *      ролей таблица остаётся read-only (layout `/admin/*` пускает
 *      только менеджеров, но флаг `canManage` — source of truth для
 *      UI-видимости действий).
 *
 * Сознательная граница MVP:
 *   - не расширяем `OrderMaterialsUnifiedTable` колонками
 *     `issuedQtyFact`/`actualCost`/`deltaQty` (ТЗ §9);
 *   - не меняем `OrderSummaryUnifiedTable` (ТЗ §10);
 *   - складские остатки / FIFO / автосписание при выдаче кроя
 *     по-прежнему НЕ реализованы (см. `docs/current-state.md §1`).
 *
 * Backend НЕ трогаем — все эндпоинты уже есть.
 */
import { PackageCheck } from 'lucide-react';
import type {
  MaterialIssueDetailDto,
  MaterialIssueListItemDto,
  MaterialIssueStatus,
} from '@sewing/shared/material-issues';
import type { PassportListItemDto } from '@sewing/shared/passports';
import type { WorkshopNeedListItemDto } from '@sewing/shared/workshop-needs';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import {
  getMaterialIssue,
  listOrderMaterialIssues,
} from '@/lib/material-issues-api';
import { getOrderWorkshopNeeds } from '@/lib/workshop-needs-api';
import { CreateMaterialIssueButton } from './create-material-issue-button';
import { MaterialIssuesTable } from './material-issues-table';

interface Props {
  orderId: string;
  /**
   * Флаг «пользователь может управлять документами расхода» (ADMIN /
   * SHOP_MANAGER). Страница `/admin/*` пускает только менеджерские
   * роли, но явный props нужен для симметрии с остальными
   * action-блоками (`OrderOutsourceList::canManage` и т.д.) и чтобы
   * UI-видимость действий не зависела от layout-гарантий.
   */
  canManage: boolean;
  /**
   * Паспорта заказа. На frontend-итерации MVP мы не делаем отдельный
   * fetch справочника паспортов ради одной формы — берём то, что
   * `AdminOrderDetailPage` уже подгружает для других блоков.
   */
  passports: PassportListItemDto[];
  /**
   * Преподгруженный список документов «Фактический расход материалов»
   * по заказу. На frontend-итерации «план/факт» родительский
   * `OrderNeedsTab` загружает массив один раз и пробрасывает и
   * сюда, и в `OrderMaterialsUnifiedTable` — без второго
   * `GET /api/orders/:id/material-issues`. Если `undefined` —
   * секция fallback-ом грузит список сама (для совместимости с
   * любыми будущими консьюмерами и тестами; см. ТЗ §1 «Вариант A»).
   */
  preloadedItems?: MaterialIssueListItemDto[];
  /**
   * Преподгруженные `MaterialIssueDetailDto` по тем же документам
   * (мапа `id → detail`). Если передано — секция использует их и
   * не делает per-issue `GET /api/material-issues/:id`. Если
   * `undefined` — fallback-ом догружает сама.
   */
  preloadedIssueDetails?: Record<string, MaterialIssueDetailDto | undefined>;
}

interface Summary {
  total: number;
  byStatus: Record<MaterialIssueStatus, number>;
  /** Decimal как строка; считаем только по POSTED. */
  postedTotal: string;
}

function buildSummary(items: MaterialIssueListItemDto[]): Summary {
  const byStatus: Record<MaterialIssueStatus, number> = {
    DRAFT: 0,
    POSTED: 0,
    CANCELLED: 0,
  };
  let postedTotal = 0;
  for (const item of items) {
    const s = item.status as MaterialIssueStatus;
    if (s in byStatus) {
      byStatus[s] += 1;
    }
    if (s === 'POSTED') {
      const n = Number(item.totalCost);
      if (Number.isFinite(n)) postedTotal += n;
    }
  }
  return {
    total: items.length,
    byStatus,
    postedTotal: postedTotal.toString(),
  };
}

const RUB_FORMATTER = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 2,
});

function formatRubSum(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return RUB_FORMATTER.format(n);
}

function toErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiRequestError) {
    return `${e.message}${e.code ? ` (${e.code})` : ''}`;
  }
  return fallback;
}

export async function MaterialIssuesSection({
  orderId,
  canManage,
  passports,
  preloadedItems,
  preloadedIssueDetails,
}: Props) {
  // Variant A (см. ТЗ §1): родитель `OrderNeedsTab` грузит массив
  // и details один раз и прокидывает и сюда, и в
  // `OrderMaterialsUnifiedTable` — без второго fetch. Если
  // preloaded-prop отсутствует — fallback-ом грузим сами, чтобы
  // секцию всё ещё можно было использовать в любом контексте.
  let items: MaterialIssueListItemDto[] = preloadedItems ?? [];
  let loadError: string | null = null;
  if (!preloadedItems) {
    try {
      items = await listOrderMaterialIssues(orderId);
    } catch (e) {
      loadError = toErrorMessage(
        e,
        'Не удалось загрузить документы расхода материалов',
      );
    }
  }

  let issueDetails: Record<string, MaterialIssueDetailDto | undefined>;
  if (preloadedIssueDetails) {
    issueDetails = preloadedIssueDetails;
  } else {
    // Параллельно грузим детали по каждому документу, чтобы таблица
    // могла показать preview строк. Если деталь упала — просто
    // рендерим таблицу без preview для этой строки, остальные
    // продолжают работать.
    const detailsEntries = await Promise.all(
      items.map(async (item) => {
        try {
          const detail = await getMaterialIssue(item.id);
          return [item.id, detail] as const;
        } catch {
          return [item.id, undefined] as const;
        }
      }),
    );
    issueDetails = {};
    for (const [id, detail] of detailsEntries) issueDetails[id] = detail;
  }

  // WorkshopNeeds нужны только для UI-селекта в форме создания.
  // Для read-only карточки не грузим — экономим запрос.
  let workshopNeeds: WorkshopNeedListItemDto[] = [];
  if (canManage) {
    try {
      workshopNeeds = await getOrderWorkshopNeeds(orderId);
    } catch {
      workshopNeeds = [];
    }
  }

  const summary = buildSummary(items);

  return (
    <AdminCard>
      <AdminSectionHeader
        icon={<PackageCheck size={18} strokeWidth={1.7} aria-hidden />}
        title="Фактический расход материалов"
        hint={summary.total > 0 ? `${summary.total}` : undefined}
        actions={
          canManage ? (
            <CreateMaterialIssueButton
              orderId={orderId}
              workshopNeeds={workshopNeeds}
              passports={passports}
            />
          ) : undefined
        }
      />

      {loadError && (
        <div className="error-box" role="alert" style={{ marginBottom: 8 }}>
          {loadError}
        </div>
      )}

      {items.length === 0 ? (
        <AdminEmptyState
          icon={<PackageCheck size={26} strokeWidth={1.6} aria-hidden />}
          title="Фактический расход материалов по заказу пока не зафиксирован."
          hint={
            canManage
              ? 'Нажмите «Создать расход», чтобы сделать первый черновик документа.'
              : 'Документы расхода создают начальник цеха или администратор.'
          }
        />
      ) : (
        <>
          <div
            className="material-issues-summary"
            data-testid="material-issues-summary"
            style={{
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              margin: '4px 0 10px',
              fontSize: '0.85rem',
            }}
          >
            <span className="admin-muted">Всего: {summary.total}</span>
            <span className="admin-muted">
              Черновик: {summary.byStatus.DRAFT}
            </span>
            <span className="admin-muted">
              Проведено: {summary.byStatus.POSTED}
            </span>
            <span className="admin-muted">
              Отменено: {summary.byStatus.CANCELLED}
            </span>
            <span>
              Сумма проведённых: <strong>{formatRubSum(summary.postedTotal)}</strong>
            </span>
          </div>
          <MaterialIssuesTable
            orderId={orderId}
            items={items}
            issueDetails={issueDetails}
            canManage={canManage}
          />
        </>
      )}
    </AdminCard>
  );
}
