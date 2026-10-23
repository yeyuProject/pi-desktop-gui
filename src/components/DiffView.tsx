import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { alignHunk, hunkPrompt, parseDiffHunks, type DiffCell, type DiffHunk } from '../../shared/diff';
import '../styles/diff-view.css';

export interface DiffViewProps {
  patch: string;
  path?: string;
  before?: string;
  after?: string;
  split?: boolean;
  full?: boolean;
  className?: string;
  onAskHunk?: (attachment: string | undefined, prompt: string) => void;
}

function Cell({ cell, side }: { cell?: DiffCell; side: 'left' | 'right' }) {
  return (
    <div className={`diff-row ${cell?.kind ?? 'placeholder'}`}>
      <span className="diff-number">{cell?.line ?? ''}</span>
      <code>
        {cell?.segments
          ? cell.segments.map((part, i) => (
              <span
                key={i}
                className={part.changed ? `diff-word-${side === 'left' ? 'del' : 'add'}` : undefined}
              >
                {part.text}
              </span>
            ))
          : cell?.text || ' '}
      </code>
    </div>
  );
}

export const DiffView = memo(function DiffView({
  patch,
  path,
  before,
  after,
  split = false,
  full = false,
  className = '',
  onAskHunk,
}: DiffViewProps) {
  const request = useMemo(() => ({ patch, path, before, after, full }), [patch, path, before, after, full]);
  const background = full || patch.length > 16_000;
  type Aligned = { hunk: DiffHunk; rows: ReturnType<typeof alignHunk> }[];
  const [result, setResult] = useState<{ request: typeof request; aligned?: Aligned; error?: string }>();
  const immediate = useMemo(
    () => (background ? undefined : parseDiffHunks(patch).map((hunk) => ({ hunk, rows: alignHunk(hunk) }))),
    [background, patch],
  );
  useEffect(() => {
    if (!background) return;
    let active = true;
    const worker = new Worker(new URL('../lib/diff-worker.ts', import.meta.url), { type: 'module' });
    const finish = (value: { aligned?: Aligned; error?: string }) => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      worker.terminate();
      setResult({ request, ...value });
    };
    const timer = setTimeout(() => finish({ error: '差异计算耗时过长，请在编辑器中查看完整内容' }), 8000);
    worker.onmessage = (event) => finish(event.data);
    worker.onerror = () => finish({ error: '无法显示差异，请重试或在编辑器中查看' });
    worker.postMessage(request);
    return () => {
      active = false;
      clearTimeout(timer);
      worker.terminate();
    };
  }, [request, background]);
  const aligned = background ? (result?.request === request ? result.aligned : undefined) : immediate;
  const error = result?.request === request ? result.error : undefined;
  const left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null);
  const header = (hunk: DiffHunk, key: number, allowAsk = true) => (
    <div className="diff-hunk" key={`h-${key}`}>
      <code>{hunk.header}</code>
      {allowAsk && path && onAskHunk && (
        <button
          onClick={() => {
            const prompt = hunkPrompt(path, hunk);
            onAskHunk(prompt.attachment, prompt.text);
          }}
        >
          追问此段
        </button>
      )}
    </div>
  );
  if (error)
    return (
      <p className="empty-small" role="status">
        {error}
      </p>
    );
  if (!aligned)
    return (
      <p className="empty-small" role="status">
        加载差异…
      </p>
    );
  if (!aligned.length) return <pre className={`diff-view diff-raw ${className}`}>{patch}</pre>;
  if (split)
    return (
      <div className={`diff-view aligned-diff ${className}`}>
        {(['left', 'right'] as const).map((side) => (
          <div
            className="diff-pane"
            key={side}
            ref={side === 'left' ? left : right}
            onScroll={(event) => {
              const other = side === 'left' ? right.current : left.current;
              if (other && other.scrollTop !== event.currentTarget.scrollTop)
                other.scrollTop = event.currentTarget.scrollTop;
            }}
          >
            {aligned.map(({ hunk, rows }, i) => (
              <div key={i}>
                {header(hunk, i, side === 'right')}
                {rows.map((row, j) => (
                  <Cell key={j} cell={row[side]} side={side} />
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  return (
    <div className={`diff-view unified-diff ${className}`}>
      {aligned.map(({ hunk, rows }, i) => (
        <div key={i}>
          {header(hunk, i)}
          {rows.map((row, j) =>
            row.left?.kind === 'context' ? (
              <Cell key={j} cell={row.right} side="right" />
            ) : (
              <div key={j}>
                {row.left && <Cell cell={row.left} side="left" />}
                {row.right && <Cell cell={row.right} side="right" />}
              </div>
            ),
          )}
        </div>
      ))}
    </div>
  );
});
