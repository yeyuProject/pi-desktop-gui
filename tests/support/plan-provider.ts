import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PlanStep } from '../../shared/plan';

export const planSteps: PlanStep[] = [
  { text: '检查登录输入与现有测试', status: 'in_progress' },
  { text: '修复登录校验', status: 'pending' },
  { text: '运行回归测试', status: 'pending' },
  { text: '核对结果与提交', status: 'pending' },
];
export const nextPlanSteps: PlanStep[] = planSteps.map((step, index) => ({
  ...step,
  status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
}));

/** Explicit response gates exercise the real Pi protocol without timing races or remote calls. */
export async function createPlanProvider() {
  const requests: {
    messages: { role: string; content?: unknown }[];
    tools?: { function?: { name?: string } }[];
  }[] = [];
  const pending: ((response: string | PlanStep[]) => void)[] = [];
  const queued: (string | PlanStep[])[] = [];
  const server = http.createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(chunk);
    requests.push(JSON.parse(Buffer.concat(bytes).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const respond = (response: string | PlanStep[]) => {
      const tool = Array.isArray(response);
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: 'plan-test', object: 'chat.completion.chunk', model: 'local-e2e', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      chunk(
        tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'plan_' + randomUUID(),
                  type: 'function',
                  function: { name: 'desktop_plan', arguments: JSON.stringify({ steps: response }) },
                },
              ],
            }
          : { role: 'assistant', content: response },
      );
      chunk({}, tool ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    };
    if (queued.length) respond(queued.shift()!);
    else {
      pending.push(respond);
      res.on('close', () => {
        const at = pending.indexOf(respond);
        if (at >= 0) pending.splice(at, 1);
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
    respond(response: string | PlanStep[]) {
      const next = pending.shift();
      if (next) next(response);
      else queued.push(response);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
