import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { validateAskAnswer, type AskAnswer, type AskQuestion } from '../../../shared/ask';
import type { ExtensionDialog, ExtensionResponse } from '../../../shared/types';
import { getAskDraft, saveAskDraft, type AskDraft } from '../../lib/ask-drafts';
import { topLayer } from '../../hooks/useLayer';
import { RichText } from './Markdown';
import { Modal } from '../Modal';

export function AskPanel({
  sessionId,
  dialog,
  disabled,
  respond,
}: {
  sessionId: string;
  dialog: ExtensionDialog;
  disabled: boolean;
  respond: (value: ExtensionResponse) => Promise<void>;
}) {
  const request = dialog.ask!;
  const root = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(() => getAskDraft(sessionId, dialog.id, request));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [height, setHeight] = useState<number>();
  const [now, setNow] = useState(Date.now);
  const update = (next: AskDraft) => {
    saveAskDraft(sessionId, dialog.id, next);
    setDraft(next);
    setError('');
  };
  const answer = (value: AskDraft): AskAnswer => ({
    status: 'answered',
    answers: value.answers,
    ...(value.note ? { note: value.note } : {}),
  });
  let complete = true;
  try {
    validateAskAnswer(request, answer(draft));
  } catch {
    complete = false;
  }
  const submit = async (value: ExtensionResponse) => {
    if (disabled || pending) return;
    setPending(true);
    setError('');
    try {
      await respond(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : '未能提交回答，请重试。');
    } finally {
      setPending(false);
    }
  };
  useLayoutEffect(() => {
    const container = root.current?.closest<HTMLElement>('.conversation');
    const composer = root.current?.closest<HTMLElement>('.composer-wrap');
    if (!container || !composer) return;
    const measure = () => {
      setHeight(container.getBoundingClientRect().height / 2);
      container.style.setProperty('--ask-composer-height', `${composer.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      container.style.removeProperty('--ask-composer-height');
    };
  }, []);
  useEffect(() => {
    const active = document.activeElement;
    if (
      topLayer() ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLElement && active.isContentEditable)
    )
      return;
    root.current?.querySelector<HTMLInputElement>('.ask-option input')?.focus();
  }, [dialog.id]);
  useEffect(() => {
    if (!dialog.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [dialog.expiresAt]);
  const optionsFor = (question: AskQuestion) => [
    ...question.options.filter((option) => option.recommended),
    ...question.options.filter((option) => !option.recommended),
  ];
  const choose = (question: AskQuestion, label?: string) => {
    const previous = draft.answers[question.id];
    const other = label === undefined;
    const selected = other
      ? question.multiSelect
        ? previous.selected
        : []
      : question.multiSelect
        ? previous.selected.includes(label)
          ? previous.selected.filter((item) => item !== label)
          : [...previous.selected, label]
        : [label];
    const selection = {
      selected,
      ...(other
        ? previous.other === undefined
          ? { other: '' }
          : question.multiSelect
            ? {}
            : { other: previous.other }
        : question.multiSelect && previous.other !== undefined
          ? { other: previous.other }
          : {}),
    };
    const next: AskDraft = {
      ...draft,
      answers: { ...draft.answers, [question.id]: selection },
      otherOpen:
        selection.other !== undefined
          ? [...new Set([...draft.otherOpen, question.id])]
          : draft.otherOpen.filter((id) => id !== question.id),
    };
    update(next);
    if (other && selection.other !== undefined) {
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLInputElement>(
            `[data-question-index="${request.questions.indexOf(question)}"] .ask-other`,
          )
          ?.focus(),
      );
    } else if (!other && request.questions.length === 1 && !question.multiSelect) {
      void submit({ ask: answer(next) });
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.repeat) return;
    const target = event.target as HTMLElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (draft.noteOpen || draft.otherOpen.length) {
        // Keep the next Escape in this panel after the focused text field unmounts.
        const field = target.closest('fieldset') ?? root.current;
        field?.querySelector<HTMLInputElement>('.ask-option input')?.focus();
        update({ ...draft, noteOpen: false, otherOpen: [] });
      } else setConfirmSkip(true);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (complete) void submit({ ask: answer(draft) });
      return;
    }
    if (!(target instanceof HTMLInputElement) || !['radio', 'checkbox'].includes(target.type)) return;
    const field = target.closest('fieldset')!;
    const controls = [...field.querySelectorAll<HTMLInputElement>('.ask-option input')];
    const index = controls.indexOf(target);
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      controls[(index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length]?.focus();
    } else if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      controls[Number(event.key) - 1]?.click();
    } else if (event.key === 'Tab') {
      const fields = [...root.current!.querySelectorAll('fieldset')];
      const next = fields[fields.indexOf(field) + (event.shiftKey ? -1 : 1)];
      const focus =
        next?.querySelector<HTMLInputElement>('.ask-option input') ??
        (!event.shiftKey ? root.current?.querySelector<HTMLButtonElement>('.ask-footer button') : undefined);
      if (focus) {
        event.preventDefault();
        event.stopPropagation();
        focus.focus();
      }
    }
  };
  const seconds = dialog.expiresAt ? Math.max(0, Math.ceil((dialog.expiresAt - now) / 1000)) : undefined;
  return (
    <>
      <section
        ref={root}
        className="ask-panel"
        aria-label="Pi 需要你决定"
        onKeyDown={keyDown}
        style={{ maxHeight: height ?? '50vh' }}
      >
        <header className="ask-header">
          <strong>Pi 需要你决定</strong>
          {seconds !== undefined && (
            <small>
              {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')} 后按推荐继续
            </small>
          )}
          <button disabled={disabled || pending} onClick={() => setConfirmSkip(true)}>
            跳过
          </button>
        </header>
        <div className="ask-questions">
          {request.questions.map((question, index) => (
            <fieldset key={question.id} data-question-index={index} disabled={disabled || pending}>
              <legend>
                {request.questions.length > 1 ? `${index + 1}. ` : ''}
                {question.header}
              </legend>
              <RichText text={question.question} />
              <div className="ask-options">
                {optionsFor(question).map((option) => (
                  <label className="ask-option" key={option.label}>
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`${dialog.id}:${question.id}`}
                      checked={draft.answers[question.id].selected.includes(option.label)}
                      onChange={() => choose(question, option.label)}
                    />
                    <span>
                      <span className="ask-option-label">
                        {option.label}
                        {option.recommended && <small className="ask-recommended">推荐</small>}
                      </span>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
                <label className="ask-option">
                  <input
                    type={question.multiSelect ? 'checkbox' : 'radio'}
                    name={`${dialog.id}:${question.id}`}
                    checked={draft.answers[question.id].other !== undefined}
                    onChange={() => choose(question)}
                  />
                  <span>其他…</span>
                </label>
                {draft.answers[question.id].other !== undefined && !draft.otherOpen.includes(question.id) && (
                  <button
                    className="ask-reopen"
                    onClick={() => update({ ...draft, otherOpen: [...draft.otherOpen, question.id] })}
                  >
                    编辑其他回答
                  </button>
                )}
                {draft.otherOpen.includes(question.id) && (
                  <input
                    className="ask-other"
                    aria-label={`${question.header}：其他回答`}
                    maxLength={2000}
                    value={draft.answers[question.id].other ?? ''}
                    placeholder="请输入你的回答…"
                    onChange={(event) =>
                      update({
                        ...draft,
                        answers: {
                          ...draft.answers,
                          [question.id]: { ...draft.answers[question.id], other: event.target.value },
                        },
                      })
                    }
                  />
                )}
              </div>
            </fieldset>
          ))}
          {draft.noteOpen && (
            <label className="ask-note">
              补充说明
              <textarea
                aria-label="补充说明"
                value={draft.note}
                disabled={disabled || pending}
                onChange={(event) => update({ ...draft, note: event.target.value })}
              />
            </label>
          )}
        </div>
        <footer className="ask-footer">
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button
            disabled={disabled || pending}
            onClick={() => update({ ...draft, noteOpen: !draft.noteOpen })}
          >
            {draft.noteOpen ? '收起说明' : draft.note ? '编辑说明' : '添加说明'}
          </button>
          <button
            className="primary"
            disabled={!complete || disabled || pending}
            onClick={() => void submit({ ask: answer(draft) })}
          >
            {pending ? '正在提交…' : '提交回答'}
          </button>
        </footer>
      </section>
      {confirmSkip && (
        <Modal title="跳过这些问题？" close={() => setConfirmSkip(false)}>
          <p>Pi 将按推荐方案继续，并在回复中说明所做的假设。</p>
          <div className="dialog-actions">
            <button onClick={() => setConfirmSkip(false)}>继续回答</button>
            <button
              className="primary"
              disabled={pending || disabled}
              onClick={() => {
                setConfirmSkip(false);
                void submit({ skipped: true });
              }}
            >
              跳过问题
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
