import { useEffect, useState } from 'react';
import type { Session } from '../../shared/types';
import type { TeamRole } from '../../shared/team';
import { roleApprovalCeiling } from '../../shared/team';
import { readableError } from '../lib/format';
import { ErrorFeedback } from '../components/ErrorFeedback';
export function RolesTab({
  session,
  disabled,
  dirty,
}: {
  session: Session;
  disabled: boolean;
  dirty: (value: boolean) => void;
}) {
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'user' | 'project'>('user');
  const [text, setText] = useState('');
  const [revision, setRevision] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const refresh = async () => setRoles(await window.desktop.invoke('listTeamRoles', session.id));
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(readableError(e));
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void run(refresh);
    return () => dirty(false);
  }, [session.id]);
  return (
    <section>
      <h3>角色</h3>
      <p>个人角色覆盖内置角色，已信任项目中的同名角色优先。分派后保留当时的角色定义。</p>
      <ErrorFeedback message={error} />
      {deleting && (
        <div role="alert" className="feature-notice">
          <p>删除角色 {name}？角色文件将被删除，已分派成员保留原来的角色定义。</p>
          <button disabled={pending} onClick={() => setDeleting(false)}>
            取消
          </button>
          <button
            disabled={pending || disabled}
            onClick={() =>
              void run(async () => {
                await window.desktop.invoke('deleteTeamRole', session.id, source, name, revision!);
                dirty(false);
                setDeleting(false);
                setEditing(false);
                await refresh();
              })
            }
          >
            确认删除
          </button>
        </div>
      )}
      {!editing ? (
        <>
          <button
            disabled={disabled || pending}
            onClick={() => {
              setName('my-role');
              setSource('user');
              setRevision(undefined);
              setText(
                '---\nname: my-role\ndescription: 描述角色用途\ntools: read, grep, find, ls\n---\n只读调研并汇报结论。\n',
              );
              setEditing(true);
              dirty(true);
            }}
          >
            新建角色
          </button>
          {roles.map((role) => (
            <div className="resource-item" key={role.name}>
              <strong>{role.name}</strong>
              <p>{role.description}</p>
              <small>
                {role.source === 'builtin' ? '内置' : role.source === 'user' ? '个人' : '项目'} ·{' '}
                {roleApprovalCeiling(role) === 'readonly' ? '只读' : '可写'} · {role.model ?? '跟随负责人'}
              </small>
              <button
                disabled={!role.editable || disabled || pending}
                onClick={() =>
                  void run(async () => {
                    const doc = await window.desktop.invoke(
                      'readTeamRole',
                      session.id,
                      role.source as 'user' | 'project',
                      role.name,
                    );
                    setName(role.name);
                    setSource(role.source as 'user' | 'project');
                    setRevision(doc.role.revision);
                    setText(doc.text);
                    setEditing(true);
                    dirty(false);
                  })
                }
              >
                编辑
              </button>
            </div>
          ))}
        </>
      ) : (
        <div className="form-grid">
          <label>
            角色名
            <input
              value={name}
              disabled={!!revision}
              onChange={(e) => {
                setName(e.target.value);
                dirty(true);
              }}
            />
          </label>
          <label>
            保存位置
            <select
              value={source}
              disabled={!!revision}
              onChange={(e) => {
                setSource(e.target.value as 'user' | 'project');
                dirty(true);
              }}
            >
              <option value="user">个人</option>
              {session.projectId && <option value="project">当前项目</option>}
            </select>
          </label>
          <label>
            Markdown 与 YAML
            <textarea
              rows={16}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                dirty(true);
              }}
            />
          </label>
          <div>
            <button
              disabled={pending || disabled}
              onClick={() =>
                void run(async () => {
                  await window.desktop.invoke('saveTeamRole', session.id, { name, source, text, revision });
                  dirty(false);
                  setEditing(false);
                  await refresh();
                })
              }
            >
              保存
            </button>
            <button
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setDeleting(false);
                dirty(false);
              }}
            >
              放弃修改
            </button>
            {revision && (
              <>
                <button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const doc = await window.desktop.invoke('readTeamRole', session.id, source, name);
                      setText(doc.text);
                      setRevision(doc.role.revision);
                      dirty(false);
                    })
                  }
                >
                  重新读取
                </button>
                <button disabled={pending || disabled} onClick={() => setDeleting(true)}>
                  删除角色
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
