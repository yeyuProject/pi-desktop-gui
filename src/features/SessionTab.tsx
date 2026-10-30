import { Copy, Download, Share2, Terminal, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import '../styles/management.css';
const api = window.desktop;
import type { FeatureModel } from './usePiFeatures';
import { SessionUsageDetails } from '../components/conversation/Usage';
export function SessionTab({
  session,
  runtime,
  usage,
  close,
  setNotice,
  instructions,
  setInstructions,
  disabled,
  idleDisabled,
  idleReason,
  run,
  exportFile,
}: Pick<
  FeatureModel,
  | 'session'
  | 'runtime'
  | 'usage'
  | 'close'
  | 'setNotice'
  | 'instructions'
  | 'setInstructions'
  | 'disabled'
  | 'idleDisabled'
  | 'idleReason'
  | 'run'
  | 'exportFile'
>) {
  const [usagePeriod, setUsagePeriod] = useState<'today' | 'week' | 'all'>('all');
  const currentUsage = usage?.[usagePeriod];
  const hasHistory = runtime.connected ? runtime.messages.length > 0 : Boolean(session.file);
  return (
    <>
      <h3>当前会话</h3>
      <p>{session.title}</p>
      <p className="settings-copy">{runtime.cwd || session.cwd || '连接后显示工作目录'}</p>
      <div className="button-row">
        <button
          onClick={() =>
            void run(async () => {
              await api.invoke('revealSessionDirectory', session.id);
            })
          }
        >
          <FolderOpen size={14} />
          打开工作目录
        </button>
        {hasHistory && (
          <button
            disabled={disabled}
            onClick={() =>
              void run(async () => {
                await api.invoke('branchSession', session.id, 'clone');
                close();
              })
            }
          >
            <Copy size={14} />
            克隆会话
          </button>
        )}
      </div>
      {runtime.liveUsage && (
        <p className="settings-copy">以下为 Pi 最近返回的会话统计；本次请求仍在进行中。</p>
      )}
      <div className="feature-stats session-usage-details" aria-label="当前会话用量">
        <SessionUsageDetails stats={runtime.stats ?? {}} />
      </div>
      <p className="settings-copy">
        累计用量包含已压缩的历史及工具、压缩和分支摘要的用量。窗口剩余为估算，自动压缩可能提前触发。
        缓存读取占输入按累计缓存读取 /（输入 + 缓存读取 + 缓存写入）计算。
      </p>
      <section className="usage-summary" aria-label="本地用量汇总">
        <h3>本地用量汇总</h3>
        <p className="settings-copy">
          按会话最后更新时间筛选，累计该会话全部用量；今日和近 7 天并非逐日账单。费用为 Pi 返回的估算。
        </p>
        <div className="usage-periods" role="group" aria-label="用量时间范围">
          {(
            [
              ['today', '今日'],
              ['week', '近 7 天'],
              ['all', '全部历史'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} aria-pressed={usagePeriod === key} onClick={() => setUsagePeriod(key)}>
              <span>{label}</span>
              <strong>{usage?.[key].tokens.toLocaleString() ?? '—'} tokens</strong>
              <small>${usage?.[key].cost.toFixed(4) ?? '—'}</small>
            </button>
          ))}
        </div>
        {currentUsage && (
          <>
            {currentUsage.sideChat && (
              <p className="settings-copy" aria-label="侧边对话用量">
                其中侧边对话：{currentUsage.sideChat.tokens.toLocaleString()} tokens · $
                {currentUsage.sideChat.cost.toFixed(4)}，不计入主会话上下文水位。
              </p>
            )}
            {(currentUsage.missingTokens > 0 || currentUsage.missingCost > 0) && (
              <p className="settings-copy">
                {currentUsage.missingTokens} 个会话尚无用量数据，{currentUsage.missingCost}{' '}
                个会话尚无费用数据；仅汇总已知数据。
              </p>
            )}
            <table className="usage-projects">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>会话</th>
                  <th>Token</th>
                  <th>估算费用</th>
                  <th>费用占比</th>
                </tr>
              </thead>
              <tbody>
                {currentUsage.projects.map((group) => (
                  <tr key={group.projectId ?? 'standalone'}>
                    <th>{group.name}</th>
                    <td>{group.sessions}</td>
                    <td>{group.tokens.toLocaleString()}</td>
                    <td>${group.cost.toFixed(4)}</td>
                    <td>{(group.costShare * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!currentUsage.projects.length && <p className="settings-copy">这个时间范围内还没有会话。</p>}
          </>
        )}
      </section>
      <h3>上下文与队列</h3>
      <p className="settings-copy">
        开关影响本会话后续步骤，已经开始的重试或压缩继续执行。取消当前步骤请使用单独操作。
      </p>
      {runtime.configurationPending && <p className="environment-note">配置已保存，等待本会话空闲后加载。</p>}
      {runtime.retry && (
        <button onClick={() => void run(() => api.invoke('abortRetry', session.id))}>取消当前重试</button>
      )}
      {runtime.status === 'compacting' && (
        <button onClick={() => void run(() => api.invoke('stop', session.id))}>停止当前压缩及任务</button>
      )}
      {[
        ['autoCompaction', '自动压缩上下文'],
        ['autoRetry', '临时错误自动重试'],
      ].map(([key, label]) => (
        <label className="option-row" key={key}>
          <span>{label}</span>
          <input
            type="checkbox"
            aria-label={label}
            checked={Boolean(runtime[key as 'autoCompaction'])}
            disabled={disabled}
            onChange={(e) =>
              void run(async () => {
                await api.invoke('piOption', session.id, key as 'autoCompaction', e.target.checked);
              })
            }
          />
        </label>
      ))}
      {[
        ['steeringMode', '补充指令发送方式'],
        ['followUpMode', '后续消息发送方式'],
      ].map(([key, label]) => (
        <label className="option-row" key={key}>
          {label}
          <select
            aria-label={label}
            disabled={disabled}
            value={runtime[key as 'steeringMode'] || 'one-at-a-time'}
            onChange={(e) =>
              void run(async () => {
                await api.invoke('piOption', session.id, key as 'steeringMode', e.target.value);
              })
            }
          >
            <option value="one-at-a-time">逐条发送</option>
            <option value="all">一起发送</option>
          </select>
        </label>
      ))}
      <label className="field-label">压缩要求（可选）</label>
      <textarea
        className="input"
        aria-label="压缩要求"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="例如：保留文件修改和待办事项"
      />
      <button
        disabled={idleDisabled}
        title={idleReason}
        onClick={() =>
          void run(async () => {
            const result = await api.invoke('compact', session.id, instructions);
            setNotice(`压缩完成，原上下文 ${result.tokensBefore} tokens。\n${result.summary}`);
          })
        }
      >
        立即压缩
      </button>
      {hasHistory && (
        <>
          <h3>导出与分享</h3>
          <div className="button-row">
            <button disabled={disabled} onClick={() => void exportFile('html')}>
              <Download size={14} />
              导出 HTML
            </button>
            <button disabled={disabled} onClick={() => void exportFile('jsonl')}>
              导出 JSONL
            </button>
            <button
              disabled={disabled}
              onClick={() =>
                void run(async () => {
                  const url = await api.invoke('shareSession', session.id);
                  if (url) setNotice('分享链接已复制：' + url);
                })
              }
            >
              <Share2 size={14} />
              分享会话
            </button>
          </div>
          <p className="settings-copy">
            分享会生成 GitHub Gist 链接；上传前会再次确认。建议先导出检查完整内容。
          </p>
        </>
      )}
      <h3>Pi 原生终端</h3>
      <p className="settings-copy">
        依赖终端自定义界面的扩展、终端主题和渲染设置，可在同一会话的原生终端使用。关闭终端后回到桌面重新连接。
      </p>
      <button
        disabled={idleDisabled}
        title={idleReason}
        onClick={() =>
          void run(async () => {
            await api.invoke('openPiTerminal', session.id);
            close();
          })
        }
      >
        <Terminal size={14} />在 Pi 终端继续
      </button>
    </>
  );
}
