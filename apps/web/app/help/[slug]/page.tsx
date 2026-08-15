import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { KNOWLEDGE_AREA_LABELS } from '@sewing/shared/knowledge';
import { HelpArticleBody } from '@/components/help/article-body';
import { ApiRequestError } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { formatDateRu } from '@/lib/date-format';
import { fetchHelpArticle } from '@/lib/help-api';
import { HelpFeedbackButtons } from '../feedback-buttons.client';

export const dynamic = 'force-dynamic';

/**
 * Статья справки по человекочитаемому адресу.
 *
 * Отдельная страница, а не модалка внутри `/help`: на статью ссылаются
 * из закладок и (дальше) из ответа ассистента, и такая ссылка должна
 * открываться сама по себе.
 *
 * `?q=` протаскивается из поиска, чтобы отзыв «это не то» сохранил, ЧТО
 * искали, — именно эта пара подсказывает автору недостающее слово.
 */
export default async function HelpArticlePage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { q?: string };
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect(`/login?next=/help/${params.slug}`);

  const article = await fetchHelpArticle(params.slug).catch((e) => {
    // Невидимая статья и несуществующая для сотрудника одинаковы —
    // backend отдаёт 404 в обоих случаях, чтобы 403 не подсказывал
    // «что-то про зарплату здесь есть, просто вам нельзя».
    if (e instanceof ApiRequestError && e.statusCode === 404) return null;
    throw e;
  });
  if (!article) notFound();

  const q = searchParams?.q?.trim() || undefined;

  return (
    <main className="help">
      <Link
        href={q ? `/help?q=${encodeURIComponent(q)}` : '/help'}
        className="help__back"
      >
        <ArrowLeft size={16} strokeWidth={1.6} aria-hidden />
        Справка
      </Link>

      <article className="help-article">
        <h1 className="help-article__title">{article.title}</h1>
        <p className="help-article__meta">
          {KNOWLEDGE_AREA_LABELS[article.area]}
          {article.reviewedAt
            ? ` · проверено ${formatDateRu(article.reviewedAt)}`
            : ''}
          {article.authorName ? ` · ${article.authorName}` : ''}
        </p>
        <HelpArticleBody body={article.body} />
        <HelpFeedbackButtons slug={article.slug} query={q} />
      </article>
    </main>
  );
}
