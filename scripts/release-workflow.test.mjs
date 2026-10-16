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
  const expression = finalize.if.trim().slice(3, -2);
  const canPublish = ({ needs = {}, dryRun = 'false', wasCancelled = false } = {}) => runInNewContext(expression, {
    github: { repository: 'nekocon233/openchamber', event: { inputs: { dry_run: dryRun } } },
    cancelled: () => wasCancelled,
    failure: () => finalize.needs.some((job) => needs[job]?.result === 'failure'),
  });

  // A dry run never publishes, and any failure or cancellation leaves the
  // release as a draft.
  assert.equal(canPublish({ dryRun: 'true' }), false);
  assert.equal(canPublish({ wasCancelled: true }), false);
  const success = Object.fromEntries(finalize.needs.map((job) => [job, { result: 'success' }]));
  for (const job of finalize.needs) {
    assert.equal(canPublish({ needs: { ...success, [job]: { result: 'failure' } } }), false, job);
  }

  // Jobs this distribution skips, and a finishing run's skipped builds, count
  // as done instead of blocking the Desktop release.
  assert.equal(canPublish({
    needs: {
      ...success,
      'publish-npm': { result: 'skipped' },
      'mobile-release': { result: 'skipped' },
      'build-desktop-electron-windows': { result: 'skipped' },
      'build-desktop-electron-linux': { result: 'skipped' },
    },
  }), true);
});

test('publication stays with upstream, so this fork publishes Desktop artifacts only', () => {
  // The finalizer counts skipped jobs as done, so the fork's policy rests on
  // every publication the fork does not run keeping its own repository guard.
  assert.equal(
    workflow.jobs['publish-npm'].if,
    "${{ github.repository == 'openchamber/openchamber' && github.event.inputs.finish_published_release != 'true' }}",
  );
  assert.match(workflow.jobs['mobile-release'].if, /github\.repository == 'openchamber\/openchamber'/);

  const finalizeSteps = workflow.jobs['finalize-release'].steps;
  const discord = finalizeSteps.find((step) => step.name === 'Send release to Discord');
  assert.match(discord.if, /github\.repository == 'openchamber\/openchamber'/);
  const website = finalizeSteps.find((step) => step.name === 'Trigger openchamber-website site refresh (optional)');
  assert.equal(website.if, "${{ github.repository == 'openchamber/openchamber' }}");
});
