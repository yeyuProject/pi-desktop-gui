import { Check, Copy, AlertCircle } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { useCopyFeedback } from '../hooks/useCopyFeedback';

export function CopyButton({
  copy,
  title,
  label,
  className = '',
  iconOnly = false,
  disabled = false,
  children,
  preventDefault = false,
}: {
  copy: () => unknown | Promise<unknown>;
  title: string;
  label?: string;
  className?: string;
  iconOnly?: boolean;
  disabled?: boolean;
  children?: ReactNode;
  preventDefault?: boolean;
}) {
  const feedback = useCopyFeedback();
  return (
    <button
      className={(iconOnly ? 'icon-button ' : '') + className + ' copy-feedback'}
      title={feedback.failed ? '复制失败，请重试' : title}
      aria-label={
        feedback.failed
          ? '复制失败，请重试'
          : feedback.copied
            ? `${label ?? title}，已复制`
            : (label ?? title)
      }
      data-copied={feedback.copied || undefined}
      data-copy-failed={feedback.failed || undefined}
      disabled={disabled}
      onClick={(event: MouseEvent) => {
        if (preventDefault) event.preventDefault();
        void feedback.copy(copy);
      }}
    >
      <span className="copy-feedback-icon" aria-hidden="true" key={feedback.copied}>
        {feedback.failed ? (
          <AlertCircle size={13} />
        ) : feedback.copied ? (
          <Check size={13} />
        ) : (
          <Copy size={13} />
        )}
      </span>
      {!iconOnly && (feedback.copied ? '已复制' : (children ?? title))}
    </button>
  );
}
