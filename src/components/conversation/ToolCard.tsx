import { useEffect, useRef, useState } from 'react';
import { IconButton } from '../IconButton';
import { ChevronDown, FileText, Check, AlertCircle, LoaderCircle, Copy, Terminal } from 'lucide-react';
import { type ToolActivity } from '../../../shared/types';
import { DiffView } from '../DiffView';
import { AnsiOutput } from '../AnsiOutput';
import { stripAnsi } from '../../lib/ansi';
import type { SessionMatch } from '../../lib/session-search';
import { SearchHighlight } from './SearchHighlight';
const api = window.desktop;

export const patchLines = (patch: string) => {
  const all = patch.split('\n');
  const start = all.findIndex((l) => l.startsWith('@@'));
  return (start < 0 ? all : all.slice(start)).filter((l) => !l.startsWith('\\ No newline'));
};
export function ToolCard({
  tool,
  expanded,
  onToggle,
  openFile,
  match,
  askHunk,
  rerun,
  canRerun,
}: {
  tool: ToolActivity;
  expanded: boolean;
  onToggle: (v: boolean) => void;
  openFile: (p: string) => void;
  match?: SessionMatch;
  askHunk?: (attachment: string | undefined, prompt: string) => void;
  rerun?: (command: string, includeContext: boolean) => void;
  canRerun?: boolean;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const copyOutput = async () => {
    clearTimeout(copyTimer.current);
    try {
      await api.invoke('copy', stripAnsi(tool.output));
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    copyTimer.current = setTimeout(() => setCopyState('idle'), 1600);
  };
  const target = String(tool.args.path ?? tool.args.file_path ?? tool.args.command ?? '');
  const shell = tool.name === 'bash' || tool.name === 'powershell';
  const exitCode = shell
    ? /(?:Command exited with code|exit code:?)\s*(-?\d+)/i.exec(tool.output)?.[1]
    : undefined;
  const lines = tool.patch ? patchLines(tool.patch) : [];
  const added = lines.filter((l) => l.startsWith('+')).length,
    removed = lines.filter((l) => l.startsWith('-')).length;
  const written =
    tool.name === 'write' && typeof tool.args.content === 'string'
      ? String(tool.args.content).split('\n').length
      : undefined;
  return (
    <details
      className={'tool-card ' + tool.status}
      open={expanded || Boolean(match) || tool.status === 'error' || tool.status === 'running'}
      onToggle={(e) => {
        if (!match) onToggle(e.currentTarget.open);
      }}
    >
      <summary>
        <span className="tool-icon">
          {tool.name === 'bash' || tool.name === 'powershell' ? (
            <Terminal size={15} />
          ) : (
            <FileText size={15} />
          )}
        </span>
        <span className="tool-description">
          <strong>
            {(
              {
                read: '读取文件',
                write: '写入文件',
                edit: '修改文件',
                bash: '执行命令',
                powershell: '执行命令',
              } as Record<string, string>
            )[tool.name] || tool.name}
          </strong>
          {target && <code title={target}>{target}</code>}
          {tool.patch && (
            <span className="line-delta">
              <ins>+{added}</ins>
              <del>−{removed}</del>
            </span>
          )}
          {written !== undefined && tool.status === 'done' && !tool.patch && (
            <span className="line-delta">
              <ins>{written} 行</ins>
            </span>
          )}
        </span>
        <span className="tool-result">
          {tool.status === 'running' ? (
            <LoaderCircle size={14} className="spin" />
          ) : tool.status === 'error' ? (
            <AlertCircle size={14} />
          ) : (
            <Check size={14} />
          )}{' '}
          {tool.status === 'running'
            ? '运行中'
            : tool.status === 'error'
              ? exitCode
                ? `退出码 ${exitCode}`
                : '失败'
              : `${((tool.durationMs ?? 0) / 1000).toFixed(1)}s`}
        </span>
        {shell && canRerun && rerun && tool.status !== 'running' && (
          <span className="tool-rerun" onClick={(event) => event.stopPropagation()}>
            <button
              title="本地重跑（不发给模型）"
              onClick={(event) => {
                event.preventDefault();
                rerun(String(tool.args.command ?? ''), false);
              }}
            >
              本地重跑
            </button>
            <button
              title="重跑并发给 Pi"
              onClick={(event) => {
                event.preventDefault();
                rerun(String(tool.args.command ?? ''), true);
              }}
            >
              重跑并发给 Pi
            </button>
          </span>
        )}
        <ChevronDown size={13} />
      </summary>
      <div className="tool-body">
        {match ? (
          <pre className="tool-search-content">
            <SearchHighlight
              text={match.text}
              query={match.query}
              activeStart={match.start}
            />
          </pre>
        ) : tool.patch ? (
          <DiffView
            patch={tool.patch}
            path={typeof tool.args.path === 'string' ? tool.args.path : undefined}
            className="inline-diff"
            onAskHunk={askHunk}
          />
        ) : (
          <>
            {Object.keys(tool.args).length > 0 && (
              <pre className="arguments">
                {shell ? String(tool.args.command ?? '') : JSON.stringify(tool.args, null, 2)}
              </pre>
            )}
            <AnsiOutput text={tool.output || '等待输出…'} />
          </>
        )}
        <div className="tool-actions">
          {Boolean(tool.args.path) && (
            <IconButton title="查看文件" onClick={() => openFile(String(tool.args.path))}>
              <FileText size={13} />
            </IconButton>
          )}
          <span role="status" className="tool-copy-status">
            {copyState === 'error' ? '复制失败，请重试' : copyState === 'copied' ? '已复制' : ''}
          </span>
          <IconButton title="复制输出" onClick={() => void copyOutput()}>
            {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
          </IconButton>
        </div>
      </div>
    </details>
  );
}
