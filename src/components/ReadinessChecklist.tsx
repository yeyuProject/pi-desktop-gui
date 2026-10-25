import { CheckCircle2 } from 'lucide-react';
import { type Runtime, type Environment } from '../../shared/types';
import { compatibilityMessage } from '../../shared/pi-version';
import { PiCompatibilityNotice } from './PiCompatibilityNotice';

export function ReadinessChecklist({
  environment,
  runtime,
  ownRuntime,
  modelLabel,
  canConnect,
  checkEnvironment,
  connect,
  providers,
}: {
  environment?: Environment;
  runtime: Runtime;
  ownRuntime: boolean;
  modelLabel: string;
  canConnect: boolean;
  checkEnvironment: () => void;
  connect: () => void;
  providers: () => void;
}) {
  if (!environment) return null;
  const connected = ownRuntime && runtime.connected;
  const piReady = connected || environment.supported;
  const modelReady = connected ? Boolean(runtime.model) : Boolean(modelLabel);
  const shellReady = Boolean(environment.bash);
  if (piReady && modelReady && shellReady) return null;
  const chooseModel = () => document.querySelector<HTMLButtonElement>('.model-pill')?.click();
  const steps: { done: boolean; title: string; detail: string; action?: [string, () => void] }[] = [
    {
      done: piReady,
      title: piReady ? `已找到 Pi ${environment.version ?? ''}` : '找到 Pi',
      detail: piReady
        ? environment.piPath
        : environment.version
          ? compatibilityMessage(environment.version, environment.compatibility)
          : '未检测到 Pi，请安装或在设置中指定 cli.js',
      action: piReady ? undefined : ['检查运行环境', checkEnvironment],
    },
    {
      done: modelReady,
      title: modelReady ? `模型：${(connected && runtime.model?.name) || modelLabel}` : '选择一个模型',
      detail: !piReady
        ? '找到 Pi 后读取可用模型'
        : !connected
          ? environment.authExists || environment.modelsExist
            ? '已发现凭据配置，连接后读取可用模型'
            : '还没有发现凭据；可先连接，再登录供应商'
          : runtime.models.length
            ? `共 ${runtime.models.length} 个可用模型`
            : '没有可用模型，登录供应商或添加自定义端点',
      action:
        modelReady || !piReady
          ? undefined
          : !connected
            ? ['连接并读取模型', connect]
            : runtime.models.length
              ? ['选择模型', chooseModel]
              : ['登录供应商', providers],
    },
  ];
  steps.push({
    done: shellReady,
    title: shellReady
      ? '已找到命令执行环境'
      : window.desktop.platform === 'win32'
        ? '安装 Git Bash'
        : '安装 bash',
    detail:
      environment.bash ||
      (window.desktop.platform === 'win32'
        ? '未检测到 Git Bash，执行命令会失败。请安装 Git for Windows，或在 Pi 配置中设置 shellPath，然后重新检查。'
        : '未检测到 bash，执行命令会失败。请安装 bash 或在 Pi 配置中设置 shellPath，然后重新检查。'),
    action: shellReady ? undefined : ['重新检查运行环境', checkEnvironment],
  });
  return (
    <div className="readiness" role="region" aria-label="开始前检查">
      <strong>开始前检查</strong>
      {!piReady && <PiCompatibilityNotice environment={environment} />}
      {steps.map((s, i) => (
        <div key={i} className={'readiness-step' + (s.done ? ' done' : '')}>
          {s.done ? <CheckCircle2 size={17} /> : <span className="step-number">{i + 1}</span>}
          <span>
            {s.title}
            <small title={s.detail}>{s.detail}</small>
          </span>
          {s.action && (
            <button disabled={s.action[1] === connect && !canConnect} onClick={s.action[1]}>
              {s.action[0]}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
