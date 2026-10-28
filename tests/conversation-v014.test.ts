import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parseAnsi, stripAnsi } from '../shared/ansi';
import { composeDraftText, moveSnippetOffsets, shouldCollapsePaste, textBytes } from '../shared/draft';
import {
  groupConversation,
  conversationTurns,
  hideRecoveredErrors,
  turnTitle,
} from '../src/lib/conversation-layout';
import { SessionSearch } from '../src/lib/session-search';
import { parseArgumentHint, parsePromptArguments, formatPromptArguments } from '../src/lib/prompt-arguments';
import { tokenizeCode } from '../src/lib/code-tokens';
import { splitUserContent } from '../src/lib/message-content';
import type { Message, ToolActivity } from '../shared/types';
import { parseCommandArgs } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js';
import { parseSkillBlock } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js';

test('turn titles remove native file attachments and show the user message from a native skill invocation', () => {
  const skill = '<skill name="review" location="/fixture/SKILL.md">\nSkill instructions\n</skill>';
  const userMessage = '# 检查接口\n\n> 保留字段\n- 修复测试\n  1. 补充说明';
  const native = `${skill}\n\n${userMessage}`;
  assert.equal(parseSkillBlock(native)?.userMessage, userMessage);
  const message: Message = {
    role: 'user',
    content: `${native}\n\n<project_file path="src/api.ts" lines="1-4">\nignored source\n</project_file>`,
  };
  assert.deepEqual(turnTitle(message), {
    title: '检查接口 保留字段 修复测试 补充说明',
    tooltip: '检查接口 保留字段 修复测试 补充说明',
    skillName: 'review',
  });
  assert.deepEqual(turnTitle({ role: 'user', content: skill }), {
    title: '使用技能 review',
    tooltip: '使用技能 review',
    skillName: 'review',
  });
  assert.equal(
    message.content,
    `${native}\n\n<project_file path="src/api.ts" lines="1-4">\nignored source\n</project_file>`,
  );
});

test('turn title skill recognition follows Pi parseSkillBlock instead of guessing alternate formats', () => {
  const candidates = [
    '<skill name="check" location="/skill.md">\nBody\n</skill>',
    '<skill name="check" location="/skill.md">\nBody\n</skill>\n\nAdditional message',
    "<skill name='check' location='/skill.md'>\nBody\n</skill>",
    '<skill location="/skill.md" name="check">\nBody\n</skill>',
    '<skill name="check" location="/skill.md">Body</skill>',
    '<skill name="check" location="/skill.md">\r\nBody\r\n</skill>',
  ];
  for (const content of candidates) {
    const native = parseSkillBlock(content);
    assert.equal(turnTitle({ role: 'user', content }).skillName, native?.name);
  }
});

test('turn titles normalize multiline Markdown and distinguish image-only and empty requests', () => {
  assert.equal(
    turnTitle({ role: 'user', content: '  ##  标题\r\n> - 内容\n\t* 第二项\n2) 结论\nC# 与 -name 参数' })
      .title,
    '标题 内容 第二项 结论 C# 与 -name 参数',
  );
  assert.equal(
    turnTitle({ role: 'user', content: [{ type: 'image' }, { type: 'image' }] }).title,
    '[图片 ×2]',
  );
  assert.equal(
    turnTitle({ role: 'user', content: [{ type: 'text', text: '\n> \n# ' }] }).title,
    '（无文字）',
  );
  assert.equal(turnTitle({ role: 'user', content: '' }).tooltip, '（无文字）');
});

test('turn titles keep 80 characters and a 200-character tooltip without splitting emoji', () => {
  const content = '龙🐉'.repeat(150);
  const title = turnTitle({ role: 'user', content });
  assert.equal(Array.from(title.title).length, 80);
  assert.equal(Array.from(title.tooltip).length, 200);
  assert.equal(title.title, '龙🐉'.repeat(40));
  assert.equal(title.tooltip, '龙🐉'.repeat(100));
});

test('turn title cache reuses historical messages and invalidates replaced content without changing turn indices', () => {
  let reads = 0;
  const message: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        get text() {
          reads++;
          return '# first';
        },
      },
    ],
  };
  const first = turnTitle(message);
  const before = reads;
  assert.equal(turnTitle(message), first);
  const messages: Message[] = [
    message,
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'second' },
  ];
  const turns = conversationTurns(messages, () => tool('unused'));
  assert.equal(reads, before, 're-rendering must not read and clean historical text again');
  assert.deepEqual(
    turns.map(({ turn, index }) => ({ turn, index })),
    [
      { turn: 1, index: 0 },
      { turn: 2, index: 2 },
    ],
  );
  message.content = '## replaced';
  assert.notEqual(turnTitle(message), first);
  assert.equal(turnTitle(message).title, 'replaced');
});

