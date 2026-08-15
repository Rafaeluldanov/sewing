import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Search } from 'lucide-react';
import {
  KNOWLEDGE_AREA_LABELS,
  type HelpSearchResultDto,
} from '@sewing/shared/knowledge';
import { HelpArticleBody } from '@/components/help/article-body';
import { ApiRequestError, errorText } from '@/lib/api';
import { getCurrentUserOrNull } from '@/lib/auth-api';
import { formatDateRu } from '@/lib/date-format';
import { fetchHelp } from '@/lib/help-api';
import { HelpFeedbackButtons } from './feedback-buttons.client';

export const dynamic = 'force-dynamic';

/**
 * Окно «Справка» — единственный вход для сотрудника с вопросом.
 *
 * Одно поле ввода, за которым несколько уровней ответа: сейчас это
 * поиск по базе знаний, дальше сюда встанет ассистент. Поэтому окно
 * называется «Справка», а не «Ассистент», и живёт отдельной страницей,
 * доступной любой роли: у швеи админки нет, а вопросы у неё те же, что
 * у мастера.
 *
 * Если у поиска есть явный лидер, статья открывается сразу — сотрудник
 * у машины не должен выбирать из пяти ссылок, по которым ещё надо
 * кликать.
 */
export default async function HelpPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const me = await getCurrentUserOrNull();
  if (!me) redirect('/login?next=/help');

  const q = searchParams?.q?.trim() || undefined;

  let result: HelpSearchResultDto = { exact: null, others: [] };
  let error: string | null = null;
  try {
    result = await fetchHelp(q);
  } catch (e) {
    error =
      e instanceof ApiRequestError ? errorText(e) : 'Справка сейчас недоступна';
  }

  const nothingFound =
    q !== undefined && !result.exact && result.others.length === 0;

  return (
    <main className="help">
      <header className="help__head">
        <h1 className="help__title">Справка</h1>
        <p className="help__hint">
          Как принято в цеху: порядок работы, к кому идти, что делать в
          нештатной ситуации.
        </p>
      </header>

      <form className="help__search" method="get" role="search">
        <Search size={18} strokeWidth={1.6} aria-hidden />
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Спросите или найдите…"
          aria-label="Поиск по справке"
          autoComplete="off"
        />
        <button type="submit" className="help__search-btn">
          Найти
        </button>
      </form>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {result.exact && (
        <article className="help-article">
          <h2 className="help-article__title">{result.exact.title}</h2>
          <p className="help-article__meta">
            {KNOWLEDGE_AREA_LABELS[result.exact.area]}
            {result.exact.reviewedAt
              ? ` · проверено ${formatDateRu(result.exact.reviewedAt)}`
              : ''}
            {result.exact.authorName ? ` · ${result.exact.authorName}` : ''}
          </p>
          <HelpArticleBody body={result.exact.body} />
          <HelpFeedbackButtons slug={result.exact.slug} query={q} />
        </article>
      )}

      {result.others.length > 0 && (
        <section className="help__list">
          <h2 className="help__list-title">
            {result.exact
              ? 'Ещё по этому вопросу'
              : q
                ? 'Что нашлось'
                : 'Спрашивают чаще всего'}
          </h2>
          {result.others.map((item) => (
            <Link
              key={item.slug}
              href={`/help/${item.slug}${q ? `?q=${encodeURIComponent(q)}` : ''}`}
              className="help-item"
            >
              <b className="help-item__title">{item.title}</b>
              <span className="help-item__snippet">{item.snippet}</span>
              <span className="help-item__area">
                {KNOWLEDGE_AREA_LABELS[item.area]}
              </span>
            </Link>
          ))}
        </section>
      )}

      {nothingFound && (
        <div className="help__empty">
          <p>
            В справке такого пока нет. Спросите мастера — он заведёт статью, и в
            следующий раз ответ будет здесь.
          </p>
        </div>
      )}

      {!q && result.others.length === 0 && !error && (
        <div className="help__empty">
          <p>
            Справка пока пустая. Её пишет мастер: как оформить брак, кому
            звонить при поломке, что делать в нештатной ситуации.
          </p>
        </div>
      )}
    </main>
  );
}
