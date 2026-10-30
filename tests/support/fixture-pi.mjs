// Deterministic protocol fixture. Real Pi tool execution is tested separately.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('1.1.0');
  process.exit(0);
}
const dir = process.env.PI_CODING_AGENT_DIR;
const model = {
  provider: 'fixture',
  id: 'test',
  name: 'Protocol fixture',
  headers: { Authorization: 'Bearer test-secret-do-not-expose' },
};
const models = [model, { ...model, id: 'test-next', name: 'Next protocol model' }];
let selectedModel = model;
let selectedThinking = 'off';
let autoCompaction = true,
  autoRetry = true;
let approvalMode = process.env.PI_DESKTOP_APPROVAL || 'auto';
let messages = [],
  steering = [],
  followUp = [],
  active = false,
  timers = [];
const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const respond = (r, data) => out({ type: 'response', id: r.id, command: r.type, success: true, data });
const schedule = (f, ms) => timers.push(setTimeout(f, ms));
const cancel = () => {
  timers.forEach(clearTimeout);
  timers = [];
};
const emitMessage = (role, content, extra = {}) => {
  const m = { role, content, timestamp: Date.now(), ...extra };
  messages.push(m);
  out({ type: 'message_start', message: m });
  out({ type: 'message_end', message: m });
};
const finish = () => {
  active = false;
  emitMessage('assistant', [{ type: 'text', text: '完成：中文\u2028换行保留。' }], { stopReason: 'stop' });
  out({ type: 'agent_end' });
  out({ type: 'agent_settled', aborted: false });
};
const config = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
  } catch {
    return {};
  }
};
const thinkingLevels = (modelId = selectedModel.id) =>
  config().thinkingLevels?.[modelId] ?? ['off', 'low', 'high'];
const io = readline.createInterface({ input: process.stdin });
io.on('line', (line) => {
  const r = JSON.parse(line);
  fs.appendFileSync(path.join(dir, 'commands.jsonl'), JSON.stringify(r) + '\n');
  switch (r.type) {
    case 'get_commands':
      respond(r, { commands: config().noBridge ? [] : [{ name: 'desktop-internal', source: 'extension' }] });
      break;
    case 'get_state':
      respond(r, {
        model: selectedModel,
        thinkingLevel: selectedThinking,
        autoCompactionEnabled: autoCompaction,
        sessionName: config().sessionName,
        isStreaming: active,
        isCompacting: false,
        pendingMessageCount: steering.length + followUp.length,
      });
      break;
    case 'get_messages':
      respond(r, { messages });
      break;
    case 'get_available_models':
      respond(r, { models });
      break;
    case 'get_available_thinking_levels':
      respond(r, { levels: thinkingLevels() });
      break;
    case 'set_thinking_level':
      selectedThinking = r.level;
      respond(r);
      break;
    case 'set_auto_compaction':
      autoCompaction = r.enabled;
      respond(r);
      break;
    case 'set_auto_retry':
      autoRetry = r.enabled;
      respond(r);
      break;
    case 'get_session_stats':
      if (config().exitOnStats) process.exit(9);
      respond(r, { tokens: { total: 42 } });
      break;
    case 'set_model':
      selectedModel =
        models.find((item) => item.provider === r.provider && item.id === r.modelId) ?? selectedModel;
      respond(r, selectedModel);
      break;
    case 'new_session':
    case 'switch_session':
      if (!config().cancelSwitch)
        out({
          type: 'extension_ui_request',
          method: 'notify',
          message: '__PI_DESKTOP__' + JSON.stringify({ type: 'desktop_session_start' }),
        });
      respond(r, { cancelled: config().cancelSwitch === true });
      break;
    case 'steer':
    case 'follow_up':
      (r.type === 'steer' ? steering : followUp).push(r.message);
      out({ type: 'queue_update', steering, followUp });
      respond(r, { disposition: 'queued' });
      break;
    case 'clear_queue':
      respond(r, { steering, followUp });
      steering = [];
      followUp = [];
      out({ type: 'queue_update', steering, followUp });
      break;
    case 'abort':
      cancel();
      active = false;
      out({ type: 'agent_settled', aborted: true });
      respond(r);
      break;
    case 'extension_ui_response':
      finish();
      break;
    case 'prompt': {
      if (r.message.startsWith('/desktop-internal ')) {
        const request = JSON.parse(Buffer.from(r.message.split(' ')[1], 'base64').toString('utf8'));
        if (request.method === 'approval_mode') approvalMode = request.params.mode;
        out({
          type: 'desktop_result',
          id: request.id,
          data:
            request.method === 'task_options'
              ? {
                  thinking: request.params.thinking,
                  thinkingLevels: thinkingLevels(request.params.modelId),
                }
              : {
                  protocolVersion: 4,
                  autoRetry,
                  approvalMode,
                  approvalGrants: [],
                },
        });
        respond(r, { disposition: 'handled' });
        break;
      }
      if (active && r.streamingBehavior) {
        (r.streamingBehavior === 'steer' ? steering : followUp).push(r.message);
        out({ type: 'queue_update', steering, followUp });
        respond(r, { disposition: 'queued' });
        break;
      }
      if (r.message === '/handled') {
        respond(r, { disposition: 'handled' });
        break;
      }
      active = true;
      respond(r, { disposition: 'started' });
      out({ type: 'agent_start' });
      emitMessage('user', r.message);
      if (r.message === 'crash') {
        schedule(() => process.exit(9), 60);
        break;
      }
      if (r.message === 'hold') break;
      if (r.message.startsWith('extension ')) {
        const method = r.message.split(' ')[1];
        out({
          type: 'extension_ui_request',
          id: 'question-1',
          method,
          title: 'Fixture question',
          options: ['A', 'B'],
          timeout: r.message.includes('timeout') ? 100 : undefined,
        });
        if (r.message.includes('timeout')) schedule(finish, 160);
        break;
      }
      if (r.message === 'retry') {
        schedule(() => {
          out({ type: 'agent_end' });
          out({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '503 fixture' });
        }, 10);
        schedule(() => out({ type: 'auto_retry_end', success: true }), 90);
        schedule(() => out({ type: 'compaction_start', reason: 'threshold' }), 120);
        schedule(() => out({ type: 'compaction_end', reason: 'threshold' }), 180);
        schedule(finish, 240);
        break;
      }
      out({ type: 'message_start', message: { role: 'assistant', content: [] } });
      out({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '中文\u2028' },
      });
      schedule(finish, 30);
      break;
    }
    default:
      respond(r);
  }
});
io.on('close', () => {
  cancel();
  process.exit(0);
});
