import type { ImageAttachment, Session } from './types';
import { composeQuotedInput } from './message-content';
export interface DraftSnippet {
  id: string;
  text: string;
  offset: number;
}
/** A sent snapshot may consume only the exact draft, including attachments. */
export function matchesDraft(
  session: Session,
  text: string,
  attachments: string[],
  images: ImageAttachment[],
) {
  const current = session.images ?? [];
  return (
    composeQuotedInput(
      composeDraftText(session.draft, session.draftSnippets ?? []),
      session.draftQuotes ?? [],
    ) === text &&
    session.attachments.length === attachments.length &&
    session.attachments.every((file, index) => file === attachments[index]) &&
    current.length === images.length &&
    current.every((image, index) => {
      const other = images[index];
      return (
        image.id === other.id &&
        image.name === other.name &&
        image.mimeType === other.mimeType &&
        (image.data !== undefined
          ? image.data === other.data
          : image.file === (other as ImageAttachment & { file?: string }).file)
      );
    })
  );
}
export function composeDraftText(draft: string, snippets: DraftSnippet[]): string {
  let result = '',
    offset = 0;
  for (const snippet of [...snippets].sort((a, b) => a.offset - b.offset)) {
    const position = Math.max(offset, Math.min(draft.length, snippet.offset));
    result += draft.slice(offset, position) + snippet.text;
    offset = position;
  }
  return result + draft.slice(offset);
}
/** Keep collapsed pastes anchored when ordinary text is edited before or around them. */
export function moveSnippetOffsets(before: string, after: string, snippets: DraftSnippet[]): DraftSnippet[] {
  let start = 0,
    endBefore = before.length,
    endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const delta = after.length - before.length;
  return snippets.map((snippet) => ({
    ...snippet,
    offset:
      snippet.offset <= start
        ? snippet.offset
        : snippet.offset >= endBefore
          ? snippet.offset + delta
          : endAfter,
  }));
}
export const textBytes = (text: string) => new TextEncoder().encode(text).length;
export const textLines = (text: string) => text.split(/\r\n|\n|\r/).length;
export const shouldCollapsePaste = (text: string, draft: string) =>
  !draft.trimStart().startsWith('/') && (textLines(text) > 30 || textBytes(text) > 4096);
