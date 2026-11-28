import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const requiredJobs = [
  'build-and-test (windows-latest)',
  'build-and-test (macos-latest)',
  'build-and-test (ubuntu-latest)',
  'update-roundtrip (windows-latest)',
  'update-roundtrip (ubuntu-latest)',
];

// Tags and main are often pushed seconds apart. Only a main push running this workflow
// for the tagged commit can supply the test results. Otherwise the tag runs its own tests.
export async function verifiedMainRun(repository, sha, api, wait = delay) {
  const query = new URLSearchParams({ branch: 'main', event: 'push', head_sha: sha, per_page: '1' });
  const { workflow_runs: runs } = await api(`actions/workflows/ci.yml/runs?${query}`);
  let run = runs[0];
  if (
    !run ||
    run.head_repository?.full_name !== repository ||
    run.head_sha !== sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push'
  )
    return;
  const path = `actions/runs/${run.id}`;
  for (let poll = 0; run.status !== 'completed' && poll < 60; poll++) {
    await wait(30000);
    run = await api(path);
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') return;
  const { jobs } = await api(`${path}/jobs?filter=latest&per_page=100`);
  const passed = new Set(jobs.filter((job) => job.conclusion === 'success').map((job) => job.name));
  if (requiredJobs.every((name) => passed.has(name))) return run.html_url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN, GITHUB_OUTPUT } = process.env;
  let verified;
  try {
    verified = await verifiedMainRun(GITHUB_REPOSITORY, GITHUB_SHA, async (path) => {
      const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`, {
        headers: { Authorization: `Bearer ${GH_TOKEN}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      return response.json();
    });
  } catch (error) {
    console.warn('Could not verify main CI:', error.message);
  }
  console.log(verified ? `Using test results from ${verified}` : 'Running tests on this tag');
  await fs.appendFile(GITHUB_OUTPUT, `verified=${Boolean(verified)}\n`);
}
