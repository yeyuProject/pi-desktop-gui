import { ChevronDown, Copy } from 'lucide-react';
import { askHistoryText, askSelectionText, askStatusLabels, type AskDetails } from '../../../shared/ask';
import { RichText } from './Markdown';
import { SearchHighlight } from './SearchHighlight';
import type { SessionMatch } from '../../lib/session-search';

export function AskCard({
  details,
  expanded,
  toggle,
  copy,
  match,
}: {
  details: AskDetails;
  expanded: boolean;
  toggle: (open: boolean) => void;
  copy: (text: string) => void;
  match?: SessionMatch;
}) {
  const highlight = (text: string) => <SearchHighlight text={text} query={match?.query} />;
  return (
    <details
      className="ask-card"
      open={expanded || Boolean(match)}
      onToggle={(event) => {
        if (!match) toggle(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="ask-card-heading">
          <ChevronDown className="ask-card-chevron" size={14} />
          <strong>Pi 提问</strong>
          <small>{askStatusLabels[details.status]}</small>
          <button
            className="icon-button"
            title="复制问答"
            aria-label="复制问答"
            onClick={(event) => {
              event.preventDefault();
              copy(askHistoryText(details));
            }}
          >
            <Copy size={14} />
          </button>
        </span>
        <ul className="ask-card-summary">
          {details.questions.map((question) => (
            <li key={question.id}>
              {highlight(question.header)}：{highlight(askSelectionText(details, question))}
            </li>
          ))}
        </ul>
      </summary>
      {details.questions.map((question) => {
        const answer =
          'answers' in details && Object.hasOwn(details.answers, question.id)
            ? details.answers[question.id]
            : undefined;
        return (
          <section className="ask-card-detail" key={question.id} aria-label={question.header}>
            <strong>{highlight(question.header)}</strong>
            {match ? <p>{highlight(question.question)}</p> : <RichText text={question.question} />}
            <ul>
              {question.options.map((option) => (
                <li
                  key={option.label}
                  className={answer?.selected.includes(option.label) ? 'selected' : undefined}
                >
                  {answer?.selected.includes(option.label) ? '✓ ' : ''}
                  {highlight(option.label)}
                  {option.recommended ? '（推荐）' : ''}
                  {option.description && <small>{option.description}</small>}
                </li>
              ))}
            </ul>
            {answer?.other !== undefined && <p>其他：{highlight(answer.other)}</p>}
            {!answer && <p>{askStatusLabels[details.status === 'answered' ? 'skipped' : details.status]}</p>}
          </section>
        );
      })}
      {'note' in details && details.note && <p>补充说明：{highlight(details.note)}</p>}
    </details>
  );
}
