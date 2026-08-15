import type { ReactNode } from 'react';

/**
 * Рендер текста статьи.
 *
 * Свой мини-парсер, а не библиотека markdown, по трём причинам:
 *
 *   1. Мастер пишет абзацами, списками и изредка жирным — полный
 *      markdown ему негде применить, а зависимость пришлось бы тянуть
 *      в образ и обновлять.
 *   2. Никакого сырого HTML: текст статьи пишет человек из админки, и
 *      библиотека, умеющая инлайнить HTML, дала бы XSS через справку —
 *      здесь этого нельзя в принципе.
 *   3. Ошибка разметки не должна ломать экран у машины: всё, что
 *      парсер не понял, показывается как обычный абзац.
 *
 * Поддерживается: `## Заголовок`, нумерованные и маркированные списки,
 * `**жирный**`, `` `код` ``, пустая строка как разделитель абзацев.
 */
export function HelpArticleBody({ body }: { body: string }) {
  return <div className="help-article__body">{renderBlocks(body)}</div>;
}

function renderBlocks(body: string): ReactNode[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(<p key={`p${out.length}`}>{renderInline(paragraph.join(' '))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={i}>{renderInline(item)}</li>
    ));
    out.push(
      list.ordered ? (
        <ol key={`l${out.length}`}>{items}</ol>
      ) : (
        <ul key={`l${out.length}`}>{items}</ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      // Заголовок статьи уже нарисован страницей, поэтому внутренние
      // начинаются с h3 — иначе в документе было бы два h1.
      out.push(<h3 key={`h${out.length}`}>{renderInline(heading[2])}</h3>);
      continue;
    }

    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const text = (ordered ? ordered[2] : bullet![1]).trim();
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push(text);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out;
}

/**
 * Инлайн-разметка. Регулярка режет строку на куски, а не подставляет
 * HTML: результат — массив React-узлов, поэтому вставить теги через
 * текст статьи физически нельзя.
 */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={m.index}>{token.slice(1, -1)}</code>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
