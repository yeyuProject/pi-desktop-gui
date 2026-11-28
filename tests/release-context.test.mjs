import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { verifiedMainRun } from '../scripts/verified-main-run.mjs';
import { validateRelease } from '../scripts/validate-release.mjs';

const sha = 'a'.repeat(40);
const manual = {
  version: '0.14.1',
  lockVersion: '0.14.1',
  lockPackageVersion: '0.14.1',
  notesExist: true,
  tag: 'v0.14.1',
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
  sha,
  head: sha,
};

test('release context accepts only the exact version and checked-out workflow SHA', () => {
  assert.doesNotThrow(() => validateRelease(manual));
  assert.doesNotThrow(() => validateRelease({ ...manual, event: 'push', ref: 'refs/tags/v0.14.1' }));
  for (const override of [
    { tag: '' },
    { tag: 'v0.14.0' },
    { lockVersion: '0.14.0' },
    { lockPackageVersion: '0.14.0' },
    { notesExist: false },
    { ref: 'refs/heads/develop' },
    { ref: 'refs/tags/v0.14.1' },
    { sha: 'main' },
    { head: 'b'.repeat(40) },
    { event: 'pull_request' },
    { event: 'push' },
  ]) {
    assert.throws(() => validateRelease({ ...manual, ...override }));
  }
});

test('packaging requires completed tests, a verified main push, or an explicit manual opt-out', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const expression = workflow.jobs.package.if
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    // GitHub accepts hyphens in job IDs; JavaScript property access needs brackets.
    .replace(/\bneeds\.([\w-]+)/g, "needs['$1']");
  const evaluate = new Function(
    'github',
    'inputs',
    'startsWith',
    'needs',
    'always',
    'cancelled',
    `return Boolean(${expression})`,
  );
  const gates = (build, update, verify, verified = 'false') => ({
    'build-and-test': { result: build },
    'update-roundtrip': { result: update },
    'verify-main': { result: verify, outputs: { verified } },
  });
  const tag = { event_name: 'push', ref: 'refs/tags/v0.14.1' };
  const canReuse = (build, update, verify, verified) =>
    evaluate(
      tag,
      {},
      (s, prefix) => s.startsWith(prefix),
      gates(build, update, verify, verified),
      () => true,
      () => false,
    );
  assert.equal(canReuse('skipped', 'skipped', 'success', 'true'), true);
  for (const result of ['skipped', 'cancelled', 'failure'])
    assert.equal(canReuse('skipped', 'skipped', result, 'true'), false);
  assert.equal(canReuse('failure', 'skipped', 'success', 'true'), false);
  assert.equal(canReuse('skipped', 'failure', 'success', 'true'), false);
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  const passed = ['success/success'];
  const optional = [...passed, 'success/skipped', 'skipped/success', 'skipped/skipped'];
  for (const [event_name, ref, withTests, withoutTests] of [
    ['push', 'refs/heads/main', [], []],
    ['push', 'refs/tags/v0.14.1', passed, passed],
    ['push', 'refs/tags/preview', [], []],
    ['pull_request', 'refs/pull/1/merge', [], []],
    ['workflow_dispatch', 'refs/heads/main', passed, optional],
    ['workflow_dispatch', 'refs/heads/develop', passed, optional],
    ['workflow_dispatch', 'refs/tags/v0.14.1', passed, optional],
  ]) {
    for (const skip_tests of [undefined, false, true]) {
      const allowed = skip_tests === true ? withoutTests : withTests;
      for (const build of results) {
        for (const update of results) {
          for (const cancelled of [false, true]) {
            assert.equal(
              evaluate(
                { event_name, ref },
                skip_tests === undefined ? {} : { skip_tests },
                (value, prefix) => value.startsWith(prefix),
                gates(
                  build,
                  update,
                  event_name === 'push' && ref.startsWith('refs/tags/v') ? 'success' : 'skipped',
                ),
                () => true,
                () => cancelled,
              ),
              !cancelled && allowed.includes(`${build}/${update}`),
              JSON.stringify({ event_name, ref, skip_tests, build, update, cancelled }),
            );
          }
        }
      }
    }
  }
});

