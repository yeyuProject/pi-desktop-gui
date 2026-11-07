import http from 'node:http';
import { randomUUID } from 'node:crypto';
export async function createTeamProvider() {
  const requests: any[] = [];
  const pending = new Map<number, (reply: string | { name: string; args: object }) => void>();
  const streams = new Map<number, (text: string) => void>();
  const responses = new Map<number, http.ServerResponse>();
  const server = http.createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes).toString('utf8'));
    const index = requests.push(body) - 1;
    responses.set(index, res);
    res.setHeader('content-type', 'text/event-stream');
    streams.set(index, (text) =>
      res.write(
        `data: ${JSON.stringify({ id: 'team-test', object: 'chat.completion.chunk', model: 'local-e2e', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
      ),
    );
    pending.set(index, (reply) => {
      pending.delete(index);
      const tool = typeof reply !== 'string';
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'team-test',
            object: 'chat.completion.chunk',
            model: 'local-e2e',
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      chunk(
        tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'team_' + randomUUID(),
                  type: 'function',
                  function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                },
              ],
            }
          : { role: 'assistant', content: reply },
      );
      chunk({}, tool ? 'tool_calls' : 'stop');
      res.write(
        `data: ${JSON.stringify({ id: 'team-test', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
    res.once('close', () => {
      pending.delete(index);
      streams.delete(index);
      responses.delete(index);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    get pending() {
      return [...pending.keys()];
    },
    reply(index: number, reply: string | { name: string; args: object }) {
      const respond = pending.get(index);
      if (!respond) throw new Error(`Request ${index} is not pending`);
      respond(reply);
    },
    fail(index: number, status = 401) {
      const response = responses.get(index);
      if (!response || response.headersSent) throw new Error(`Request ${index} cannot fail before headers`);
      pending.delete(index);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key (local test)' } }),
      );
    },
    stream(index: number, text: string) {
      const send = streams.get(index);
      if (!send || !pending.has(index)) throw new Error(`Request ${index} is not pending`);
      send(text);
    },
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
