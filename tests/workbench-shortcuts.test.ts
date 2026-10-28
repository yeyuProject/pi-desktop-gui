import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as actions from '../shared/workbench-actions';
import type { WorkbenchAction } from '../shared/workbench-actions';

const { code } = transformSync(readFileSync('src/hooks/useShortcuts.ts', 'utf8'), {
  loader: 'ts',
  format: 'cjs',
});
class Element {
  textContent = '';
  isContentEditable = false;
  editor: Element | null = null;
  closest() {
    return this.editor;
  }
}
class Input extends Element {
  type = 'text';
  constructor(public value = '') {
    super();
  }
}
class Textarea extends Element {
  constructor(public value = '') {
    super();
  }
}
class Event {
  detail?: unknown;
  constructor(
    public type: string,
    init?: { detail?: unknown },
  ) {
    this.detail = init?.detail;
  }
}

function harness(mac = false) {
  const listeners = new Map<string, ((event: any) => void)[]>();
  const dispatched: Event[] = [];
  let allowed = true;
  const window = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
    dispatchEvent: (event: Event) => {
      dispatched.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    desktop: { onEvent: () => () => {} },
  };
  const modules: Record<string, unknown> = {
    react: {
      useRef: (current: unknown) => ({ current }),
      useState: (initial: unknown) => [initial, () => {}],
      useEffect: (run: () => unknown) => run(),
    },
    '../../shared/workbench-actions': actions,
    '../lib/platform': {
      mod: (event: { metaKey: boolean; ctrlKey: boolean }) => (mac ? event.metaKey : event.ctrlKey),
    },
    './useLayer': { allowsWorkbenchAction: () => allowed, topLayer: () => (allowed ? undefined : {}) },
  };
  const module = {
    exports: {} as { useShortcuts: (options: unknown) => { runAction: (action: WorkbenchAction) => void } },
  };
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'CustomEvent',
    code,
  )(
    (name: string) => {
      assert.ok(name in modules, `Unexpected production dependency ${name}`);
      return modules[name];
    },
    module,
    module.exports,
    window,
    Element,
    Input,
    Textarea,
    Event,
  );
  const hook = module.exports.useShortcuts({ runtime: { status: 'idle' }, ownRunning: false });
  return {
    dispatched,
    hook,
    allow: (value: boolean) => {
      allowed = value;
    },
    key: (
      key: string,
      target: Element = new Element(),
      modifiers: Partial<
        Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>
      > = {},
    ) => {
      const event = {
        key,
        target,
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        repeat: false,
        defaultPrevented: false,
        ...modifiers,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of listeners.get('keydown') ?? []) listener(event);
      return event;
    },
  };
}

test('Alt+ArrowUp/Down dispatch turn navigation on the conversation and empty input controls', () => {
  for (const mac of [false, true]) {
    const h = harness(mac);
    for (const target of [new Element(), new Textarea(), new Input()]) {
      assert.equal(h.key('ArrowUp', target).defaultPrevented, true);
      assert.equal(h.key('ArrowDown', target).defaultPrevented, true);
    }
    assert.deepEqual(
      h.dispatched.map(({ type, detail }) => ({ type, detail })),
      [
        { type: 'pi:turn', detail: -1 },
        { type: 'pi:turn', detail: 1 },
        { type: 'pi:turn', detail: -1 },
        { type: 'pi:turn', detail: 1 },
        { type: 'pi:turn', detail: -1 },
        { type: 'pi:turn', detail: 1 },
      ],
    );
  }
});

test('turn shortcuts preserve system text navigation whenever the focused input contains content', () => {
  const h = harness(true);
  const editor = new Element();
  editor.isContentEditable = true;
  editor.textContent = 'editable text';
  const child = new Element();
  child.editor = editor;
  for (const target of [new Textarea('draft'), new Textarea(' '), new Input('query'), child]) {
    assert.equal(h.key('ArrowUp', target).defaultPrevented, false);
    assert.equal(h.key('ArrowDown', target).defaultPrevented, false);
  }
  assert.equal(h.dispatched.length, 0);
  editor.textContent = '';
  assert.equal(h.key('ArrowUp', child).defaultPrevented, true);
  assert.equal(h.dispatched.at(-1)!.detail, -1);
});

test('turn shortcuts require exactly Alt and do not intercept composing or blocked modal input', () => {
  const h = harness();
  for (const modifiers of [
    { altKey: false },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ])
    assert.equal(h.key('ArrowUp', new Textarea(), modifiers).defaultPrevented, false);
  h.allow(false);
  assert.equal(h.key('ArrowDown').defaultPrevented, false);
  assert.deepEqual(h.dispatched, []);
});

test('turn actions share keyboard, command-palette and shortcut-help identifiers', () => {
  const h = harness();
  h.hook.runAction('previousTurn');
  h.hook.runAction('nextTurn');
  assert.deepEqual(
    h.dispatched.map((event) => event.detail),
    [-1, 1],
  );
  const bindings = actions.workbenchShortcuts.filter(
    (binding) => binding.action === 'previousTurn' || binding.action === 'nextTurn',
  );
  assert.deepEqual(
    bindings.map((binding) => actions.workbenchKeyLabel(binding.key)),
    ['↑', '↓'],
  );
});
