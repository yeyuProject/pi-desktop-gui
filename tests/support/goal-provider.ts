import http from 'node:http';
import { randomUUID } from 'node:crypto';

type GoalScenario = 'continue' | 'mixed' | 'pause' | 'hold' | 'complete' | 'budget';

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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: unknown, finishReason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'goal-test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    const done = (finishReason = 'stop') => {
      chunk({}, finishReason);
      res.write(
        `data: ${JSON.stringify({ id: 'goal-test', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    };
    if (entry.scenario === 'hold' || (entry.scenario === 'pause' && entry.count > 1)) {
      chunk({ role: 'assistant', content: 'GOAL_WAITING_FOR_CANCELLATION' });
      return;
    }
    if (
      entry.scenario === 'budget' ||
      ((entry.scenario === 'continue' || entry.scenario === 'pause') && entry.count === 1)
    ) {
      chunk({ role: 'assistant', content: 'GOAL_PARTIAL: verification is still outstanding.' });
      done();
      return;
    }
    const text = body.messages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? []).map((part) => part.text ?? '').join('\n'),
      )
      .join('\n');
    const goalId = [...text.matchAll(/goal_id:\s*([A-Za-z0-9-]+)/g)].at(-1)?.[1];
    if (!goalId || !body.tools?.some((tool) => tool.function?.name === 'desktop_goal_complete')) {
      errors.push('The actual provider request did not expose the current goal id and completion tool.');
      chunk({ role: 'assistant', content: 'GOAL_FIXTURE_MISSING_CONTRACT' });
      done();
      return;
    }
    const toolCalls = [
      ...(entry.scenario === 'mixed' && entry.count === 1
        ? [
            {
              index: 0,
              id: 'goal_read_' + randomUUID().slice(0, 8),
              type: 'function',
              function: { name: 'read', arguments: JSON.stringify({ path: '输入 文件.txt' }) },
            },
          ]
        : []),
      {
        index: entry.scenario === 'mixed' && entry.count === 1 ? 1 : 0,
        id: 'goal_' + randomUUID().slice(0, 8),
        type: 'function',
        function: {
          name: 'desktop_goal_complete',
          arguments: JSON.stringify({
            goal_id: goalId,
            summary: 'The deterministic Goal integration task is complete.',
            evidence:
              'The local provider observed the active goal contract and completed its scripted verification.',
          }),
        },
      },
    ];
    chunk({
      role: 'assistant',
      tool_calls: toolCalls,
    });
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
