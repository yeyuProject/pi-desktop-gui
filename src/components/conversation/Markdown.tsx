import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText, Copy, Check, WrapText } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type Message } from '../../../shared/types';
import { Lightbox } from '../Lightbox';
import { tokenizeCode } from '../../lib/code-tokens';
import { splitUserContent } from '../../lib/message-content';
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
  if (!streaming) {
    previous.current = undefined;
    return <MarkdownBlock text={text} />;
  }
  const parts = streamingMarkdown(text, previous.current);
  previous.current = parts;
  return (
    <>
      {parts.blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} />
      ))}
      {parts.plain ? (
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
export function UserMessage({ text, match }: { text: string; match?: SessionMatch }) {
  const parsed = useMemo(() => splitUserContent(text), [text]);
  return (
    <>
      <RichText text={parsed.text} />
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
