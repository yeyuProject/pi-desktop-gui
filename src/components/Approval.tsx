import { useEffect, useRef, useState } from 'react';
import { FileText, Check, Terminal, ShieldCheck, Eye, Zap, X, AlertTriangle } from 'lucide-react';
import {
  APPROVAL_ALLOW,
  APPROVAL_ALWAYS,
  APPROVAL_DENY,
  grantLabel,
  grantActionLabel,
  type ApprovalGrant,
} from '../../shared/approval';
import { type ExtensionDialog, type ApprovalMode } from '../../shared/types';
import '../styles/management.css';
import { useLayer } from '../hooks/useLayer';

export const approvalModes: [ApprovalMode, string, string][] = [
  ['auto', '全自动', 'Pi 直接修改文件、执行命令'],
  ['confirm', '确认修改', '修改、执行命令、项目外读取和外部工具调用前先询问'],
  ['readonly', '只读', '只允许项目内读取和搜索，拒绝所有修改和命令'],
];
export function ApprovalSwitch({
  mode,
  disabled,
  change,
  grants = [],
  revoke,
}: {
  mode: ApprovalMode;
  disabled: boolean;
  change: (mode: ApprovalMode) => void;
  grants?: ApprovalGrant[];
  revoke?: (id?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayer(ref, open, () => setOpen(false), { kind: 'menu' });
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [open]);
  const Icon = mode === 'readonly' ? Eye : mode === 'confirm' ? ShieldCheck : Zap;
  return (
    <div className={'approval-switch ' + mode} ref={ref}>
      <button
        className="approval-pill"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="审批模式"
        title={approvalModes.find((m) => m[0] === mode)?.[2]}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={14} />
        <span>{approvalModes.find((m) => m[0] === mode)?.[1]}</span>
      </button>
      {open && (
        <div className="approval-menu" role="menu">
          {approvalModes.map(([id, label, hint]) => {
            const ItemIcon = id === 'readonly' ? Eye : id === 'confirm' ? ShieldCheck : Zap;
            return (
              <button
                key={id}
                role="menuitemradio"
                aria-checked={mode === id}
                onClick={() => {
                  setOpen(false);
                  // Keep explicit default choices, even when the effective mode is unchanged.
                  change(id);
                }}
              >
                <ItemIcon size={15} />
                <span>
                  {label}
                  <small>{hint}</small>
                </span>
                {mode === id && <Check size={14} />}
              </button>
            );
          })}
          {mode === 'confirm' && grants.length > 0 && (
            <div className="approval-grants">
              <div className="approval-grants-heading">
                <strong>本会话已放行（{grants.length}）</strong>
                <button disabled={!revoke} onClick={() => revoke?.()}>
                  全部清空
                </button>
              </div>
              {grants.map((grant) => (
                <div className="approval-grant" key={grant.id}>
                  <span title={grantLabel(grant)}>{grantLabel(grant)}</span>
                  <button
                    disabled={!revoke}
                    aria-label={`撤回 ${grantLabel(grant)}`}
                    onClick={() => revoke?.(grant.id)}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
export function ApprovalCard({
  dialog,
  first,
  respond,
}: {
  dialog: ExtensionDialog;
  first: boolean;
  respond: (value: string) => void;
}) {
  const a = dialog.approval!;
  const [reason, setReason] = useState<string | null>(null);
  const allow = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (first && document.activeElement === document.body) allow.current?.focus({ preventScroll: false });
  }, [first]);
  const lines = a.detail?.split('\n') ?? [];
  return (
    <section
      className={
        'approval-card ' +
        a.kind +
        ((a.writeTarget && a.writeTarget !== 'project') || a.readTarget === 'outside'
          ? ' approval-warning'
          : '')
      }
      aria-label={`等待批准：${a.toolName}`}
    >
      <header>
        {a.kind === 'shell' ? <Terminal size={15} /> : <FileText size={15} />}
        <strong>
          {a.kind === 'shell'
            ? 'Pi 想执行命令'
            : a.kind === 'write'
              ? `Pi 想${a.toolName === 'edit' ? '修改' : '写入'}文件`
              : a.kind === 'read'
                ? 'Pi 想读取或搜索文件'
                : `Pi 想调用 ${a.toolName}`}
        </strong>
        {a.path && <code>{a.path}</code>}
      </header>
      {a.writeTarget && a.writeTarget !== 'project' && (
        <p className="approval-path-warning">
          <AlertTriangle size={15} />
          {a.writeTarget === 'sensitive'
            ? '敏感文件：本次需要单独确认'
            : '项目外路径、执行配置或无法确认的路径：本次需要单独确认'}
        </p>
      )}
      {a.readTarget === 'outside' && (
        <p className="approval-path-warning">
          <AlertTriangle size={15} />
          项目外路径或无法确认的读取路径：本次需要单独确认，文件内容可能发送给模型
        </p>
      )}
      {a.kind === 'shell' ? (
        <pre className="approval-command">{a.summary}</pre>
      ) : a.detail ? (
        <pre className="diff-lines approval-diff">
          {lines.map((l, i) => (
            <div
              key={i}
              className={
                l.startsWith('+') ? 'added' : l.startsWith('-') ? 'removed' : l.startsWith('@@') ? 'hunk' : ''
              }
            >
              {l || ' '}
            </div>
          ))}
        </pre>
      ) : (
        <pre className="approval-command">{a.summary}</pre>
      )}
      {reason === null ? (
        <div className="approval-actions">
          <button ref={allow} className="primary" onClick={() => respond(APPROVAL_ALLOW)}>
            <Check size={14} />
            允许
          </button>
          {a.grant && (
            <button onClick={() => respond(APPROVAL_ALWAYS)} title={grantLabel(a.grant)}>
              {grantActionLabel(a.grant)}
            </button>
          )}
          <button className="deny" onClick={() => setReason('')}>
            拒绝…
          </button>
        </div>
      ) : (
        <form
          className="approval-actions"
          onSubmit={(e) => {
            e.preventDefault();
            respond(reason.trim() ? `${APPROVAL_DENY}：${reason.trim()}` : APPROVAL_DENY);
          }}
        >
          <input
            className="input"
            autoFocus
            aria-label="拒绝原因"
            placeholder="告诉 Pi 为什么拒绝、应该怎么做（可选）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setReason(null))}
          />
          <button type="submit" className="deny">
            拒绝
          </button>
        </form>
      )}
    </section>
  );
}
