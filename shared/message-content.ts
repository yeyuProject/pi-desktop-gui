export interface ProjectFileBlock {
  path: string;
  lines?: string;
  text: string;
}
export interface SkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage?: string;
}
export interface DraftQuote {
  id: string;
  text: string;
  role: 'user' | 'assistant' | 'toolResult' | 'side';
  turn: number;
  messageTimestamp: number;
  section: 'text' | 'thinking' | 'code' | 'tool' | 'skill';
  truncated?: boolean;
}

export function truncateQuote(quote: DraftQuote): DraftQuote {
  const characters = Array.from(quote.text);
  return characters.length > 8000
    ? { ...quote, text: characters.slice(0, 8000).join(''), truncated: true }
    : quote;
}

export function isDraftQuote(value: unknown): value is DraftQuote {
  if (!value || typeof value !== 'object') return false;
  const q = value as DraftQuote;
  return (
    typeof q.id === 'string' &&
    /^[\w-]{1,100}$/.test(q.id) &&
    typeof q.text === 'string' &&
    Array.from(q.text).length <= 8000 &&
    Boolean(q.text.trim()) &&
    ['user', 'assistant', 'toolResult', 'side'].includes(q.role) &&
    Number.isSafeInteger(q.turn) &&
    q.turn >= 0 &&
    Number.isFinite(q.messageTimestamp) &&
    q.messageTimestamp >= 0 &&
    ['text', 'thinking', 'code', 'tool', 'skill'].includes(q.section) &&
    (q.truncated === undefined || typeof q.truncated === 'boolean')
  );
}

export function quoteLabel(quote: Pick<DraftQuote, 'role' | 'turn' | 'section'>): string {
  if (quote.role === 'side') return '侧边对话';
  const section = {
    text: quote.role === 'assistant' ? 'Pi 回复' : '你',
    thinking: '思考过程',
    code: '代码',
    tool: '工具输出',
    skill: '技能正文',
  }[quote.section];
  return `第 ${quote.turn} 轮 ${section}`;
}

export function formatMessageQuotes(quotes: DraftQuote[]): string {
  return quotes
    .map(
      ({ text, ...source }) =>
        `> [引用 ${quoteLabel(source)}](pi-quote:${encodeURIComponent(JSON.stringify(source))})\n` +
        text
          .split(/\r?\n/)
          .map((line) => '> ' + line)
          .join('\n'),
    )
    .join('\n\n');
}

export function splitMessageQuotes(text: string): { text: string; quotes: DraftQuote[] } {
  const lines = text.split('\n');
  const quotes: DraftQuote[] = [];
  let offset = 0;
  while (offset < lines.length) {
    const header = /^> \[引用 (.+)\]\(pi-quote:([^)]*)\)$/.exec(lines[offset]);
    if (!header) break;
    let end = offset + 1;
    const body: string[] = [];
    while (end < lines.length && lines[end].startsWith('> ')) body.push(lines[end++].slice(2));
    try {
      const quote = { ...JSON.parse(decodeURIComponent(header[2])), text: body.join('\n') };
      if (!isDraftQuote(quote) || quoteLabel(quote) !== header[1]) break;
      quotes.push(quote);
    } catch {
      break;
    }
    offset = end;
    if (lines[offset] === '') offset++;
  }
  return { text: quotes.length ? lines.slice(offset).join('\n') : text, quotes };
}

export function composeQuotedInput(text: string, quotes: DraftQuote[]): string {
  if (!quotes.length) return text;
  const quoted = formatMessageQuotes(quotes);
  // Pi expands skills only when /skill: is at the beginning of the input.
  const invocation = /^(\/skill:[^\s]+)(?: ([\s\S]*))?$/.exec(text);
  if (invocation) return `${invocation[1]} ${quoted}${invocation[2] ? '\n\n' + invocation[2] : ''}`;
  return quoted + (text ? '\n\n' + text : '');
}
export function mergeDraftQuotes(before: DraftQuote[], added: DraftQuote[]): DraftQuote[] {
  const result = [...before];
  for (const quote of added)
    if (
      !result.some(
        (item) =>
          item.role === quote.role &&
          item.messageTimestamp === quote.messageTimestamp &&
          item.section === quote.section &&
          item.text === quote.text,
      )
    )
      result.push(quote);
  return result;
}

export function parseUserMessage(text: string) {
  const parsed = splitUserContent(text);
  const skill = parseSkillBlock(parsed.text);
  return { ...parsed, ...splitMessageQuotes(skill ? (skill.userMessage ?? '') : parsed.text), skill };
}

/** Match Pi's native skill expansion without importing its Node runtime. */
export function parseSkillBlock(text: string): SkillBlock | null {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  return match
    ? { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() || undefined }
    : null;
}

/** Recover editable input; referenced files are reattached separately. */
export function userMessageInput(text: string): string {
  const parsed = parseUserMessage(text);
  return parsed.skill ? `/skill:${parsed.skill.name}${parsed.text ? ' ' + parsed.text : ''}` : parsed.text;
}

export function splitUserContent(text: string): { text: string; files: ProjectFileBlock[] } {
  const start = text.indexOf('\n\n<project_file path=');
  if (start < 0) return { text, files: [] };
  const blocks = [
    ...text
      .slice(start)
      .matchAll(
        /\n\n<project_file path=("(?:[^"\\]|\\.)*")(?: lines="(\d+-\d+)")?>\n([\s\S]*?)\n<\/project_file>/g,
      ),
  ];
  if (!blocks.length || blocks.map((b) => b[0]).join('') !== text.slice(start)) return { text, files: [] };
  try {
    return {
      text: text.slice(0, start),
      files: blocks.map((b) => ({ path: JSON.parse(b[1]) as string, lines: b[2], text: b[3] })),
    };
  } catch {
    return { text, files: [] };
  }
}
