export const DESKTOP_ASK_TOOL = 'desktop_ask_user';

export interface AskOption {
  label: string;
  description?: string;
  recommended?: boolean;
}
export interface AskQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}
export interface AskRequest {
  questions: AskQuestion[];
}
export interface AskSelection {
  selected: string[];
  other?: string;
}
export type AskAnswer =
  | { status: 'answered'; answers: Record<string, AskSelection>; note?: string }
  | { status: 'timeout_recommended'; answers: Record<string, AskSelection> }
  | { status: 'skipped' | 'cancelled' };
export type AskDetails = AskRequest & AskAnswer;
export const askStatusLabels: Record<AskAnswer['status'], string> = {
  answered: '已回答',
  skipped: '已跳过',
  timeout_recommended: '超时按推荐',
  cancelled: '已取消',
};

export function askSelectionText(details: AskDetails, question: AskQuestion): string {
  if (!('answers' in details)) return askStatusLabels[details.status];
  const answer = Object.hasOwn(details.answers, question.id) ? details.answers[question.id] : undefined;
  return answer
    ? [...answer.selected, ...(answer.other === undefined ? [] : [answer.other])].join('、')
    : '已跳过';
}

export function askHistoryText(details: AskDetails): string {
  return [
    `Pi 提问 · ${askStatusLabels[details.status]}`,
    ...details.questions.flatMap((question) => [
      question.header,
      question.question,
      askSelectionText(details, question),
    ]),
    ...('note' in details && details.note ? [`补充说明：${details.note}`] : []),
  ].join('\n');
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number) =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function validateAskRequest(value: unknown): asserts value is AskRequest {
  if (
    !object(value) ||
    !only(value, ['questions']) ||
    !Array.isArray(value.questions) ||
    value.questions.length < 1 ||
    value.questions.length > 3
  )
    throw new Error('一次需要提供 1–3 个问题。');
  const ids = new Set<string>();
  for (const question of value.questions) {
    if (
      !object(question) ||
      !only(question, ['id', 'header', 'question', 'multiSelect', 'options']) ||
      !text(question.id, 64) ||
      !text(question.header, 24) ||
      !text(question.question, 2000) ||
      (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean') ||
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > 6
    )
      throw new Error('问题需要有效标识、简短标签、正文，以及 2–6 个选项。');
    const id = question.id as string;
    if (ids.has(id)) throw new Error('问题标识不能重复。');
    ids.add(id);
    const labels = new Set<string>();
    let recommended = 0;
    for (const option of question.options) {
      if (
        !object(option) ||
        !only(option, ['label', 'description', 'recommended']) ||
        !text(option.label, 60) ||
        (option.description !== undefined &&
          (typeof option.description !== 'string' || option.description.length > 200)) ||
        (option.recommended !== undefined && typeof option.recommended !== 'boolean')
      )
        throw new Error('选项名称最多 60 字，说明最多 200 字。');
      const label = (option.label as string).trim();
      if (labels.has(label) || ['其他', '其他…', '其他...'].includes(label))
        throw new Error('选项名称不能重复；“其他”由回答面板自动提供。');
      labels.add(label);
      if (option.recommended && ++recommended > 1) throw new Error('每个问题最多只能推荐一个选项。');
    }
  }
}

/** A composer reply answers the first question with text and explicitly skips the rest. */
export function answerAskWithText(request: AskRequest, value: string): AskAnswer {
  if (!text(value, 2000)) throw new Error('请填写回答，最多 2000 字。');
  return { status: 'answered', answers: { [request.questions[0].id]: { selected: [], other: value } } };
}

export function validateAskAnswer(request: AskRequest, value: unknown): asserts value is AskAnswer {
  if (!object(value)) throw new Error('回答格式无效，请重新选择。');
  if (value.status === 'skipped' || value.status === 'cancelled') {
    if (!only(value, ['status'])) throw new Error('跳过或取消时不能同时提交回答。');
    return;
  }
  if (
    !['answered', 'timeout_recommended'].includes(String(value.status)) ||
    !only(value, ['status', 'answers', ...(value.status === 'answered' ? ['note'] : [])]) ||
    !object(value.answers) ||
    (value.note !== undefined && typeof value.note !== 'string')
  )
    throw new Error('回答格式无效，请重新选择。');
  const answers = value.answers;
  const keys = Object.keys(answers);
  const first = answers[request.questions[0].id];
  const composerReply =
    value.status === 'answered' &&
    keys.length === 1 &&
    keys[0] === request.questions[0].id &&
    object(first) &&
    Array.isArray(first.selected) &&
    first.selected.length === 0 &&
    text(first.other, 2000);
  if (
    keys.some((id) => !request.questions.some((question) => question.id === id)) ||
    (!composerReply && keys.length !== request.questions.length)
  )
    throw new Error('请回答所有问题后再提交。');
  for (const question of request.questions) {
    if (!Object.hasOwn(answers, question.id)) continue;
    const answer = answers[question.id];
    if (
      !object(answer) ||
      !only(answer, ['selected', 'other']) ||
      !Array.isArray(answer.selected) ||
      answer.selected.some(
        (label) => typeof label !== 'string' || !question.options.some((option) => option.label === label),
      ) ||
      new Set(answer.selected).size !== answer.selected.length ||
      (answer.other !== undefined && !text(answer.other, 2000))
    )
      throw new Error('请使用题目中的选项；其他回答最多 2000 字。');
    const count = answer.selected.length + (answer.other === undefined ? 0 : 1);
    if (count < 1 || (!question.multiSelect && count !== 1))
      throw new Error(
        question.multiSelect ? '请至少选择一项或填写其他回答。' : '单选问题只能选择一项或填写其他回答。',
      );
  }
}

export function recommendedAnswers(request: AskRequest): Record<string, AskSelection> {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      {
        selected: [(question.options.find((option) => option.recommended) ?? question.options[0]).label],
      },
    ]),
  );
}

export function formatAskResult(answer: AskAnswer): string {
  const instruction =
    answer.status === 'skipped'
      ? '用户跳过了这些问题，请按你推荐的方案继续，并在最终回复中说明你做的假设。'
      : answer.status === 'timeout_recommended'
        ? '用户未在 10 分钟内回答，已按推荐项继续。请在最终回复中说明你做的假设。'
        : answer.status === 'cancelled'
          ? '已取消。'
          : '已收到用户回答。未包含回答的问题按跳过处理，请说明所做的假设。';
  return `${instruction}\n${JSON.stringify(answer)}`;
}

export function readAskDetails(value: unknown): AskDetails | undefined {
  if (!object(value)) return;
  const { questions, ...answer } = value;
  const request = { questions };
  try {
    validateAskRequest(request);
    validateAskAnswer(request, answer);
    return { ...request, ...answer };
  } catch {
    return;
  }
}
