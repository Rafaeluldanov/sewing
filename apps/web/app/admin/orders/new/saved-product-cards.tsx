'use client';

/**
 * Карточки-резюме изделия, созданного прямо из формы заказа.
 *
 * Две штуки, обе показываются в блоке «Изделие» после того, как
 * менеджер закрыл модалку «Создать изделие»:
 *
 *   - `SavedInlineProductCard` — изделие сохранено ЛОКАЛЬНО (в state
 *     формы). Backend в БД ещё ничего не писал; данные уедут вместе с
 *     созданием заказа как `productMode = CREATE_FOR_CALCULATION`;
 *   - `SavedConstructorTaskCard` — заявка в КБ уже создана в БД
 *     (DRAFT-`PatternItem` + `ConstructorTask`), поэтому «Редактировать»
 *     тут нет: только «Открепить от заказа».
 *
 * Модуль отдельный, потому что карточки нужны двум независимым
 * поверхностям — мастеру создания (`order-create-wizard.tsx`) и форме
 * правки (`/admin/orders/[id]/edit`). Раньше они жили внутри формы
 * создания, и форма правки импортировала их оттуда: клиентский
 * компонент на 2000 строк затягивался в модульный граф соседней
 * страницы ради двух карточек.
 *
 * `hint` параметризован намеренно: текст «что будет дальше» зависит от
 * поверхности (в мастере следующий шаг — кнопка «Далее», в форме
 * правки — «Сохранить»), а сама карточка одна и та же.
 *
 * Backend / DTO / Prisma не задействованы — это presentation-слой.
 */

import type {
  SavedConstructorDraftPayload,
  SavedInlineProductPayload,
} from './create-product-inline';

export function SavedInlineProductCard({
  payload,
  onEdit,
  onSendToConstructor,
  onDelete,
  hint,
}: {
  payload: SavedInlineProductPayload;
  onEdit: () => void;
  /**
   * Этап «Отправить изделие конструктору»: открывает модалку сразу на
   * вкладке `constructor`, передавая текущий `payload` как
   * `initialValue`. Backend в server action-е использует его как
   * calc-payload для создания DRAFT-`PatternItem`.
   */
  onSendToConstructor: () => void;
  onDelete: () => void;
  /** Что произойдёт дальше — зависит от поверхности. */
  hint?: string;
}) {
  const totalQty = payload.sizes.reduce((s, r) => s + (r.qtyPlan ?? 0), 0);
  return (
    <div className="saved-product-card">
      <div className="saved-product-card__head">
        <strong className="saved-product-card__title">Изделие №1</strong>
        <div className="saved-product-card__actions">
          <button
            type="button"
            className="admin-btn admin-btn--ghost"
            onClick={onEdit}
          >
            Редактировать
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--primary"
            onClick={onSendToConstructor}
            title="Открыть форму отправки лекала на разработку конструктору"
          >
            Отправить конструктору
          </button>
          <button
            type="button"
            className="admin-btn admin-btn--ghost saved-product-card__danger"
            onClick={onDelete}
          >
            Удалить
          </button>
        </div>
      </div>
      <dl className="saved-product-card__list">
        <dt>Группа номенклатуры</dt>
        <dd>
          {payload.categoryName ?? (
            <span className="admin-muted">не указана</span>
          )}
        </dd>
        <dt>Размеры / тираж</dt>
        <dd>
          {payload.sizes.length === 0 ? (
            <span className="admin-muted">не заданы</span>
          ) : (
            <>
              {payload.sizes
                .map((s) => `${s.sizeCode}: ${s.qtyPlan}`)
                .join(', ')}{' '}
              <span className="admin-muted">
                (всего {totalQty.toLocaleString('ru-RU')} шт)
              </span>
            </>
          )}
        </dd>
        {payload.patternDevelopmentCostRub && (
          <>
            <dt>Стоимость разработки лекала</dt>
            <dd>
              {payload.patternDevelopmentCostRub} ₽
              <span className="admin-muted saved-product-card__note">
                {payload.patternDevelopmentCostInCostPrice
                  ? '· входит в себестоимость'
                  : '· не входит в себестоимость'}
              </span>
            </dd>
          </>
        )}
      </dl>
      <p className="admin-muted saved-product-card__hint">
        {hint ??
          'Изделие сохранено локально — backend создаст лекало и привяжет его к заказу.'}
      </p>
    </div>
  );
}

/**
 * Карточка-резюме «Заявка конструктору».
 *
 * В отличие от {@link SavedInlineProductCard} не предлагает
 * «Редактировать»: DRAFT-`PatternItem` уже создан в БД, и правка не
 * поддерживается в этой версии. Кнопка «Открепить от заказа» снимает
 * привязку, сама запись `ConstructorTask` остаётся — менеджер увидит
 * её в `/admin/constructor-tasks`.
 */
export function SavedConstructorTaskCard({
  task,
  onDelete,
  hint,
}: {
  task: SavedConstructorDraftPayload;
  onDelete: () => void;
  hint?: string;
}) {
  return (
    <div className="saved-product-card" data-testid="saved-constructor-task-card">
      <div className="saved-product-card__head">
        <strong className="saved-product-card__title">
          Заявка конструктору
        </strong>
        <div className="saved-product-card__actions">
          <button
            type="button"
            className="admin-btn admin-btn--ghost saved-product-card__danger"
            onClick={onDelete}
          >
            Открепить от заказа
          </button>
        </div>
      </div>
      <dl className="saved-product-card__list">
        <dt>Изделие</dt>
        <dd>
          {task.patternName}{' '}
          <span className="admin-muted">({task.patternArticle})</span>
        </dd>
        <dt>Размеров</dt>
        <dd>{task.sizeRowsCount}</dd>
        <dt>Файлов</dt>
        <dd>{task.filesCount}</dd>
        <dt>Статус</dt>
        <dd>Новая · ждёт конструктора</dd>
      </dl>
      <p className="admin-muted saved-product-card__hint">
        {hint ??
          'Лекало создано как черновик (DRAFT). Управление заявкой — в разделе «Заявки конструктору».'}
      </p>
    </div>
  );
}
