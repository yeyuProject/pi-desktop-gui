import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText, Copy, Check, WrapText, BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type Message } from '../../../shared/types';
import { Lightbox } from '../Lightbox';
import { tokenizeCode } from '../../lib/code-tokens';
import { parseUserMessage, quoteLabel, type DraftQuote } from '../../lib/message-content';
import { SearchHighlight } from './SearchHighlight';
import type { SessionMatch } from '../../lib/session-search';
import { streamingMarkdown, type MarkdownParts } from '../../lib/streaming-markdown';
const api = window.desktop;
function codeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? codeText(child.props.children)
          : '',
    )
    .join('');
}
export function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false),
    [wrap, setWrap] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const code = codeText(children);
  const child = Children.toArray(children)[0];
  const language = isValidElement<{ className?: string }>(child)
    ? (/language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '')
    : '';
  const tokens = useMemo(() => tokenizeCode(code, language), [code, language]);
  const lines = code.replace(/\n$/, '').split('\n').length;
  return (
    <div className={'code-block' + (wrap ? ' code-wrap' : '')}>
      <div className="code-header">
        <span>
          {language || '文本'} · {lines} 行
        </span>
        <div>
          <button aria-label="自动换行" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>
            <WrapText size={13} />
            换行
          </button>
          <button
            className="code-copy"
            aria-label="复制代码"
            onClick={() =>
              void api.invoke('copy', code).then(() => {
                setCopied(true);
                clearTimeout(timer.current);
                timer.current = setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>
      <pre>
        <code className={language ? 'language-' + language : undefined}>
          {tokens.map((token, i) =>
            token.kind ? (
              <span className={'syntax-' + token.kind} key={i}>
                {token.text}
              </span>
            ) : (
              token.text
            ),
          )}
        </code>
      </pre>
    </div>
  );
}
export const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <button className="inline-link" onClick={() => href && void api.invoke('openLink', href).catch(() => {})}>
      {children}
    </button>
  ),
  pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock>,
  img: ({ src, alt }: { src?: string; alt?: string }) => <MarkdownImage src={src} alt={alt} />,
};
export const remarkPlugins = [remarkGfm];
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={remarkPlugins} skipHtml components={markdownComponents}>
      {text}
    </Markdown>
  );
});
export const RichText = memo(function RichText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const previous = useRef<MarkdownParts | undefined>(undefined);
  if (!streaming && !previous.current) return <MarkdownBlock text={text} />;
  const parts =
    previous.current?.source === text ? previous.current : streamingMarkdown(text, previous.current);
  previous.current = parts;
  return (
    <>
      {parts.blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} />
      ))}
      {streaming && parts.plain ? (
        <div className="streaming-markdown-text">{parts.tail}</div>
      ) : (
        <MarkdownBlock text={parts.tail} />
      )}
    </>
  );
});
export function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [loaded, setLoaded] = useState(false),
    [open, setOpen] = useState(false);
  if (src && (/^data:image\/(png|jpeg|gif|webp);base64,/.test(src) || (/^https?:\/\//.test(src) && loaded)))
    return (
      <>
        <button className="image-preview" onClick={() => setOpen(true)}>
          <img className="message-image" src={src} alt={alt || '图片'} />
        </button>
        {open && <Lightbox images={[{ src, alt: alt || '图片' }]} close={() => setOpen(false)} />}
      </>
    );
  if (src && /^https?:\/\//.test(src))
    return <button onClick={() => setLoaded(true)}>加载图片：{alt || src}</button>;
  return <span className="muted">[图片：{alt || '附件'}]</span>;
}
export function MessageImages({ message }: { message: Message }) {
  const [index, setIndex] = useState<number | null>(null);
  const images =
    typeof message.content === 'string'
      ? []
      : message.content
          .filter(
            (b) =>
              b.type === 'image' &&
              typeof b.data === 'string' &&
              ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(b.mimeType)),
          )
          .map((b, i) => ({ src: `data:${b.mimeType};base64,${b.data}`, alt: `附件图片 ${i + 1}` }));
  if (!images.length) return null;
  return (
    <div className="message-images">
      {images.map((image, i) => (
        <button key={i} className="image-preview" onClick={() => setIndex(i)}>
          <img className="message-image" {...image} />
        </button>
      ))}
      {index !== null && <Lightbox images={images} initialIndex={index} close={() => setIndex(null)} />}
    </div>
  );
}
export function UserMessage({
  text,
  match,
  viewId,
  expanded,
  toggle,
  copy,
  quoteSources,
}: {
  text: string;
  match?: SessionMatch;
  viewId: number;
  expanded: string[];
  toggle: (id: string, open: boolean) => void;
  copy: (text: string) => void;
  quoteSources?: Set<string>;
}) {
  const parsed = useMemo(() => parseUserMessage(text), [text]);
  const skill = parsed.skill;
  const body = parsed.text || (skill ? `使用技能 ${skill.name}` : '');
  const lines = useMemo(() => body.split(/\r?\n/).length, [body]);
  const long = lines > 12 || body.length > 1200;
  const skillId = `skill:${viewId}`,
    promptId = `prompt:${viewId}`;
  const skillOpen = expanded.includes(skillId) || match?.section === 'skill';
  const promptOpen = expanded.includes(promptId) || match?.section === 'text';
  useEffect(() => {
    if (skill && match?.section === 'skill' && !expanded.includes(skillId)) toggle(skillId, true);
    if (long && match?.section === 'text' && !expanded.includes(promptId)) toggle(promptId, true);
  }, [match, skill, long, expanded, skillId, promptId, toggle]);
  return (
    <>
      {skill && (
        <div className="message-attachment message-skill">
          <button
            className="skill-toggle"
            aria-expanded={skillOpen}
            title={skill.location}
            onClick={() => toggle(skillId, !skillOpen)}
          >
            {skillOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <BookOpen size={13} />
            技能 · {skill.name} · {skill.content.split(/\r?\n/).length} 行
          </button>
          {skillOpen && (
            <>
              <button className="skill-copy" onClick={() => copy(skill.content)}>
                <Copy size={13} />
                复制技能正文
              </button>
              <div className="skill-content" data-search-section="skill">
                <RichText text={skill.content} />
              </div>
            </>
          )}
        </div>
      )}
      {parsed.quotes.map((quote, index) => (
        <QuoteCard
          key={quote.id}
          quote={quote}
          available={quoteSources?.has(`${quote.role}:${quote.messageTimestamp}`) ?? false}
          match={match?.section === 'quote' && match.blockIndex === index ? match : undefined}
        />
      ))}
      <div
        className={`user-message-text${long && !promptOpen ? ' collapsed' : ''}`}
        data-search-section="text"
      >
        <RichText text={body} />
      </div>
      {long && (
        <button
          className="user-message-expand"
          aria-expanded={promptOpen}
          onClick={() => toggle(promptId, !promptOpen)}
        >
          {promptOpen ? '收起' : `展开全文（共 ${lines} 行）`}
        </button>
      )}
      {parsed.files.map((file, i) => (
        <details
          className="message-attachment"
          key={i}
          open={match?.section === 'attachment' && match.blockIndex === i ? true : undefined}
        >
          <summary>
            <FileText size={13} />
            {file.path}
            {file.lines && ` (L${file.lines.replace('-', '–L')})`}
            <span>查看引用内容</span>
          </summary>
          <pre>
            <SearchHighlight
              text={file.text}
              query={match?.blockIndex === i ? match.query : undefined}
              activeStart={match ? match.start - file.path.length - 1 : undefined}
            />
          </pre>
        </details>
      ))}
    </>
  );
}

export function QuoteCard({
  quote,
  available,
  match,
}: {
  quote: DraftQuote;
  available: boolean;
  match?: SessionMatch;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = quote.text.split(/\r?\n/).length > 4;
  const open = expanded || Boolean(match);
  return (
    <div className="message-quote" data-search-section="quote">
      <button
        className="quote-origin"
        disabled={!available}
        title={available ? '回到引用原文' : '原文已不在当前会话分支'}
        onClick={() => window.dispatchEvent(new CustomEvent('pi:quote', { detail: quote }))}
      >
        ❝ {quoteLabel(quote)}
        {quote.truncated ? '（已截断）' : ''}
      </button>
      <pre className={long && !open ? 'quote-text collapsed' : 'quote-text'}>
        <SearchHighlight text={quote.text} query={match?.query} activeStart={match?.start} />
      </pre>
      {long && (
        <button className="quote-expand" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {open ? '收起引用' : '展开引用'}
        </button>
      )}
    </div>
  );
}