test('manual release defaults to test gates, pins checkouts and cannot overwrite tags', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.default, '');
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.skip_tests.default, false);
  assert.deepEqual(workflow.jobs.package.needs, ['verify-main', 'build-and-test', 'update-roundtrip']);
  assert.equal(workflow.jobs.release.needs, 'package');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.release.permissions, { contents: 'write' });
  assert.equal(workflow.jobs.release.concurrency['cancel-in-progress'], false);
  assert.match(workflow.jobs.release.if, /github\.ref == 'refs\/heads\/main'/);
  const expression = workflow.jobs.release.if.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const evaluate = new Function(
    'github',
    'inputs',
    'startsWith',
    'needs',
    'always',
    'cancelled',
    `return (${expression})`,
  );
  for (const [event_name, ref, release_tag, expected] of [
    ['push', 'refs/heads/main', '', false],
    ['push', 'refs/tags/v0.14.1', '', true],
    ['workflow_dispatch', 'refs/heads/main', '', false],
    ['workflow_dispatch', 'refs/tags/v0.14.1', '', false],
    ['workflow_dispatch', 'refs/heads/main', 'v0.14.1', true],
    ['workflow_dispatch', 'refs/heads/develop', 'v0.14.1', false],
    ['pull_request', 'refs/pull/1/merge', '', false],
  ]) {
    for (const result of ['success', 'failure', 'cancelled', 'skipped'])
      assert.equal(
        evaluate(
          { event_name, ref },
          { release_tag },
          (value, prefix) => value.startsWith(prefix),
          { package: { result } },
          () => true,
          () => false,
        ),
        expected && result === 'success',
      );
  }
  for (const job of Object.values(workflow.jobs)) {
    const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v4');
    assert.equal(checkout.with.ref, '${{ github.sha }}');
  }
  const steps = workflow.jobs.release.steps;
  const createTag = steps.find((step) => step.name === 'Create the new manual release tag');
  assert.equal(createTag.if, "github.event_name == 'workflow_dispatch'");
  assert.match(createTag.run, /gh api --method POST/);
  assert.match(createTag.run, /sha=\$GITHUB_SHA/);
  assert.doesNotMatch(createTag.run, /force|PATCH/);
  const names = steps.map((step) => step.name);
  assert.ok(names.indexOf('Verify updater metadata and download hashes') < names.indexOf(createTag.name));
  assert.ok(names.indexOf('Generate release checksums') < names.indexOf(createTag.name));
  const stage = steps.find(
    (step) => step.name === 'Stage unsigned installers for independent release signing',
  );
  assert.ok(names.indexOf(createTag.name) < names.indexOf(stage.name));
  assert.match(stage.run, /--draft/);
});

test('a release tag can reuse all five successful jobs of the exact main push', async () => {
  const repository = 'owner/repo';
  const main = {
    id: 19,
    html_url: 'run-19',
    head_repository: { full_name: repository },
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  };
  const jobs = [
    'build-and-test (ubuntu-latest)',
    'build-and-test (windows-latest)',
    'build-and-test (macos-latest)',
    'update-roundtrip (windows-latest)',
    'update-roundtrip (ubuntu-latest)',
  ].map((name) => ({ name, conclusion: 'success' }));
  const check = (initial, completed = main, results = jobs) =>
    verifiedMainRun(
      repository,
      sha,
      async (path) => {
        if (path.startsWith('actions/workflows/ci.yml/runs?')) {
          const query = new URLSearchParams(path.split('?')[1]);
          assert.equal(query.get('head_sha'), sha);
          assert.equal(query.get('branch'), 'main');
          assert.equal(query.get('event'), 'push');
          return { workflow_runs: initial ? [initial] : [] };
        }
        if (path === 'actions/runs/19') return completed;
        assert.equal(path, 'actions/runs/19/jobs?filter=latest&per_page=100');
        return { jobs: results };
      },
      async () => {},
    );
  assert.equal(await check({ ...main, status: 'in_progress', conclusion: null }), main.html_url);
  assert.equal(await check(undefined), undefined);
  for (const override of [
    { head_sha: 'other' },
    { head_branch: 'other' },
    { event: 'pull_request' },
    { head_repository: { full_name: 'other/repo' } },
    { conclusion: 'failure' },
  ])
    assert.equal(await check({ ...main, ...override }), undefined);
  assert.equal(await check(main, main, jobs.slice(1)), undefined);
  assert.equal(await check(main, main, [{ ...jobs[0], conclusion: 'skipped' }, ...jobs.slice(1)]), undefined);
});
