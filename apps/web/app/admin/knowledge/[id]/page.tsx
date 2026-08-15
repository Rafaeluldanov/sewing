import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, BookOpen } from 'lucide-react';
import {
  KNOWLEDGE_AREA_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  isKnowledgeReviewOverdue,
  knowledgeReviewDueAt,
} from '@sewing/shared/knowledge';
import {
  AdminCard,
  AdminPageShell,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTechInfo,
} from '@/components/admin';
import { ApiRequestError } from '@/lib/api';
import { listAppRolesSafe } from '@/lib/app-roles-api';
import { formatDateRu } from '@/lib/date-format';
import { getKnowledgeArticle } from '@/lib/knowledge-api';
import { KnowledgeArticleForm } from '../article-form.client';

export const dynamic = 'force-dynamic';

/**
 * Карточка статьи базы знаний: редактор плюс то, по чему потом решают,
 * жива она ещё или пора переписать — кто автор, когда проверяли,
 * сколько раз показали.
 */
export default async function KnowledgeArticlePage({
  params,
}: {
  params: { id: string };
}) {
  const [article, roles] = await Promise.all([
    getKnowledgeArticle(params.id).catch((e) => {
      if (e instanceof ApiRequestError && e.statusCode === 404) return null;
      throw e;
    }),
    listAppRolesSafe(),
  ]);
  if (!article) notFound();

  const overdue = isKnowledgeReviewOverdue(article);
  const dueAt = knowledgeReviewDueAt(article);

  return (
    <AdminPageShell
      icon={<BookOpen size={22} strokeWidth={1.6} aria-hidden />}
      title={article.title}
      subtitle={`${KNOWLEDGE_AREA_LABELS[article.area]} · ${KNOWLEDGE_STATUS_LABELS[article.status]}`}
      actions={
        <Link href="/admin/knowledge" className="admin-btn">
          <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />К списку
        </Link>
      }
    >
      <AdminCard>
        <AdminSectionHeader
          title="Текст статьи"
          hint={
            article.status === 'PUBLISHED'
              ? 'Опубликована: её видят сотрудники и цитирует ассистент.'
              : article.status === 'DRAFT'
                ? 'Черновик: сотрудникам и ассистенту не видна.'
                : 'В архиве: не видна никому, текст сохранён.'
          }
        />
        <KnowledgeArticleForm
          article={article}
          roles={roles.map((r) => ({ code: r.code, name: r.name }))}
        />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader
          title="Как живёт статья"
          hint="По этим числам видно, читают её или она мертва"
        />
        <div className="admin-form-grid">
          <div className="admin-field">
            <label>Показов</label>
            <span>{article.viewCount}</span>
          </div>
          <div className="admin-field">
            <label>Проверена</label>
            <span>
              {article.reviewedAt ? (
                overdue ? (
                  <AdminStatusBadge tone="warning">
                    {formatDateRu(article.reviewedAt)} — пора перечитать
                  </AdminStatusBadge>
                ) : (
                  formatDateRu(article.reviewedAt)
                )
              ) : (
                '—'
              )}
            </span>
          </div>
          <div className="admin-field">
            <label>Следующая проверка</label>
            <span>{dueAt ? formatDateRu(dueAt) : 'бессрочно'}</span>
          </div>
          <div className="admin-field">
            <label>Автор</label>
            <span>{article.authorName ?? '—'}</span>
          </div>
          <div className="admin-field">
            <label>Последняя правка</label>
            <span>
              {formatDateRu(article.updatedAt)}
              {article.updatedByName ? ` · ${article.updatedByName}` : ''}
            </span>
          </div>
        </div>
      </AdminCard>

      <AdminTechInfo
        items={[
          { label: 'ID', value: article.id },
          { label: 'Адрес статьи', value: article.slug },
          { label: 'Создана', value: formatDateRu(article.createdAt) },
          {
            label: 'Ассистент',
            value: article.assistantOk ? 'может цитировать' : 'не цитирует',
          },
        ]}
      />
    </AdminPageShell>
  );
}
