import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { composeDraftText } from '../../shared/draft';
import { readGoalDraft } from '../../shared/goal-input';
import { isDraftQuote } from '../../shared/message-content';
import { readImageAttachment, validateImages } from '../images';
import { openTextEditor } from '../platform';
import type { HandlerContext, HandlerMap } from './handler-context';

interface DraftHandlerContext extends Pick<
  HandlerContext,
  'store' | 'text' | 'strings' | 'save' | 'showAppDialog'
> {
  window: BrowserWindow | undefined;
  protectSessionOperation: (method: string, args: unknown[]) => Promise<void> | undefined;
}
export type DraftHandlerName =
  | 'saveDraft'
  | 'saveDraftGoal'
  | 'flushDraft'
  | 'consumeDraft'
  | 'saveView'
  | 'readDraftImages'
  | 'pickImages'
  | 'editDraft';
export function createDraftHandlers(context: DraftHandlerContext) {
  const { store, save, showAppDialog, protectSessionOperation } = context;
  const text: HandlerContext['text'] = context.text;
  const strings: HandlerContext['strings'] = context.strings;

  const handlers: HandlerMap<DraftHandlerName> = {
    saveDraft: async (id, draft, attachments, images, snippets, quotes) => {
      text(id, 100);
      text(draft);
      strings(attachments);
      if (snippets !== undefined) {
        if (!Array.isArray(snippets) || snippets.length > 1000) throw new Error('粘贴片段格式无效');
        const ids = new Set<string>();
        for (const snippet of snippets) {
          text(snippet?.id, 100);
          text(snippet?.text);
          if (!snippet.id || ids.has(snippet.id)) throw new Error('粘贴片段标识重复，请展开后重新编辑');
          ids.add(snippet.id);
          if (!Number.isSafeInteger(snippet.offset) || snippet.offset < 0 || snippet.offset > draft.length)
            throw new Error('粘贴片段的位置无效，请展开后重新编辑');
        }
      }
      if (images !== undefined) validateImages(images);
      if (quotes !== undefined && (!Array.isArray(quotes) || !quotes.every(isDraftQuote)))
        throw new Error('引用内容无效，请移除后重新引用');
      const s = store.session(id);
      if (draft || attachments.length || images?.length || snippets?.length || quotes?.length)
        store.promoteSession(id);
      s.draft = draft;
      s.attachments = attachments;
      if (snippets !== undefined) s.draftSnippets = snippets;
      if (quotes !== undefined) s.draftQuotes = quotes;
      if (images !== undefined) s.images = images;
      await store.scheduleSave();
    },
    saveDraftGoal: async (id, value) => {
      text(id, 100);
      const draft = readGoalDraft(value);
      if (value !== null && !draft) throw new Error('Goal 草稿格式无效');
      const session = store.session(id);
      if (draft) store.promoteSession(id);
      session.draftGoal = draft;
      await store.scheduleSave();
    },
    flushDraft: () => store.flush(),
    consumeDraft: async (id, expected, attachments, images) => {
      text(id, 100);
      text(expected);
      strings(attachments);
      validateImages(images);
      const s = store.session(id);
      if (store.matchesDraft(s, expected, attachments, images)) {
        if (
          s.draft ||
          s.attachments.length ||
          s.images?.length ||
          s.draftSnippets?.length ||
          s.draftQuotes?.length
        )
          store.promoteSession(id);
        s.draft = '';
        s.attachments = [];
        s.images = [];
        s.draftSnippets = [];
        s.draftQuotes = [];
        await save();
      }
    },
    saveView: async (id, scrollTop, expanded) => {
      text(id, 100);
      strings(expanded);
      if (!Number.isFinite(scrollTop)) return;
      const s = store.session(id);
      s.scrollTop = Math.max(0, scrollTop);
      s.expandedTools = expanded.slice(-1000);
      await store.save();
    },
    readDraftImages: (id) => {
      text(id, 100);
      return store.draftImages(id);
    },
    pickImages: async () => {
      const picked = await dialog.showOpenDialog(context.window!, {
        title: '添加图片',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (picked.canceled) return [];
      if (picked.filePaths.length > 8) throw new Error('最多选择 8 张图片');
      const images = await Promise.all(
        picked.filePaths.map(async (file) => {
          const image = await readImageAttachment(file);
          if (!image) throw new Error('支持 PNG、JPEG、WebP、GIF 图片');
          return image;
        }),
      );
      validateImages(images);
      return images;
    },
    editDraft: async (id) => {
      text(id, 100);
      await protectSessionOperation('editDraft', [id]);
      const s = store.session(id);
      if (s.draftGoal?.kind === 'edit') throw new Error('请先保存或取消目标修改，再编辑普通草稿');
      const original = JSON.stringify([s.draft, s.draftSnippets ?? []]);
      const file = path.join(store.dir, 'draft-' + encodeURIComponent(id) + '.txt');
      await fs.writeFile(file, composeDraftText(s.draft, s.draftSnippets ?? []), 'utf8');
      await openTextEditor(file, store.state.settings.editorPath || undefined);
      const result = await showAppDialog({
        type: 'info',
        message: '在外部编辑器中编辑草稿',
        detail: '编辑并保存文件后，点击“导入已保存内容”。',
        buttons: ['取消', '导入已保存内容'],
        defaultId: 1,
        cancelId: 0,
      });
      if (result.response !== 1) return;
      const content = await fs.readFile(file, 'utf8');
      text(content);
      const current = store.session(id);
      if (JSON.stringify([current.draft, current.draftSnippets ?? []]) !== original)
        throw new Error('草稿在外部编辑期间已变化，未覆盖当前内容。外部编辑结果仍保存在：' + file);
      current.draft = content;
      current.draftSnippets = [];
      await save();
    },
  };
  return handlers;
}
