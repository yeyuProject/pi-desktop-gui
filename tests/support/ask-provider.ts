import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AskRequest } from '../../shared/ask';

export const singleQuestion: AskRequest = {
  questions: [
    {
      id: 'database',
      header: '数据库',
      question: '本地项目应使用哪种数据库？配置保存在 `config/database.ts`。',
      options: [
        { label: 'SQLite', description: '保存在本地文件中，无需额外服务。', recommended: true },
        { label: 'PostgreSQL', description: '使用独立数据库服务，便于多人协作。' },
      ],
    },
  ],
};
export const multipleQuestions: AskRequest = {
  questions: [
    ...singleQuestion.questions,
    {
      id: 'checks',
      header: '验证方式',
      question: '需要覆盖哪些验证？',
      multiSelect: true,
      options: [
        { label: '单元测试', description: '检查输入和关键规则。', recommended: true },
        { label: '界面测试', description: '检查点击、键盘和会话切换。' },
        { label: '人工检查', description: '查看界面和最终运行结果。' },
      ],
    },
  ],
};
export type AskProviderReply = string | { tool: string; args: object };

/** The test chooses each next model response, including the pause while a real tool awaits input. */
export async function createAskProvider() {
  const requests: {
    messages: { role: string; content?: unknown }[];
    tools?: { function?: { name?: string } }[];
  }[] = [];
  const pending: ((reply: AskProviderReply) => void)[] = [];
  const queued: AskProviderReply[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const write = (value: object) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'ask-test',
          object: 'chat.completion.chunk',
          model: 'local-e2e',
          ...value,
        })}\n\n`,
      );
    const respond = (reply: AskProviderReply) => {
      const tool = typeof reply !== 'string';
      write({
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'ask_' + randomUUID(),
                      type: 'function',
                      function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                    },
                  ],
                }
              : { role: 'assistant', content: reply },
            finish_reason: null,
          },
        ],
      });
      write({
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      });
      response.end('data: [DONE]\n\n');
    };
    if (queued.length) respond(queued.shift()!);
    else {
      pending.push(respond);
      response.on('close', () => {
        const index = pending.indexOf(respond);
        if (index >= 0) pending.splice(index, 1);
      });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    get waiting() {
      return pending.length;
    },
    respond(reply: AskProviderReply) {
      const handler = pending.shift();
      if (handler) handler(reply);
      else queued.push(reply);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
