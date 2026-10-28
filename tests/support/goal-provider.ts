import http from 'node:http';
import { randomUUID } from 'node:crypto';

type GoalScenario =
  | 'continue'
  | 'mixed'
  | 'pause'
  | 'hold'
  | 'complete'
  | 'budget'
  | 'budget-ui'
  | 'blocked'
  | 'long'
  | 'cached'
  | 'quota'
  | 'plan'
  | 'edit'
  | 'budget-ignore';
interface ProviderMessage {
  role: string;
  content?: string | { text?: string }[];
}
interface ProviderRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: { function?: { name?: string } }[];
}

/** Deterministic responses at the real Pi HTTP boundary; never uses a remote model. */
export async function createGoalProvider() {
  let scenario: GoalScenario = 'continue';
  let count = 0;
  let releaseHeld: (() => void) | undefined;
  const requests: { scenario: GoalScenario; count: number; body: ProviderRequest; closed: boolean }[] = [];
  const errors: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest;
    const entry = { scenario, count: ++count, body, closed: false };
    requests.push(entry);
    res.on('close', () => {
      entry.closed = true;
    });
    if (entry.scenario === 'quota') {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'insufficient_quota: credits exhausted', type: 'insufficient_quota' },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'goal-test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    const done = (finishReason = 'stop') => {
      const cached = entry.scenario === 'cached';
      const inputTokens = entry.scenario === 'budget-ui' ? 500000 : cached ? 91000 : 100;
      const outputTokens = cached ? 500 : 20;
      chunk({}, finishReason);
      res.write(
        `data: ${JSON.stringify({
          id: 'goal-test',
          object: 'chat.completion.chunk',
          choices: [],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            ...(cached ? { prompt_tokens_details: { cached_tokens: 90000 } } : {}),
          },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    };
    if (
      entry.scenario === 'hold' ||
      (entry.scenario === 'pause' && entry.count > 1) ||
      (entry.scenario === 'plan' && entry.count > 1) ||
      (entry.scenario === 'edit' && entry.count === 1)
    ) {
      chunk({ role: 'assistant', content: 'GOAL_WAITING_FOR_CANCELLATION' });
      if (entry.scenario === 'edit')
        releaseHeld = () => {
          done();
          releaseHeld = undefined;
        };
      return;
    }
    const text = body.messages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map((part) => part.text ?? '').join('\n'),
      )
      .join('\n');
    if (
      (entry.scenario === 'budget' || entry.scenario === 'budget-ui') &&
      text.includes('Goal 已达到用量上限。')
    ) {
      chunk({
        role: 'assistant',
        content: 'GOAL_WRAP_UP: current work saved; remaining verification requires a higher allowance.',
      });
      done();
      return;
    }
    if (
      entry.scenario === 'budget-ui' ||
      ((entry.scenario === 'continue' || entry.scenario === 'pause') && entry.count === 1) ||
      (entry.scenario === 'long' && entry.count <= 60 && entry.count % 2 === 0)
    ) {
      chunk({ role: 'assistant', content: 'GOAL_PARTIAL: verification is still outstanding.' });
      done();
      return;
    }
    const goalId = [...text.matchAll(/goal_id:\s*([A-Za-z0-9-]+)/g)].at(-1)?.[1];
    const revision = Number([...text.matchAll(/revision:\s*(\d+)/g)].at(-1)?.[1]);
    if (!goalId || !revision || !body.tools?.some((tool) => tool.function?.name === 'desktop_goal_update')) {
      errors.push('Provider request did not expose the current Goal id, revision and update tool.');
      chunk({ role: 'assistant', content: 'GOAL_FIXTURE_MISSING_CONTRACT' });
      done();
      return;
    }
    const call = (name: string, args: unknown, index = 0) => ({
      index,
      id: 'goal_' + randomUUID().slice(0, 8),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    const read = () => call('read', { path: '输入 文件.txt' });
    const toolCalls =
      entry.scenario === 'budget' ||
      entry.scenario === 'budget-ignore' ||
      (entry.scenario === 'long' && entry.count <= 60) ||
      (entry.scenario === 'cached' && entry.count < 10)
        ? [read()]
        : entry.scenario === 'plan'
          ? [
              call('desktop_goal_plan', {
                goal_id: goalId,
                revision,
                steps: [
                  { text: '核对需求', status: 'completed' },
                  { text: '实现并验证', status: 'in_progress' },
                  { text: '总结结果', status: 'pending' },
                ],
              }),
            ]
          : [
              ...(entry.scenario === 'mixed' && entry.count === 1 ? [read()] : []),
              call(
                'desktop_goal_update',
                {
                  goal_id: goalId,
                  revision,
                  status: entry.scenario === 'blocked' ? 'blocked' : 'completed',
                  summary: [
                    '**Verification summary**',
                    ...Array.from(
                      { length: 35 },
                      (_, index) => `- Check ${index + 1} passed at the local provider boundary.`,
                    ),
                  ].join('\n'),
                },
                entry.scenario === 'mixed' && entry.count === 1 ? 1 : 0,
              ),
            ];
    chunk({ role: 'assistant', tool_calls: toolCalls });
    done('tool_calls');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    errors,
    get count() {
      return count;
    },
    reset(next: GoalScenario) {
      scenario = next;
      count = 0;
    },
    release() {
      releaseHeld?.();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
