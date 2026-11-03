import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { NOTICE_EXIT_MS } from '../lib/notice-store';

/** Retains the last error until its exit transition ends, including with reduced motion enabled. */
export function ErrorFeedback({
  message,
  as: Tag = 'p',
  className = 'inline-error',
  children,
  ...attributes
}: {
  message?: string | false;
  as?: 'p' | 'div';
  children?: (text: string) => ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'children'>) {
  const [retained, setRetained] = useState(message);
  const hasRetained = Boolean(retained);
  useEffect(() => {
    if (message) {
      setRetained(message);
      return;
    }
    if (!hasRetained) return;
    const timer = setTimeout(() => setRetained(undefined), NOTICE_EXIT_MS);
    return () => clearTimeout(timer);
  }, [message, hasRetained]);
  const text = message || retained;
  if (!text) return null;
  return (
    <Tag role="alert" {...attributes} className={className} data-leaving={!message || undefined}>
      {children ? children(text) : text}
    </Tag>
  );
}
