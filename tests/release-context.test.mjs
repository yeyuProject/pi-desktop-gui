import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
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

test('packaging only accepts skipped test gates for an explicit manual opt-out', () => {
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const expression = workflow.jobs.package.if
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    // GitHub accepts hyphens in job IDs; JavaScript property access needs brackets.
    .replace(/\bneeds\.([\w-]+)\.result/g, "needs['$1'].result");
  const evaluate = new Function(
    'github',
    'inputs',
    'startsWith',
    'needs',
    'always',
    'cancelled',
    `return Boolean(${expression})`,
  );
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
                { 'build-and-test': { result: build }, 'update-roundtrip': { result: update } },
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
  assert.deepEqual(workflow.jobs.package.needs, ['build-and-test', 'update-roundtrip']);
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
