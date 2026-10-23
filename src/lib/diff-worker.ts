import { createTwoFilesPatch } from 'diff';
import { alignHunk, parseDiffHunks } from '../../shared/diff';

self.onmessage = ({
  data,
}: MessageEvent<{
  patch: string;
  path?: string;
  before?: string;
  after?: string;
  full: boolean;
}>) => {
  try {
    const patch =
      data.full && data.before !== undefined && data.after !== undefined
        ? createTwoFilesPatch(data.path ?? '', data.path ?? '', data.before, data.after, '', '', {
            context: Number.MAX_SAFE_INTEGER,
            timeout: 5000,
          })
        : data.patch;
    if (patch === undefined) throw new Error('差异计算耗时过长，请在编辑器中查看完整内容');
    self.postMessage({ aligned: parseDiffHunks(patch).map((hunk) => ({ hunk, rows: alignHunk(hunk) })) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : '无法显示差异，请重试' });
  }
};
