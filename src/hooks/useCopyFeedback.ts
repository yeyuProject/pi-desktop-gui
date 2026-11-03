import { useEffect, useRef, useState } from 'react';

export function useCopyFeedback() {
  const [copied, setCopied] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (action: () => unknown | Promise<unknown>) => {
    const token = ++request.current;
    setFailed(false);
    try {
      if ((await action()) === false) {
        if (token === request.current) {
          setCopied(0);
          setFailed(true);
        }
        return false;
      }
      if (token !== request.current) return false;
      setCopied((value) => value + 1);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(0), 1500);
      return true;
    } catch {
      if (token === request.current) {
        setCopied(0);
        setFailed(true);
      }
      return false;
    }
  };
  return { copied, failed, copy };
}
