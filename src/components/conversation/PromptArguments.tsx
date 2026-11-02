import { useEffect, useState, type KeyboardEvent } from 'react';
import { formatPromptArguments, parseArgumentHint, parsePromptArguments } from '../../lib/prompt-arguments';
export function PromptArguments({
  command,
  hint,
  draft,
  update,
  error,
  chooseFile,
  onFileKeyDown,
}: {
  command: string;
  hint: string;
  draft: string;
  update: (text: string) => void;
  error: (text: string) => void;
  chooseFile: (query: string, picked: (path: string) => void) => void;
  onFileKeyDown: (event: KeyboardEvent<HTMLInputElement>) => boolean;
}) {
  const fields = parseArgumentHint(hint);
  const [values, setValues] = useState<string[]>(() =>
    parsePromptArguments(draft.slice(command.length).trimStart()),
  );
  useEffect(() => {
    setValues(parsePromptArguments(draft.slice(command.length).trimStart()));
    error('');
  }, [command, draft]);
  const change = (index: number, value: string) => {
    const next = fields.map((_, i) => (i === index ? value : (values[i] ?? '')));
    setValues(next);
    try {
      update(command + ' ' + formatPromptArguments(next));
      error('');
    } catch (problem) {
      error(problem instanceof Error ? problem.message : '请检查模板参数');
    }
  };
  if (!fields.length) return null;
  return (
    <div className="prompt-arguments" aria-label="模板参数">
      {fields.map((field, index) => (
        <label key={index}>
          <span>
            {field.label}
            {field.required ? ' *' : '（可选）'}
          </span>
          <input
            aria-label={`模板参数：${field.label}`}
            aria-invalid={field.required && !(values[index] ?? '').trim()}
            value={values[index] ?? ''}
            placeholder={field.required ? '必填' : '可选'}
            onKeyDown={(event) => {
              if (!onFileKeyDown(event) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                document.querySelector<HTMLTextAreaElement>('[aria-label="任务输入"]')?.focus();
              }
            }}
            onChange={(event) => {
              change(index, event.target.value);
              const query = /(?:^|\s)@([^\s@]*)$/.exec(event.target.value);
              if (query)
                chooseFile(query[1], (path) => change(index, event.target.value.replace(/@[^\s@]*$/, path)));
            }}
          />
        </label>
      ))}
    </div>
  );
}
