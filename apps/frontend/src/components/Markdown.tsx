import { Fragment, ReactNode } from "react";

/** **bold**, rendered as elements rather than HTML, so nothing in a model's text can inject markup. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((piece, index) =>
    piece.startsWith("**") && piece.endsWith("**") && piece.length > 4 ? (
      <strong key={index}>{piece.slice(2, -2)}</strong>
    ) : (
      <Fragment key={index}>{piece}</Fragment>
    )
  );
}

/**
 * The little markdown the assistant is told to use: paragraphs, bullet and
 * numbered lists, bold, and headings shown as bold lines. Anything else
 * comes through as plain text. Shared by Ask and the AI cards on Home.
 */
export function Markdown({ text, className = "ask-answer" }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const open: { list: { ordered: boolean; items: string[] } | null } = { list: null };

  const flush = () => {
    const list = open.list;
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    open.list = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (open.list && open.list.ordered !== ordered) flush();
      open.list ??= { ordered, items: [] };
      open.list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    flush();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={blocks.length}>
          <strong>{heading[1]}</strong>
        </p>
      ) : (
        <p key={blocks.length}>{inline(line)}</p>
      )
    );
  }
  flush();

  return <div className={className}>{blocks}</div>;
}
