export const parseArgumentHint = (hint: string) =>
  [...hint.matchAll(/<([^<>]+)>|\[([^[\]]+)\]/g)].map((m) => ({
    label: m[1] ?? m[2],
    required: Boolean(m[1]),
  }));
/** Pi 1.1 parseCommandArgs: quotes concatenate; backslashes remain literal. */
export function parsePromptArguments(text: string): string[] {
  const args: string[] = [];
  let current = '',
    quote = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else current += ch;
  }
  if (current) args.push(current);
  return args;
}
export function formatPromptArguments(values: string[]): string {
  const last = values.findLastIndex((value) => Boolean(value));
  return values
    .slice(0, last + 1)
    .map((value) => {
      if (!value) throw new Error('请按顺序填写模板参数；后面有内容时，前面的参数不能留空。');
      return /[\s"']/.test(value)
        ? value
            .split('"')
            .map((part) => '"' + part + '"')
            .join("'\"'")
        : value;
    })
    .join(' ');
}
