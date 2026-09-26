import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('manifests combine after partial build failures while publication stays strict', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' }}",
  );
  const finalize = workflow.jobs['finalize-release'];
  const expression = finalize.if.trim().slice(3, -2)
    .replace(/needs\.([a-z-]+)\.result/g, 'needs["$1"].result');
  const success = Object.fromEntries(finalize.needs.map((job) => [job, { result: 'success' }]));
  const canPublish = (needs, repository, dryRun = 'false') => runInNewContext(expression, {
    needs,
    github: { repository, event: { inputs: { dry_run: dryRun } } },
    always: () => true,
  });

  for (const repository of ['openchamber/openchamber', 'nekocon233/openchamber']) {
    assert.equal(canPublish(success, repository), true);
    assert.equal(canPublish(success, repository, 'true'), false);
    // A failed or cancelled required job must leave the release as a draft.
    for (const job of finalize.needs) {
      for (const result of ['failure', 'cancelled']) {
        assert.equal(canPublish({ ...success, [job]: { result } }, repository), false, `${repository}: ${job} ${result}`);
      }
    }
  }

  const fork = { ...success, 'publish-npm': { result: 'skipped' }, 'mobile-release': { result: 'skipped' } };
  assert.equal(canPublish(fork, 'nekocon233/openchamber'), true);
  assert.equal(canPublish(fork, 'openchamber/openchamber'), false);
});