test('ANSI removes terminal commands, handles progress overwrite and retains only safe style tokens', () => {
  assert.deepEqual(parseAnsi('\x1b[1;32mPASS\x1b[0m'), [{ text: 'PASS', color: 'green', bold: true }]);
  assert.equal(
    stripAnsi('progress 10%\r\x1b[2Kprogress 100%\n\x1b]0;unsafe title\x07done\x1b[1G'),
    'progress 100%\ndone',
  );
  assert.equal(stripAnsi('abc\rZ'), 'Zbc');
  assert.equal(stripAnsi('\x1b]8;;https://example.test\x1b\\text\x1b]8;;\x1b\\'), 'text');
  assert.equal(stripAnsi('\x1b[38;2;255;0;0mtext\x1b[0m'), 'text');
  assert.equal(stripAnsi('<script>alert(1)</script>'), '<script>alert(1)</script>');
  assert.equal(stripAnsi('ok\x1b['), 'ok');
});

test('collapsed pastes preserve insertion order and offsets across normal text editing', () => {
  const snippets = [
    { id: 'a', text: 'FIRST\n', offset: 2 },
    { id: 'b', text: 'SECOND\n', offset: 2 },
    { id: 'c', text: 'END', offset: 4 },
  ];
  assert.equal(composeDraftText('ABCD', snippets), 'ABFIRST\nSECOND\nCDEND');
  const changed = moveSnippetOffsets('ABCD', 'XXABCD', snippets);
  assert.deepEqual(
    changed.map((item) => item.offset),
    [4, 4, 6],
  );
  assert.equal(composeDraftText('XXABCD', changed), 'XXABFIRST\nSECOND\nCDEND');
  assert.equal(
    composeDraftText('ABtailCD', moveSnippetOffsets('ABCD', 'ABtailCD', snippets)),
    'ABFIRST\nSECOND\ntailCDEND',
  );
  assert.equal(shouldCollapsePaste(Array.from({ length: 60 }, (_, i) => String(i)).join('\n'), ''), true);
  assert.equal(shouldCollapsePaste('x'.repeat(5000), '/review '), false);
  assert.equal(textBytes('中'), 3);
  assert.equal(
    textBytes(composeDraftText('', [{ id: 'large', offset: 0, text: 'x'.repeat(1024 * 1024 + 1) }])),
    1024 * 1024 + 1,
  );
});

test('prompt parameter serialization round-trips the actual Pi 1.1 parser', () => {
  const values = ['src/a.ts', 'two words', 'a"b\'c', 'C:\\folder\\file', '你好\n继续'];
  const serialized = formatPromptArguments(values);
  assert.deepEqual(parsePromptArguments(serialized), values);
  assert.deepEqual(parseCommandArgs(serialized), values);
  assert.deepEqual(parseArgumentHint('<目标文件> [关注点]'), [
    { label: '目标文件', required: true },
    { label: '关注点', required: false },
  ]);
  assert.throws(() => formatPromptArguments(['', 'second']), /按顺序/);
});

test('search covers early pages, thinking, reference ranges and tool arguments/output', () => {
  const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
    role: 'user',
    content: `message ${index}`,
  }));
  messages[9].content = 'needle early';
  messages[10] = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden needle' }] };
  messages[11].content =
    'question\n\n<project_file path="src/file.ts" lines="10-40">\nneedle file\n</project_file>';
  messages[12] = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't', name: 'read', arguments: { path: 'needle.ts' } }],
  };
  messages[13] = {
    role: 'toolResult',
    toolCallId: 't',
    toolName: 'read',
    content: '\x1b[31mneedle failure\x1b[0m',
  };
  const search = new SessionSearch();
  const matches = search.search(messages, [], 'NEEDLE');
  assert.equal(matches.length, 5);
  assert.deepEqual(
    Array.from({ length: matches.length }, (_, i) => matches.at(i)!.section),
    ['text', 'thinking', 'attachment', 'tool', 'tool'],
  );
  assert.equal(matches.at(0)!.messageIndex, 9);
  assert.equal(splitUserContent(String(messages[11].content)).files[0].lines, '10-40');
  assert.equal(search.search(messages, [], '').length, 0);
});

const tool = (id: string, name = 'read', status: ToolActivity['status'] = 'done'): ToolActivity => ({
  id,
  name,
  status,
  args: { path: id + '.ts' },
  output: 'done',
  startedAt: 0,
});
test('successful retries hide old model errors while retaining reply content, tool results and native history', () => {
  const emptyFailure: Message = {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: 'Connection error.',
  };
  const partialFailure: Message = {
    role: 'assistant',
    content: 'Partial reply',
    stopReason: 'error',
    errorMessage: 'Connection error.',
  };
  const toolResult: Message = { role: 'toolResult', toolCallId: 'read', content: 'Read result' };
  const messages: Message[] = [
    { role: 'user', content: 'Recover this request' },
    emptyFailure,
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read' }], stopReason: 'toolUse' },
    toolResult,
    partialFailure,
    { role: 'assistant', content: 'Recovered', stopReason: 'stop' },
  ];
  const displayed = hideRecoveredErrors(messages);
  assert.equal(displayed.includes(emptyFailure), false);
  assert.ok(displayed.includes(toolResult));
  assert.equal(displayed.find((message) => message.content === 'Partial reply')?.errorMessage, undefined);
  assert.equal(conversationTurns(displayed, () => tool('read'))[0].failed, false);
  assert.equal(emptyFailure.errorMessage, 'Connection error.');
  assert.equal(partialFailure.errorMessage, 'Connection error.');
  assert.equal(messages.length, 6);
});

