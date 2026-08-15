import Link from 'next/link';
import { ArrowRight, BookOpen, Plus } from 'lucide-react';
import {
  KNOWLEDGE_AREA_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  isKnowledgeReviewOverdue,
  knowledgeReviewDueAt,
  type KnowledgeArticleDto,
  type KnowledgeListTab,
} from '@sewing/shared/knowledge';
import {
  AdminArchiveTabs,
  AdminCard,
  AdminEmptyState,
  AdminPageShell,
  AdminPagination,
  AdminSearchInput,
  AdminSectionHeader,
  AdminStatusBadge,
  AdminTable,
  BulkArchiveHeaderButton,
  BulkArchiveProvider,
  BulkArchiveRowActions,
  paginate,
  type AdminTableColumn,
} from '@/components/admin';
import { ApiRequestError, errorText } from '@/lib/api';
import { formatDateRu } from '@/lib/date-format';
import { listKnowledgeArticles } from '@/lib/knowledge-api';
import {
  archiveKnowledgeAction,
  purgeKnowledgeAction,
  restoreKnowledgeAction,
} from './archive-actions';
import { ConfirmReviewButton } from './confirm-review-button.client';

export const dynamic = 'force-dynamic';

interface SearchParams {
  page?: string;
  pageSize?: string;
  tab?: string;
  search?: string;
}

function resolveTab(raw: string | undefined): KnowledgeListTab {
  if (raw === 'archive') return 'archive';
  if (raw === 'drafts') return 'drafts';
  return 'active';
}

/**
 * Список статей базы знаний.
 *
 * Каркас — общий для админских списков (эталон `/admin/routes`): одна
 * `AdminCard`, внутри вкладки → поиск → «Активные · Всего: N» →
 * таблица. Отличие ровно одно: вкладок три, а не две — у статьи, кроме
 * «активна/архив», есть промежуточное состояние «черновик», и оно
 * должно быть видно, иначе ненаписанная до конца статья теряется.
 *
 * Счётчики вкладок требуют трёх запросов вместо одного: backend
 * фильтрует по статусу, а показать «Черновики (2)» надо, стоя на
 * активных. Статей десятки — три `findMany` дешевле, чем отдельная
 * ручка со счётчиками.
 */
