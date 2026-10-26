import type { Runtime, Session, Settings } from '../../shared/types';

export function sessionModelState(
  runtime: Runtime,
  session: Session | undefined,
  settings: Pick<Settings, 'provider' | 'modelId'>,
) {
  const ownRuntime = Boolean(session && runtime.sessionId === session.id);
  const saved =
    session?.model ?? (settings.modelId ? { provider: settings.provider, id: settings.modelId } : undefined);
  const model = ownRuntime
    ? runtime.model
    : saved
      ? runtime.models.find((candidate) => candidate.provider === saved.provider && candidate.id === saved.id)
      : undefined;
  // A new session uses Pi's effective defaults, which can include project overrides.
  // Available models establish setup; the previous session's choice is not that default.
  const label = model?.name || saved?.id || (runtime.models.length ? 'Pi 默认模型' : '');
  return {
    label,
    runtime: ownRuntime
      ? runtime
      : {
          ...runtime,
          connected: false,
          modelsLoaded: false,
          modelsLoading: false,
          model,
          thinking: session?.thinking,
          thinkingLevels: [],
        },
  };
}
