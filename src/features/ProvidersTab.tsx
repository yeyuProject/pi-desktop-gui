const api = window.desktop;
import type { FeatureModel } from './usePiFeatures';
import type { ProviderInfo } from '../../shared/types';
const authSourceLabels: Record<NonNullable<ProviderInfo['authSource']>, string> = {
  stored: '已保存凭据',
  runtime: '临时凭据',
  environment: '环境变量凭据',
  fallback: '扩展凭据',
  models_json_key: 'models.json 凭据',
  models_json_command: 'models.json 命令凭据',
};
export function ProvidersTab({
  session,
  setNotice,
  filter,
  imageModel,
  setImageModel,
  reasoningModel,
  setReasoningModel,
  providers,
  provider,
  setProvider,
  providerQuery,
  setProviderQuery,
  document,
  providerId,
  setProviderId,
  baseUrl,
  setBaseUrl,
  apiType,
  setApiType,
  apiKey,
  setApiKey,
  modelIds,
  setModelIds,
  disabled,
  idleDisabled,
  idleReason,
  configEditingDisabled,
  run,
  refresh,
  addJson,
  configEditor,
}: Pick<
  FeatureModel,
  | 'session'
  | 'setNotice'
  | 'filter'
  | 'imageModel'
  | 'setImageModel'
  | 'reasoningModel'
  | 'setReasoningModel'
  | 'providers'
  | 'provider'
  | 'setProvider'
  | 'providerQuery'
  | 'setProviderQuery'
  | 'document'
  | 'providerId'
  | 'setProviderId'
  | 'baseUrl'
  | 'setBaseUrl'
  | 'apiType'
  | 'setApiType'
  | 'apiKey'
  | 'setApiKey'
  | 'modelIds'
  | 'setModelIds'
  | 'disabled'
  | 'idleDisabled'
  | 'idleReason'
  | 'configEditingDisabled'
  | 'run'
  | 'refresh'
  | 'addJson'
  | 'configEditor'
>) {
  return (
    <>
      <h3>登录与凭据</h3>
      <input
        className="input"
        aria-label="筛选供应商"
        placeholder="筛选供应商"
        value={providerQuery}
        onChange={(e) => setProviderQuery(e.target.value)}
      />
      <select
        className="input"
        aria-label="登录供应商"
        value={provider}
        onChange={(e) => setProvider(e.target.value)}
      >
        <option value="">选择供应商</option>
        {providers
          .filter((p) => (p.name + p.id).toLowerCase().includes(providerQuery.toLowerCase()))
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.authSource ? authSourceLabels[p.authSource] : '未配置'}
            </option>
          ))}
      </select>
      <div className="button-row">
        <button
          disabled={idleDisabled || !providers.find((p) => p.id === provider)?.oauth}
          title={
            idleReason ||
            (!provider
              ? '请先选择供应商'
              : !providers.find((p) => p.id === provider)?.oauth
                ? '此供应商不支持浏览器登录，请使用其支持的凭据方式'
                : '')
          }
          onClick={() =>
            void run(async () => {
              await api.invoke('login', session.id, provider, 'oauth');
              await refresh();
              setNotice('登录成功');
            })
          }
        >
          浏览器登录
        </button>
        <button
          disabled={idleDisabled || !providers.find((p) => p.id === provider)?.apiKey}
          title={
            idleReason ||
            (!provider
              ? '请先选择供应商'
              : !providers.find((p) => p.id === provider)?.apiKey
                ? '此供应商不支持 API Key 登录'
                : '')
          }
          onClick={() =>
            void run(async () => {
              await api.invoke('login', session.id, provider, 'api_key');
              await refresh();
              setNotice('凭据已保存');
            })
          }
        >
          设置 API Key
        </button>
        <button
          disabled={idleDisabled || !provider}
          title={idleReason || (!provider ? '请先选择要退出的供应商' : '')}
          onClick={() =>
            void run(async () => {
              if (!(await api.invoke('logout', session.id, provider))) return;
              await refresh();
              setNotice('已移除保存的登录凭据；其他来源的凭据仍独立生效，当前来源显示在供应商名称后。');
            })
          }
        >
          退出登录
        </button>
      </div>
      <p className="settings-copy">
        {provider
          ? `所选供应商支持：${[providers.find((p) => p.id === provider)?.oauth && '浏览器登录', providers.find((p) => p.id === provider)?.apiKey && 'API Key'].filter(Boolean).join('、') || '请使用下方自定义配置'}。`
          : providers.length
            ? '先选择供应商，再使用其支持的登录方式。'
            : '连接 Pi 后加载登录供应商列表；自定义供应商配置可在下方编辑。'}
      </p>
      <details>
        <summary>添加自定义供应商</summary>
        <label className="field-label">供应商标识</label>
        <input
          className="input"
          aria-label="新供应商标识"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value)}
        />
        <label className="field-label">接口地址</label>
        <input
          className="input"
          aria-label="供应商接口地址"
          placeholder="https://example.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <label className="field-label">API 类型</label>
        <select
          className="input"
          aria-label="API 类型"
          value={apiType}
          onChange={(e) => setApiType(e.target.value)}
        >
          <option>openai-completions</option>
          <option>openai-responses</option>
          <option>anthropic-messages</option>
          <option>google-generative-ai</option>
        </select>
        <label className="field-label">API Key 或环境变量名</label>
        <input
          type="password"
          autoComplete="off"
          className="input"
          aria-label="新供应商密钥"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <label className="field-label">模型 ID（每行一个）</label>
        <textarea
          className="input"
          aria-label="新供应商模型"
          value={modelIds}
          onChange={(e) => setModelIds(e.target.value)}
        />
        <label className="option-row">
          这些模型支持图片
          <input type="checkbox" checked={imageModel} onChange={(e) => setImageModel(e.target.checked)} />
        </label>
        <label className="option-row">
          这些模型支持推理级别
          <input
            type="checkbox"
            checked={reasoningModel}
            onChange={(e) => setReasoningModel(e.target.checked)}
          />
        </label>
        <button
          disabled={configEditingDisabled}
          title={!document ? '请先读取供应商配置' : ''}
          onClick={() =>
            void run(async () => {
              if (!/^https?:\/\//.test(baseUrl) || !modelIds.trim()) throw new Error('请填写接口地址和模型');
              addJson('providers', providerId, {
                baseUrl,
                api: apiType,
                ...(apiKey ? { apiKey } : {}),
                models: modelIds
                  .split(/\r?\n/)
                  .map((id) => id.trim())
                  .filter(Boolean)
                  .map((id) => ({
                    id,
                    input: imageModel ? ['text', 'image'] : ['text'],
                    reasoning: reasoningModel,
                    contextWindow: 128000,
                    maxTokens: 16384,
                  })),
              });
              setNotice('已加入下方配置，请核对模型能力与上下文大小后保存。');
            })
          }
        >
          添加到配置
        </button>
      </details>
      <h3>供应商配置</h3>
      {configEditor('models')}
    </>
  );
}
