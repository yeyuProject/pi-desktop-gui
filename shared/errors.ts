export type ModelErrorKind = 'auth' | 'quota' | 'busy' | 'context' | 'model' | 'network' | 'unknown';
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(`InvalidRequestError: ${message}`);
    this.name = 'InvalidRequestError';
  }
}
export function describeSystemError(error: unknown): string | undefined {
  const value =
    error && typeof error === 'object' ? (error as { code?: string; message?: string }) : undefined;
  const code =
    value?.code ??
    /\b(ENOENT|EACCES|EPERM|ENOSPC|EBUSY|ETIMEDOUT|ECONNREFUSED|ENOTFOUND)\b/.exec(
      value?.message ?? String(error),
    )?.[1];
  switch (code) {
    case 'ENOENT':
      return '找不到文件或目录';
    case 'EACCES':
    case 'EPERM':
      return '没有读写权限';
    case 'ENOSPC':
      return '磁盘空间不足';
    case 'EBUSY':
      return '文件被其他程序占用';
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
      return '网络连接失败';
    default:
      return undefined;
  }
}
/** User-facing operation errors; callers retain the original error in diagnostics. */
export function describeOperationError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
  if (raw.includes('InvalidRequestError:')) return '内部错误，已记入诊断。请重试，或在诊断中复制详情反馈。';
  const reason = describeSystemError(error);
  if (reason) return `${reason}。请检查路径、权限、磁盘空间或网络后重试，详情已记入诊断。`;
  if (
    !/[\u3400-\u9fff]/.test(raw) ||
    /\b(?:Error|TypeError|RangeError|SyntaxError):|\n\s+at\s|Command failed:|SQLSTATE\b|\bSELECT\s.+\bFROM\b/i.test(
      raw,
    )
  )
    return '操作没有完成，详情已记入诊断。';
  return redact(raw);
}
export type ModelErrorAction = 'providers' | 'billing' | 'regenerate' | 'compact' | 'model' | 'proxy';
export interface ModelErrorDescription {
  kind: ModelErrorKind;
  title: string;
  detail: string;
  action?: ModelErrorAction;
}

const descriptions: Record<ModelErrorKind, Omit<ModelErrorDescription, 'kind'>> = {
  auth: {
    title: '供应商拒绝了凭据',
    detail: '请检查 API Key、登录状态，以及账号是否有访问该服务的权限。',
    action: 'providers',
  },
  quota: {
    title: '账户额度不足或已欠费',
    detail: '请到当前供应商的网站查看余额、账单和用量限制，处理后再试。',
    action: 'billing',
  },
  busy: {
    title: '请求过多或服务繁忙',
    detail: '请稍等片刻再重新生成；频繁重试可能继续触发限制。',
    action: 'regenerate',
  },
  context: {
    title: '对话超出模型上下文',
    detail: '可以先压缩上下文，再继续提问；也可开启自动压缩。',
    action: 'compact',
  },
  model: {
    title: '模型不存在或无权使用',
    detail: '请选择当前供应商可用的模型，并确认账号已获得访问权限。',
    action: 'model',
  },
  network: {
    title: '无法连接模型服务',
    detail: '请检查网络、服务地址、HTTP 代理和证书设置。',
    action: 'proxy',
  },
  unknown: { title: '模型请求失败', detail: '暂时无法识别原因，请查看或复制下方详细信息。' },
};
export function describeModelError(kind: ModelErrorKind): ModelErrorDescription {
  return { kind, ...descriptions[kind] };
}
/** Classify provider messages only. Process, file and setup errors do not enter this classifier. */
export function classifyModelError(text: string): ModelErrorDescription {
  let kind: ModelErrorKind = 'unknown';
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|unauthenticated|invalid[ _-]api[ _-]key|authentication|permission[ _]denied/i.test(
      text,
    )
  )
    kind = 'auth';
  else if (
    /insufficient_quota|\bbilling\b|\bcredits?\b|余额|quota[ _]exceeded|payment required|\b402\b/i.test(text)
  )
    kind = 'quota';
  else if (/\b(?:429|529)\b|rate[ _]limit|too many requests|overloaded/i.test(text)) kind = 'busy';
  else if (/context[ _]length|maximum context|too many tokens|prompt is too long/i.test(text))
    kind = 'context';
  else if (/\b404\b.*model|model.*\b404\b|model not found|does not exist|not supported/is.test(text))
    kind = 'model';
  else if (
    /fetch failed|connection (?:error|failed|refused)|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network|certificate|timed out/i.test(
      text,
    )
  )
    kind = 'network';
  // A generic gateway 503 must not hide a more specific model, context or network diagnosis.
  else if (/\b503\b/.test(text)) kind = 'busy';
  return describeModelError(kind);
}

export function redact(text: string) {
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[已隐藏]')
    .replace(/(\b(?:https?|socks[45]h?):\/\/)[^/\s]*:[^/\s]*@/gi, '$1[已隐藏]@')
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]')
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{15,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
      '[已隐藏]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/(^|\n)(\s*(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, '$1$2[已隐藏]')
    .replace(
      /(\b[\w.-]{0,64}(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|token|secret|password|passwd|credential|authorization|signature|cookie)\b["']?\s*[:=]\s*)(\[已隐藏\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"';&}\]]+)/gi,
      (_match, prefix: string, value: string) => {
        if (value === '""' || value === "''") return prefix + value;
        const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
        return prefix + quote + '[已隐藏]' + quote;
      },
    );
}

export function redactMessageError<T extends { errorMessage?: string }>(message: T): T {
  return message.errorMessage ? { ...message, errorMessage: redact(message.errorMessage) } : message;
}
