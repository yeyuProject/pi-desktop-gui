import {
  editGoalDraft,
  exitGoalCommand,
  goalCommandPreview,
  withGoalBudget,
  type GoalDraft,
} from '../../shared/goal-input';
import type { GoalSnapshot } from '../../shared/goal';
import { useEffect, useRef, useState, type RefObject, type Dispatch, type SetStateAction } from 'react';
import {
  type AppState,
  type Runtime,
  type Session,
  type Project,
  type ImageAttachment,
  type PiCommand,
} from '../../shared/types';
import { builtinCommands } from '../lib/commands';
import { commandOrder } from '../lib/commands';
import { readableError } from '../lib/format';
import { composeDraftText, moveSnippetOffsets, textBytes, type DraftSnippet } from '../lib/draft-snippets';
import { formatAttachmentSpec, parseAttachmentSpec, type AttachmentInfo } from '../../shared/attachments';
import { isImageFile, readImageFile } from '../lib/image-files';
import { imageDataBytes, MAX_IMAGE_COUNT, MAX_IMAGES_BYTES } from '../../shared/images';
import {
  composeQuotedInput,
  mergeDraftQuotes,
  truncateQuote,
  type DraftQuote,
} from '../../shared/message-content';
const api = window.desktop;
interface DraftOptions {
  state: AppState | undefined;
  stateRef: RefObject<AppState | undefined>;
  selected: Session | undefined;
  project: Project | undefined;
  runtime: Runtime;
  compact: boolean;
  inspector: boolean;
  setInspector: Dispatch<SetStateAction<boolean>>;
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setError: (value: string) => void;
  setNotice: (value: string) => void;
}
export function useDraft({
  state,
  stateRef,
  selected,
  project,
  runtime,
  compact,
  inspector,
  setInspector,
  attempt,
  setError,
  setNotice,
}: DraftOptions) {
  const [draftGoal, setDraftGoal] = useState<GoalDraft>();
  const goalDraftRef = useRef<GoalDraft>(undefined);
  const [draft, setDraft] = useState(''),
    [attachments, setAttachments] = useState<string[]>([]),
    [sendMode, setSendMode] = useState<'steer' | 'followUp'>('steer');
  const [images, setImages] = useState<ImageAttachment[]>([]),
    [commandIndex, setCommandIndex] = useState(0),
    [hideCommands, setHideCommands] = useState(false);
  const [fileQuery, setFileQuery] = useState<string | null>(null),
    [fileResults, setFileResults] = useState<string[]>([]);
  const [fileIndex, setFileIndex] = useState(0),
    [snippets, setSnippets] = useState<DraftSnippet[]>([]);
  const [draftQuotes, setDraftQuotes] = useState<DraftQuote[]>([]);
  const [attachmentInfo, setAttachmentInfo] = useState<AttachmentInfo[]>([]);
  const [inputMaxHeight, setInputMaxHeight] = useState(() =>
    Math.max(20, Math.min(55, Number(localStorage.getItem('pi.composerMaxHeight')) || 20)),
  );
  const recall = useRef(-1);
  const composerDraft = useRef({ draft, attachments, images, snippets, quotes: draftQuotes });
  const draftRevision = useRef(0);
  const savingDraft = useRef(Promise.resolve<unknown>(undefined));
  const pendingDrafts = useRef(0);
  const loadedDraft = useRef<string | undefined>(undefined);
  const imageRequest = useRef(0);
  const imageSession = useRef<string | undefined>(undefined);
  const loadingImages = useRef<{ id: string; promise: Promise<void> } | undefined>(undefined);
  const [imagesLoading, setImagesLoading] = useState<string>();
  const attachmentJobs = useRef<Record<string, number>>({});
  const [, updateAttachmentJobs] = useState(0);
  const isReadingAttachments = () =>
    Boolean(
      selected &&
      (loadedDraft.current !== selected.id ||
        imagesLoading === selected.id ||
        attachmentJobs.current[selected.id]),
    );
  const withAttachments = async (operation: () => Promise<void>) => {
    const id = selected?.id;
    if (!id) return;
    if (goalDraftRef.current?.kind === 'edit') {
      setError('请先保存或取消目标修改');
      return;
    }
    attachmentJobs.current[id] = (attachmentJobs.current[id] ?? 0) + 1;
    updateAttachmentJobs((value) => value + 1);
    try {
      if (loadingImages.current?.id === id) {
        const request = imageRequest.current;
        try {
          await loadingImages.current.promise;
        } catch {
          return;
        }
        if (stateRef.current?.selectedSessionId !== id || request !== imageRequest.current) return;
      }
      await operation();
    } finally {
      if (--attachmentJobs.current[id] === 0) delete attachmentJobs.current[id];
      updateAttachmentJobs((value) => value + 1);
    }
  };
  const input = useRef<HTMLTextAreaElement>(null),
    commandList = useRef<HTMLDivElement>(null),
    fileList = useRef<HTMLDivElement>(null);
  const commandMatch = draftGoal?.kind === 'edit' ? null : /^(\/\/?)([^\s]*)$/.exec(draft);
  const commandQuery = commandMatch?.[2].toLowerCase();
  const piOnly = commandMatch?.[1] === '//';
  const allCommands: (PiCommand & { prefix: string })[] = [
    ...(piOnly
      ? []
      : builtinCommands.filter((c) => project || c.name !== 'trust').map((c) => ({ ...c, prefix: '/' }))),
    ...(piOnly
      ? []
      : [
          {
            name: 'goal',
            description: '持续执行目标；edit、status、pause、resume、clear',
            source: 'desktop' as const,
            prefix: '/',
          },
        ]),
    ...runtime.commands
      .filter((c) => piOnly || c.name !== 'goal')
      .map((c) => ({
        ...c,
        prefix: piOnly || builtinCommands.some((b) => b.name === c.name) ? '//' : '/',
      })),
  ];
  const commandOptions =
    commandQuery !== undefined && !hideCommands
      ? allCommands
          .filter(
            (c) =>
              c.name.toLowerCase().includes(commandQuery) ||
              (commandQuery.length > 1 && (c.description ?? '').toLowerCase().includes(commandQuery)),
          )
          .sort(
            (a, b) =>
              commandOrder.indexOf(a.source) - commandOrder.indexOf(b.source) ||
              Number(!a.name.toLowerCase().startsWith(commandQuery)) -
                Number(!b.name.toLowerCase().startsWith(commandQuery)),
          )
          .slice(0, 40)
      : [];
  const typedCommand = draftGoal?.kind === 'edit' ? null : /^(\/\/?)(\S+)(?:\s|$)/.exec(draft);
  const activeCommand = typedCommand
    ? allCommands.find((c) => c.prefix === typedCommand[1] && c.name === typedCommand[2])
    : undefined;
  const completeCommand = (c: PiCommand & { prefix: string }) => {
    if (c.name === 'goal' && c.prefix === '/') {
      persistDraft('');
      openGoalComposer();
    } else persistDraft(c.prefix + c.name + ' ');
    setHideCommands(true);
    input.current?.focus();
  };
  const persistDraft = (
    value: string,
    files = attachments,
    pictures = images,
    pieces = moveSnippetOffsets(composerDraft.current.draft, value, composerDraft.current.snippets),
    quotes = composerDraft.current.quotes,
  ) => {
    if (!selected || stateRef.current?.selectedSessionId !== selected.id) return;
    if (goalDraftRef.current?.kind === 'edit') {
      setError('请先保存或取消目标修改');
      return;
    }
    draftRevision.current++;
    const picturesChanged = pictures !== composerDraft.current.images;
    if (picturesChanged) {
      imageRequest.current++;
      loadingImages.current = undefined;
      setImagesLoading(undefined);
    }
    composerDraft.current = { draft: value, attachments: files, images: pictures, snippets: pieces, quotes };
    setDraft(value);
    setAttachments(files);
    setImages(pictures);
    setSnippets(pieces);
    setDraftQuotes(quotes);
    pendingDrafts.current++;
    savingDraft.current = attempt(() =>
      api.invoke(
        'saveDraft',
        selected.id,
        value,
        files,
        picturesChanged ? pictures : undefined,
        pieces,
        quotes,
      ),
    ).finally(() => {
      pendingDrafts.current--;
    });
  };
  const persistDraftGoal = (value: GoalDraft | undefined) => {
    if (!selected || stateRef.current?.selectedSessionId !== selected.id) return;
    draftRevision.current++;
    goalDraftRef.current = value;
    setDraftGoal(value);
    pendingDrafts.current++;
    savingDraft.current = attempt(() => api.invoke('saveDraftGoal', selected.id, value ?? null)).finally(
      () => {
        pendingDrafts.current--;
      },
    );
  };
  const exitGoalMode = () => {
    const current = goalDraftRef.current;
    persistDraftGoal(current?.kind === 'edit' ? current.restore : undefined);
    if (current?.kind !== 'edit' && goalCommandPreview(composerDraft.current.draft))
      persistDraft(exitGoalCommand(composerDraft.current.draft));
    setHideCommands(true);
    setFileQuery(null);
    focusComposer();
  };
  const openGoalComposer = (replace = false) => {
    if (!selected) return;
    if (!replace && (goalDraftRef.current || goalCommandPreview(composerDraft.current.draft)?.objective)) {
      exitGoalMode();
      return;
    }
    const goal = runtime.sessionId === selected.id ? runtime.goal : undefined;
    if (!replace && goal && goal.status !== 'completed')
      void attempt(() => api.invoke('openGoal', selected.id));
    else persistDraftGoal({ kind: 'start' });
    setHideCommands(true);
    focusComposer();
  };
  const editGoal = (goal: GoalSnapshot) => {
    if (goalDraftRef.current?.kind === 'edit') {
      focusComposer();
      return;
    }
    persistDraftGoal(editGoalDraft(goal, goalDraftRef.current));
    setHideCommands(true);
    setFileQuery(null);
    focusComposer();
  };
  const setGoalBudget = (tokenBudget?: number) => {
    if (goalCommandPreview(composerDraft.current.draft))
      persistDraft(withGoalBudget(composerDraft.current.draft, tokenBudget));
    persistDraftGoal({ kind: 'start', tokenBudget });
  };
  const flushDraft = async () => {
    // invoke calls from this renderer are ordered. Flush the accepted save now,
    // before waiting for its acknowledgment, rather than waiting out the debounce.
    if (pendingDrafts.current) await api.invoke('flushDraft');
    await savingDraft.current;
  };
  const composeDraft = (body = composerDraft.current.draft) =>
    composeQuotedInput(
      composeDraftText(
        body,
        moveSnippetOffsets(composerDraft.current.draft, body, composerDraft.current.snippets),
      ),
      composerDraft.current.quotes,
    );
  const addQuote = (quote: DraftQuote) => {
    const current = composerDraft.current;
    const added = truncateQuote(quote);
    persistDraft(
      current.draft,
      current.attachments,
      current.images,
      current.snippets,
      mergeDraftQuotes(current.quotes, [added]),
    );
    focusComposer();
  };
  const removeQuote = (id: string) => {
    const current = composerDraft.current;
    persistDraft(
      current.draft,
      current.attachments,
      current.images,
      current.snippets,
      current.quotes.filter((quote) => quote.id !== id),
    );
  };
  const pasteText = (
    text: string,
    start = input.current?.selectionStart ?? draft.length,
    end = input.current?.selectionEnd ?? start,
  ) => {
    const value = draft.slice(0, start) + draft.slice(end);
    const pieces = moveSnippetOffsets(draft, value, snippets);
    // Stable array order preserves repeated pastes at the same caret position.
    persistDraft(value, attachments, images, [...pieces, { id: crypto.randomUUID(), text, offset: start }]);
    requestAnimationFrame(() => input.current?.setSelectionRange(start, start));
  };
  const removeSnippet = (id: string) =>
    persistDraft(
      draft,
      attachments,
      images,
      snippets.filter((snippet) => snippet.id !== id),
    );
  const expandSnippet = (id: string) => {
    const snippet = snippets.find((item) => item.id === id);
    if (!snippet) return;
    const value = draft.slice(0, snippet.offset) + snippet.text + draft.slice(snippet.offset);
    const index = snippets.indexOf(snippet);
    const pieces = snippets
      .filter((item) => item.id !== id)
      .map((item) => ({
        ...item,
        offset:
          item.offset > snippet.offset || (item.offset === snippet.offset && snippets.indexOf(item) > index)
            ? item.offset + snippet.text.length
            : item.offset,
      }));
    persistDraft(value, attachments, images, pieces);
    focusComposer();
  };
  const mergeDraftAttachments = (
    id: string,
    files: string[],
    pictures: ImageAttachment[],
    clearReference = false,
  ) => {
    if (stateRef.current?.selectedSessionId !== id) return false;
    const latest = composerDraft.current;
    if (latest.images.length + pictures.length > MAX_IMAGE_COUNT)
      throw new Error('每条消息最多添加 8 张图片');
    const nextImages = [...latest.images, ...pictures];
    if (nextImages.reduce((total, image) => total + imageDataBytes(image.data), 0) > MAX_IMAGES_BYTES)
      throw new Error('附件总大小不能超过 16 MiB');
    persistDraft(
      clearReference ? latest.draft.replace(/(^|\s)@[^\s@]*$/, '$1') : latest.draft,
      [...new Set([...latest.attachments, ...files])],
      nextImages,
    );
    return true;
  };
  const onDraft = (value: string) => {
    recall.current = -1;
    if (goalDraftRef.current?.kind === 'edit') {
      persistDraftGoal({ ...goalDraftRef.current, objective: value });
      return;
    }
    persistDraft(value);
    setHideCommands(false);
    setCommandIndex(0);
    setFileIndex(0);
    const match = value.match(/(?:^|\s)@([^\s@]*)$/);
    setFileQuery(project && match ? match[1] : null);
  };
  const focusComposer = () => {
    if (compact && inspector) setInspector(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  async function addAttachment(name: string) {
    if (!project || !selected) return;
    const id = selected.id;
    const normalized = await attempt(async () => {
      const typed = fileQuery ? parseAttachmentSpec(fileQuery) : undefined;
      const spec = parseAttachmentSpec(name);
      const value = formatAttachmentSpec(
        typed?.startLine !== undefined && spec.startLine === undefined
          ? { path: spec.path, startLine: typed.startLine, endLine: typed.endLine }
          : spec,
      );
      const image =
        spec.startLine === undefined && typed?.startLine === undefined
          ? await api.invoke('projectImage', project.id, spec.path)
          : null;
      if (!image) await api.invoke('attachmentInfo', project.id, [value]);
      return { value, image };
    });
    if (!normalized || stateRef.current?.selectedSessionId !== id) return;
    await attempt(async () =>
      mergeDraftAttachments(
        id,
        normalized.image ? [] : [normalized.value],
        normalized.image ? [normalized.image] : [],
        true,
      ),
    );
    setFileQuery(null);
    focusComposer();
  }
  async function readImages(files: File[]): Promise<ImageAttachment[]> {
    if (files.length + composerDraft.current.images.length > MAX_IMAGE_COUNT)
      throw new Error('每条消息最多添加 8 张图片');
    return Promise.all(files.map(readImageFile));
  }
  async function chooseImages() {
    if (!selected) return;
    await attempt(async () => {
      const picked = await api.invoke('pickImages');
      if (picked.length) mergeDraftAttachments(selected.id, [], picked);
    });
  }
  async function acceptDrop(files: File[]) {
    if (!selected) return;
    const classified = await attempt(() =>
      Promise.all(files.map(async (file) => ({ file, image: await isImageFile(file) }))),
    );
    if (!classified || stateRef.current?.selectedSessionId !== selected.id) return;
    const pictures = classified.filter((item) => item.image).map((item) => item.file);
    const others = classified.filter((item) => !item.image).map((item) => item.file);
    const nextImages = pictures.length ? await attempt(() => readImages(pictures)) : [];
    let nextFiles: string[] = [];
    if (others.length) {
      if (!project) {
        setError('独立对话不能引用本地文件；打开项目后可拖入项目内的文本文件');
      } else {
        await attempt(async () => {
          const paths = others.map((f) => api.pathForFile(f)).filter(Boolean);
          const { accepted, rejected } = await api.invoke('referenceDropped', project.id, paths);
          if (stateRef.current?.selectedSessionId !== selected.id) return;
          nextFiles = accepted;
          if (accepted.length) setNotice(`已引用 ${accepted.length} 个文件`);
          if (rejected.length)
            setError(
              `${rejected.slice(0, 3).join('、')}${rejected.length > 3 ? ` 等 ${rejected.length} 个文件` : ''} 无法引用：只支持项目内 256 KiB 以内的文本文件`,
            );
        });
      }
    }
    if (stateRef.current?.selectedSessionId !== selected.id) return;
    if (nextImages?.length || nextFiles.length)
      await attempt(async () => mergeDraftAttachments(selected.id, nextFiles, nextImages ?? []));
    focusComposer();
  }
  composerDraft.current = { draft, attachments, images, snippets, quotes: draftQuotes };
  useEffect(() => {
    const textarea = input.current;
    if (!textarea) return;
    const resize = () => {
      textarea.style.height = '0px';
      textarea.style.height =
        Math.min(textarea.scrollHeight, (window.innerHeight * inputMaxHeight) / 100) + 'px';
      textarea.style.maxHeight = inputMaxHeight + 'vh';
    };
    resize();
    const observer = new ResizeObserver(resize);
    // Observe the container so wrapping changes also resize the input.
    observer.observe(textarea.parentElement!);
    return () => observer.disconnect();
  }, [draft, draftGoal, inputMaxHeight, state?.settings.fontScale, Boolean(state)]);
  useEffect(() => {
    localStorage.setItem('pi.composerMaxHeight', String(inputMaxHeight));
  }, [inputMaxHeight]);
  useEffect(() => {
    if (!selected) return;
    if (pendingDrafts.current && selected.id === loadedDraft.current) return;
    loadedDraft.current = selected.id;
    composerDraft.current = {
      ...composerDraft.current,
      draft: selected.draft,
      attachments: selected.attachments,
      snippets: selected.draftSnippets ?? [],
      quotes: selected.draftQuotes ?? [],
    };
    goalDraftRef.current = selected.draftGoal;
    setDraftGoal(selected.draftGoal);
    setDraft(selected.draft);
    setAttachments(selected.attachments);
    setSnippets(selected.draftSnippets ?? []);
    setDraftQuotes(selected.draftQuotes ?? []);
  }, [
    selected?.id,
    selected?.draft,
    selected?.draftGoal,
    selected?.attachments.join('|'),
    selected?.draftSnippets,
    selected?.draftQuotes,
  ]);
  // Text/state broadcasts must not cancel an in-flight image read. A separate
  // effect owns image identity; its result merges into the latest typed draft.
  useEffect(() => {
    if (!selected) return;
    if (pendingDrafts.current && selected.id === imageSession.current) return;
    const currentImages = composerDraft.current.images;
    const sameImages =
      imageSession.current === selected.id &&
      currentImages.length === (selected.images?.length ?? 0) &&
      currentImages.every((image, index) => image.id === selected.images?.[index].id);
    imageSession.current = selected.id;
    const request = ++imageRequest.current;
    const inline = (selected.images ?? []).every((image) => typeof image.data === 'string');
    const pictures = sameImages
      ? currentImages
      : inline
        ? ((selected.images ?? []) as ImageAttachment[])
        : [];
    composerDraft.current = { ...composerDraft.current, images: pictures };
    setImages(pictures);
    setImagesLoading(inline || sameImages ? undefined : selected.id);
    loadingImages.current = undefined;
    if (!inline && !sameImages) {
      let active = true;
      const promise = api
        .invoke('readDraftImages', selected.id)
        .then((loaded) => {
          if (
            !active ||
            request !== imageRequest.current ||
            stateRef.current?.selectedSessionId !== selected.id
          )
            return;
          composerDraft.current = { ...composerDraft.current, images: loaded };
          setImages(loaded);
          setImagesLoading(undefined);
          loadingImages.current = undefined;
        })
        .catch((error) => {
          if (active && request === imageRequest.current) setError(readableError(error));
          throw error;
        });
      loadingImages.current = { id: selected.id, promise };
      void promise.catch(() => {});
      return () => {
        active = false;
      };
    }
  }, [selected?.id, selected?.images?.map((i) => i.id).join('|')]);
  useEffect(() => {
    setFileResults([]);
    setFileIndex(0);
    if (!project || fileQuery === null) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .invoke('searchFiles', project.id, fileQuery.replace(/(?:#L|:)\d.*$/, ''))
        .then((v) => {
          if (alive) {
            setFileResults(v);
            setFileIndex(0);
          }
        })
        .catch((e) => setError(readableError(e)));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [project?.id, fileQuery]);
  useEffect(() => {
    let alive = true;
    setAttachmentInfo([]);
    if (!project || !attachments.length) return;
    void api
      .invoke('attachmentInfo', project.id, attachments)
      .then((info) => {
        if (alive) setAttachmentInfo(info);
      })
      .catch((error) => {
        if (alive) setError(readableError(error));
      });
    return () => {
      alive = false;
    };
  }, [project?.id, attachments.join('|')]);
  useEffect(() => {
    commandList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [commandIndex]);
  useEffect(() => {
    fileList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [fileIndex]);
  return {
    draft: draftGoal?.kind === 'edit' ? draftGoal.objective : draft,
    draftGoal,
    openGoalComposer,
    exitGoalMode,
    editGoal,
    setGoalBudget,
    persistDraftGoal,
    attachments,
    images,
    sendMode,
    setSendMode,
    fileQuery,
    setFileQuery,
    fileResults,
    fileIndex,
    setFileIndex,
    fileList,
    snippets,
    draftQuotes,
    addQuote,
    removeQuote,
    pasteText,
    expandSnippet,
    removeSnippet,
    composeDraft,
    attachmentInfo,
    attachmentBytes:
      textBytes(composeQuotedInput(composeDraftText(draft, snippets), draftQuotes)) +
      attachmentInfo.reduce((total, info) => total + info.bytes, 0),
    inputMaxHeight,
    setInputMaxHeight,
    setFileResults,
    commandIndex,
    setCommandIndex,
    hideCommands,
    setHideCommands,
    recall,
    input,
    commandList,
    commandOptions,
    activeCommand,
    completeCommand,
    persistDraft,
    flushDraft,
    getDraftRevision: () => draftRevision.current,
    onDraft,
    focusComposer,
    attachmentsPending: isReadingAttachments(),
    isReadingAttachments,
    addAttachment: (name: string) => withAttachments(() => addAttachment(name)),
    chooseImages: () => withAttachments(chooseImages),
    acceptDrop: (files: File[]) => withAttachments(() => acceptDrop(files)),
  };
}
