'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { CheckCircle2, Save, Send, Undo2, XCircle } from 'lucide-react';
import {
  KNOWLEDGE_AREA_LABELS,
  KNOWLEDGE_AREAS,
  KNOWLEDGE_BODY_MAX_LENGTH,
  KNOWLEDGE_TITLE_MAX_LENGTH,
  type KnowledgeArticleDto,
} from '@sewing/shared/knowledge';
import {
  createKnowledgeArticleAction,
  updateKnowledgeArticleAction,
} from './actions';
import {
  initialCreateKnowledgeArticleState,
  initialUpdateKnowledgeArticleState,
  type CreateKnowledgeArticleState,
  type UpdateKnowledgeArticleState,
} from './form-state';

interface RoleOption {
  code: string;
  name: string;
}

export interface KnowledgeArticleFormProps {
  /** Статья для правки; отсутствует — форма создания. */
  article?: KnowledgeArticleDto;
  /** Справочник ролей тенанта для галочек «Кто видит». */
  roles: RoleOption[];
}

function SubmitButton({
  intent,
  label,
  pendingLabel,
  primary,
  icon,
}: {
  intent: string;
  label: string;
  pendingLabel: string;
  primary?: boolean;
  icon: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="intent"
      value={intent}
      className={`admin-btn ${primary ? 'admin-btn--primary' : ''}`}
      disabled={pending}
    >
      {icon}
      {pending ? pendingLabel : label}
    </button>
  );
}

/**
 * Форма статьи базы знаний — одна на создание и правку.
 *
 * Две вещи, которые здесь сознательно сделаны именно так:
 *
 *   1. ТЕКСТ — обычная `textarea` с markdown, без WYSIWYG. Статью
 *      пишет мастер, а не редактор; разметки уровня «список + жирный»
 *      достаточно, а редактор пришлось бы поддерживать.
 *   2. ПУБЛИКАЦИЯ — отдельная кнопка, а не галочка «опубликовано».
 *      Публикация статьи это ДЕЙСТВИЕ («я прочитал и согласен
 *      показать это цеху»), и от него отсчитывается срок годности.
 */
