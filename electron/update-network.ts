export const DEFAULT_UPDATE_FEED = 'https://github.com/yeyuProject/pi-desktop-gui/releases/latest/download/';
export function updateFeed(value = '') {
  const url = new URL(value.trim() || DEFAULT_UPDATE_FEED);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('更新镜像必须是无账号密码、查询参数的 HTTPS 目录地址');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}
export function updateProxy(value = '', env: NodeJS.ProcessEnv = process.env) {
  const proxy = value.trim() || env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || '';
  if (!proxy) return { mode: 'system' as const };
  const url = new URL(proxy);
  if (
    !['http:', 'https:', 'socks5:', 'socks4:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search ||
    url.hash
  )
    throw new Error('更新代理请填写 http、https 或 socks 地址；账号密码请由系统代理管理');
  return {
    mode: 'fixed_servers' as const,
    proxyRules: url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin,
  };
}