test('recovery does not hide errors from other turns, final failures, aborted requests or failed tools', () => {
  const failure = (errorMessage: string): Message => ({
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
  });
  const previous = failure('Previous turn failed');
  const final = failure('Final request failed');
  const aborted = failure('Request failed before cancellation');
  const toolFailure: Message = {
    role: 'toolResult',
    toolCallId: 'read',
    content: 'Failed tool',
    isError: true,
  };
  const messages: Message[] = [
    { role: 'user', content: 'Previous turn' },
    previous,
    { role: 'user', content: 'Recovered turn' },
    failure('Recovered error'),
    toolFailure,
    { role: 'assistant', content: 'Recovered', stopReason: 'stop' },
    { role: 'user', content: 'Failed turn' },
    final,
    { role: 'user', content: 'Cancelled turn' },
    aborted,
    { role: 'assistant', content: [], stopReason: 'aborted' },
  ];
  const displayed = hideRecoveredErrors(messages);
  for (const message of [previous, final, aborted, toolFailure]) assert.ok(displayed.includes(message));
  assert.equal(
    displayed.some((message) => message.errorMessage === 'Recovered error'),
    false,
  );
  assert.equal(conversationTurns(displayed, () => tool('read', 'read', 'error'))[1].failed, true);
});

test('only consecutive completed read-only tools group; writes, commands, failures and expanded tools stay visible', () => {
  const tools = [
    tool('1'),
    tool('2', 'grep'),
    tool('3'),
    tool('4', 'write'),
    tool('5'),
    tool('6', 'bash'),
    tool('7', 'read', 'error'),
    tool('8', 'read', 'running'),
  ];
  const messages: Message[] = tools.flatMap((item) => [
    { role: 'assistant', content: [{ type: 'toolCall', id: item.id, name: item.name }] },
    { role: 'toolResult', content: item.output, toolCallId: item.id },
  ]);
  const lookup = (message: Message) => tools.find((item) => item.id === message.toolCallId)!;
  const grouped = groupConversation(messages, lookup, []);
  assert.equal(grouped[0].kind, 'group');
  assert.equal(grouped.filter((item) => item.kind === 'group').length, 1);
  assert.equal(grouped.length, 6);
  assert.equal(groupConversation(messages, lookup, ['2']).filter((item) => item.kind === 'group').length, 0);
  const turns = conversationTurns(
    [{ role: 'user', content: 'first' }, ...messages, { role: 'user', content: 'second' }],
    lookup,
  );
  assert.equal(turns[0].modified, true);
  assert.equal(turns[0].failed, true);
  assert.equal(turns[1].index, messages.length + 1);
});

test('code tokenizer preserves exact text while adding lightweight semantic classes', () => {
  for (const language of [
    'typescript',
    'json',
    'bash',
    'powershell',
    'python',
    'rust',
    'go',
    'html',
    'css',
    'diff',
    'markdown',
  ]) {
    const source = 'const name = "hello"; // note\nreturn 42;';
    assert.equal(
      tokenizeCode(source, language)
        .map((token) => token.text)
        .join(''),
      source,
    );
  }
  assert.equal(tokenizeCode('const x = 1;', 'ts')[0].kind, 'keyword');
});

test('cached historical patch counts stay correct after late completion, replacement and patch removal', () => {
  const edit = { ...tool('edit', 'edit', 'running'), patch: '--- before\n+++ after\n-old\n+new\n+extra' };
  const messages: Message[] = [
    { role: 'user', content: 'change' },
    { role: 'toolResult', toolCallId: edit.id, content: 'done' },
  ];
  const stats = () => conversationTurns(messages, () => edit)[0];
  assert.equal(stats().added, 2);
  assert.equal(stats().removed, 1);
  assert.equal(stats().added, 2);
  edit.status = 'error';
  edit.patch = '+replacement';
  assert.equal(stats().failed, true);
  assert.equal(stats().added, 1);
  assert.equal(stats().removed, 0);
  edit.patch = '';
  assert.equal(stats().added, 0);
  const replacement = { ...edit, status: 'done' as const, patch: '-removed' };
  assert.equal(conversationTurns(messages, () => replacement)[0].removed, 1);
  assert.equal(conversationTurns(messages, () => replacement)[0].failed, false);
});

test('500-message search stays below the 16 ms budget', () => {
  const messages: Message[] = Array.from({ length: 500 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `module ${index}\n${'read source and explain behavior '.repeat(30)}\nneedle ${index}`,
  }));
  const durations: number[] = [];
  const search = new SessionSearch();
  for (let i = 0; i < 70; i++) {
    const start = performance.now();
    assert.equal(search.search(messages, [], 'needle').length, 500);
    if (i >= 10) durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(durations.length * 0.95)];
  console.log(`500-message search median=${durations[30].toFixed(2)} ms p95=${p95.toFixed(2)} ms`);
  assert.ok(p95 < 16, `search p95 ${p95.toFixed(2)}ms exceeds 16ms`);
});
