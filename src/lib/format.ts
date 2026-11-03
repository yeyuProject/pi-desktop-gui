export const relativeTime = (value: number) => {
  const minutes = Math.round((Date.now() - value) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小时前`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(value);
};
export const time = (value: number) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value);
import { describeOperationError } from '../../shared/errors';
export const readableError = (e: unknown) => {
  const raw = String(e instanceof Error ? e.message : e).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
  if (typeof window !== 'undefined' && window.desktop)
    void window.desktop.invoke('logRendererError', raw.slice(-16000)).catch(() => {});
  return describeOperationError(e);
};
export const contextLabel = (n?: number) =>
  !n ? '' : n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