export function KnowledgeArticleForm({
  article,
  roles,
}: KnowledgeArticleFormProps) {
  const isEdit = article !== undefined;

  const [createState, createAction] = useFormState<
    CreateKnowledgeArticleState,
    FormData
  >(createKnowledgeArticleAction, initialCreateKnowledgeArticleState);
  const [updateState, updateAction] = useFormState<
    UpdateKnowledgeArticleState,
    FormData
  >(updateKnowledgeArticleAction, initialUpdateKnowledgeArticleState);

  const state = isEdit ? updateState : createState;

  return (
    <form action={isEdit ? updateAction : createAction} className="admin-form">
      {isEdit && <input type="hidden" name="id" value={article.id} />}
      {/* Маркеры «поле было в форме»: без них снятая последняя галочка
          неотличима от «поле не редактировали». */}
      {isEdit && <input type="hidden" name="rolesPresent" value="1" />}
      {isEdit && <input type="hidden" name="assistantOkPresent" value="1" />}

      {state.error && (
        <div className="error-box" role="alert">
          <XCircle size={16} strokeWidth={1.6} aria-hidden /> {state.error}
          {state.errorRequestId ? ` (${state.errorRequestId})` : ''}
        </div>
      )}
      {state.ok && state.successMessage && (
        <div className="success-box" role="status">
          <CheckCircle2 size={16} strokeWidth={1.6} aria-hidden />{' '}
          {state.successMessage}
        </div>
      )}

      <div className="admin-field">
        <label htmlFor="knowledge-title">Заголовок</label>
        <input
          id="knowledge-title"
          name="title"
          type="text"
          required
          maxLength={KNOWLEDGE_TITLE_MAX_LENGTH}
          defaultValue={article?.title ?? ''}
          placeholder="Например: Что делать, если рулон закончился посреди настила"
        />
        <p className="admin-field__hint">
          Заголовок — это вопрос сотрудника его словами. «Остатки ткани» ищется
          хуже, чем «Куда девать остаток рулона после раскроя».
        </p>
      </div>

      <div className="admin-field">
        <label htmlFor="knowledge-body">Текст статьи</label>
        <textarea
          id="knowledge-body"
          name="body"
          required
          rows={14}
          maxLength={KNOWLEDGE_BODY_MAX_LENGTH}
          defaultValue={article?.body ?? ''}
          placeholder={'Коротко и по шагам.\n\n1. …\n2. …'}
        />
        <p className="admin-field__hint">
          Markdown. Одна статья — один вопрос: длинную лучше разрезать, поиск
          точнее попадает.
        </p>
      </div>

      <div className="admin-form-grid">
        <div className="admin-field">
          <label htmlFor="knowledge-area">Область</label>
          <select
            id="knowledge-area"
            name="area"
            defaultValue={article?.area ?? 'GENERAL'}
          >
            {KNOWLEDGE_AREAS.map((area) => (
              <option key={area} value={area}>
                {KNOWLEDGE_AREA_LABELS[area]}
              </option>
            ))}
          </select>
          <p className="admin-field__hint">
            Область — единица доступа: она же режет выдачу ассистента.
          </p>
        </div>

        <div className="admin-field">
          <label htmlFor="knowledge-review">Перепроверить через</label>
          <select
            id="knowledge-review"
            name="reviewEveryMonths"
            defaultValue={
              article?.reviewEveryMonths === null
                ? ''
                : String(article?.reviewEveryMonths ?? 6)
            }
          >
            <option value="3">3 месяца</option>
            <option value="6">6 месяцев</option>
            <option value="12">год</option>
            <option value="">бессрочно</option>
          </select>
          <p className="admin-field__hint">
            Дальше статья подсвечивается в списке как просроченная.
          </p>
        </div>

        <div className="admin-field">
          <label htmlFor="knowledge-keywords">Ключевые слова</label>
          <input
            id="knowledge-keywords"
            name="keywords"
            type="text"
            defaultValue={article?.keywords.join(', ') ?? ''}
            placeholder="рулон, настил, остаток"
          />
          <p className="admin-field__hint">
            Через запятую. Нужны для жаргона, которого нет в тексте («ткань
            пришла») — по самому тексту поиск и так идёт.
          </p>
        </div>
      </div>

      <div className="admin-field">
        <label htmlFor="knowledge-roles-hint">Кто видит</label>
        <p id="knowledge-roles-hint" className="admin-field__hint">
          Ничего не отмечено — статью видят все, у кого открыта её область.
        </p>
      </div>
      <div className="admin-form-grid">
        {roles.map((role) => (
          <div key={role.code} className="admin-field admin-field--inline">
            <input
              id={`knowledge-role-${role.code}`}
              type="checkbox"
              name="roles"
              value={role.code}
              defaultChecked={article?.roles.includes(role.code) ?? false}
            />
            <label htmlFor={`knowledge-role-${role.code}`}>{role.name}</label>
          </div>
        ))}
      </div>

      <div className="admin-field admin-field--inline">
        <input
          id="knowledge-assistant-ok"
          type="checkbox"
          name="assistantOk"
          defaultChecked={article?.assistantOk ?? true}
        />
        <label htmlFor="knowledge-assistant-ok">
          Ассистенту можно цитировать эту статью
        </label>
      </div>
      <p className="admin-field__hint">
        Снимите для внутренних регламентов, которые человек читает сам, а
        пересказывать их нельзя.
      </p>

      <div className="admin-actions-row">
        {isEdit ? (
          <>
            <SubmitButton
              intent="save"
              label="Сохранить"
              pendingLabel="Сохраняем…"
              icon={<Save size={16} strokeWidth={1.6} aria-hidden />}
            />
            {article.status === 'PUBLISHED' ? (
              <SubmitButton
                intent="unpublish"
                label="Снять с публикации"
                pendingLabel="Снимаем…"
                icon={<Undo2 size={16} strokeWidth={1.6} aria-hidden />}
              />
            ) : (
              <SubmitButton
                intent="publish"
                label="Опубликовать"
                pendingLabel="Публикуем…"
                primary
                icon={<Send size={16} strokeWidth={1.6} aria-hidden />}
              />
            )}
          </>
        ) : (
          <>
            <SubmitButton
              intent="publish"
              label="Опубликовать"
              pendingLabel="Публикуем…"
              primary
              icon={<Send size={16} strokeWidth={1.6} aria-hidden />}
            />
            <SubmitButton
              intent="draft"
              label="Сохранить черновик"
              pendingLabel="Сохраняем…"
              icon={<Save size={16} strokeWidth={1.6} aria-hidden />}
            />
          </>
        )}
      </div>
    </form>
  );
}
