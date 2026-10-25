export interface ProjectFileBlock {
  path: string;
  lines?: string;
  text: string;
}
export function splitUserContent(text: string): { text: string; files: ProjectFileBlock[] } {
  const start = text.indexOf('\n\n<project_file path=');
  if (start < 0) return { text, files: [] };
  const blocks = [
    ...text
      .slice(start)
      .matchAll(
        /\n\n<project_file path=("(?:[^"\\]|\\.)*")(?: lines="(\d+-\d+)")?>\n([\s\S]*?)\n<\/project_file>/g,
      ),
  ];
  if (!blocks.length || blocks.map((b) => b[0]).join('') !== text.slice(start)) return { text, files: [] };
  try {
    return {
      text: text.slice(0, start),
      files: blocks.map((b) => ({ path: JSON.parse(b[1]) as string, lines: b[2], text: b[3] })),
    };
  } catch {
    return { text, files: [] };
  }
}