export default async function AdminKnowledgeListPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const tab = resolveTab(searchParams?.tab);
  const search = searchParams?.search?.trim() || undefined;

  let published: KnowledgeArticleDto[] = [];
  let drafts: KnowledgeArticleDto[] = [];
  let archived: KnowledgeArticleDto[] = [];
  let error: string | null = null;
  try {
    [published, drafts, archived] = await Promise.all([
      listKnowledgeArticles({ tab: 'active', search }),
      listKnowledgeArticles({ tab: 'drafts', search }),
      listKnowledgeArticles({ tab: 'archive', search }),
    ]);
  } catch (e) {
    error =
      e instanceof ApiRequestError
        ? errorText(e)
        : 'Не удалось загрузить базу знаний';
  }

  const items =
    tab === 'archive' ? archived : tab === 'drafts' ? drafts : published;

  const overdueCount = published.filter((a) =>
    isKnowledgeReviewOverdue(a),
  ).length;

  const { page, pageSize, total, pageItems } = paginate(items, searchParams);

  const columns: AdminTableColumn<KnowledgeArticleDto>[] = [
    {
      key: 'title',
      header: 'Статья',
      render: (a) => (
        <div>
          <span className="admin-table__primary">{a.title}</span>
          {a.keywords.length > 0 && (
            <div className="admin-muted" style={{ fontSize: '0.8rem' }}>
              {a.keywords.join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'area',
      header: 'Область',
      render: (a) => KNOWLEDGE_AREA_LABELS[a.area],
    },
    {
      key: 'roles',
      header: 'Кто видит',
      render: (a) => (a.roles.length === 0 ? 'Все' : a.roles.join(', ')),
    },
    {
      key: 'views',
      header: 'Показов',
      align: 'right',
      render: (a) => a.viewCount,
    },
    {
      key: 'reviewed',
      header: 'Проверена',
      render: (a) => {
        const overdue = isKnowledgeReviewOverdue(a);
        const label = formatDateRu(a.reviewedAt ?? a.createdAt);
        if (!overdue) {
          return knowledgeReviewDueAt(a) === null ? (
            <span className="admin-muted">бессрочно</span>
          ) : (
            label
          );
        }
        // Просрочка — не ошибка данных, а приглашение к действию:
        // рядом с датой сразу кнопка «Актуально» в один клик.
        return (
          <div>
            <AdminStatusBadge tone="warning">{label}</AdminStatusBadge>
            <ConfirmReviewButton id={a.id} />
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Статус',
      render: (a) => (
        <AdminStatusBadge
          tone={
            a.status === 'PUBLISHED'
              ? 'success'
              : a.status === 'DRAFT'
                ? 'info'
                : 'muted'
          }
        >
          {KNOWLEDGE_STATUS_LABELS[a.status]}
        </AdminStatusBadge>
      ),
    },
    {
      key: 'archive',
      header: '',
      isAction: true,
      render: (a) => <BulkArchiveRowActions id={a.id} />,
    },
    {
      key: 'open',
      header: '',
      isAction: true,
      render: (a) => (
        <Link
          href={`/admin/knowledge/${a.id}`}
          className="admin-table__action-link"
        >
          Открыть
          <ArrowRight size={14} strokeWidth={1.6} aria-hidden />
        </Link>
      ),
    },
  ];

  const sectionTitle =
    tab === 'archive' ? 'Архив' : tab === 'drafts' ? 'Черновики' : 'Активные';

  return (
    <AdminPageShell
      icon={<BookOpen size={22} strokeWidth={1.6} aria-hidden />}
      title="База знаний"
      subtitle={`Опубликовано: ${published.length} · Черновиков: ${drafts.length} · Архив: ${archived.length}`}
      actions={
        <Link
          href="/admin/knowledge/new"
          className="admin-btn admin-btn--primary"
        >
          <Plus size={16} strokeWidth={1.6} aria-hidden />
          Статья
        </Link>
      }
    >
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <AdminCard>
        <AdminArchiveTabs
          basePath="/admin/knowledge"
          tab={tab}
          activeCount={published.length}
          archiveCount={archived.length}
          extraTabs={[
            { key: 'drafts', label: 'Черновики', count: drafts.length },
          ]}
          preserveParams={{ search }}
        />

        <form method="get" className="admin-form-grid" role="search">
          {tab !== 'active' && <input type="hidden" name="tab" value={tab} />}
          <AdminSearchInput
            id="knowledge-search"
            placeholder="Заголовок, текст или ключевое слово"
            initial={search ?? ''}
            basePath="/admin/knowledge"
            preserveParams={{ tab: tab === 'active' ? undefined : tab }}
          />
        </form>

        <BulkArchiveProvider
          mode={tab === 'archive' ? 'archive' : 'active'}
          allIds={items.map((a) => a.id)}
          actions={{
            archive: archiveKnowledgeAction,
            restore: restoreKnowledgeAction,
            purge: purgeKnowledgeAction,
          }}
          labels={{
            one: 'статью',
            many: 'статей',
            archiveHint:
              'Статья пропадёт из справки сотрудников и перестанет цитироваться ассистентом. Текст сохранится — вернуть можно из архива.',
            purgeHint:
              'Текст статьи будет стёрт безвозвратно вместе с историей её показов.',
          }}
        >
          <AdminSectionHeader
            title={sectionTitle}
            hint={
              tab === 'archive'
                ? `В архиве: ${items.length}. Удаление навсегда — только отсюда.`
                : tab === 'drafts'
                  ? `Всего: ${items.length}. Черновики не видны сотрудникам и ассистенту.`
                  : overdueCount > 0
                    ? `Всего: ${items.length} · не проверяли больше срока: ${overdueCount}`
                    : `Всего: ${items.length}`
            }
            actions={<BulkArchiveHeaderButton />}
          />

          <AdminTable
            rows={pageItems}
            columns={columns}
            rowKey={(a) => a.id}
            rowHref={(a) => `/admin/knowledge/${a.id}`}
            emptyContent={
              search ? (
                <AdminEmptyState
                  icon={<BookOpen size={26} strokeWidth={1.6} aria-hidden />}
                  title="Ничего не нашлось"
                  hint="По этому запросу статей нет. Измените запрос или очистите поиск."
                />
              ) : tab === 'archive' ? (
                <AdminEmptyState
                  icon={<BookOpen size={26} strokeWidth={1.6} aria-hidden />}
                  title="Архив пуст"
                  hint="Сюда попадают статьи, снятые со справки. Из архива их можно вернуть в черновики или удалить навсегда."
                />
              ) : tab === 'drafts' ? (
                <AdminEmptyState
                  icon={<BookOpen size={26} strokeWidth={1.6} aria-hidden />}
                  title="Черновиков нет"
                  hint="Черновик — это статья, которую ещё не показали цеху. Ничего не висит — значит, всё дописано."
                />
              ) : (
                <AdminEmptyState
                  icon={<BookOpen size={26} strokeWidth={1.6} aria-hidden />}
                  title="В базе знаний пока пусто"
                  hint="Первые статьи пишет человек: как оформить брак, кому звонить при поломке, куда девать остаток рулона. Начните с вопроса, который цех задаёт чаще всего."
                  actions={
                    <Link
                      href="/admin/knowledge/new"
                      className="admin-btn admin-btn--primary"
                    >
                      <Plus size={16} strokeWidth={1.6} aria-hidden />
                      Первая статья
                    </Link>
                  }
                />
              )
            }
          />
        </BulkArchiveProvider>

        <AdminPagination
          page={page}
          pageSize={pageSize}
          total={total}
          basePath="/admin/knowledge"
          preserveParams={{
            tab: tab === 'active' ? undefined : tab,
            search,
          }}
          label="статей"
        />
      </AdminCard>
    </AdminPageShell>
  );
}
