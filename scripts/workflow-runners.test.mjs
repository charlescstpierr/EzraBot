import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const RUNNER = "charles-ubuntu";
const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");

function jobsOffRunner(source) {
  const jobs = parse(source)?.jobs;
  if (!jobs || Object.keys(jobs).length === 0) return ["<aucun job>"];
  return Object.entries(jobs)
    .filter(([, job]) => job?.["runs-on"] !== RUNNER)
    .map(([id, job]) => `${id}: runs-on=${JSON.stringify(job?.["runs-on"])}`);
}

test("chaque job de chaque workflow tourne sur charles-ubuntu", () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0, `aucun workflow dans ${WORKFLOWS}`);
  const offenders = files.flatMap((name) =>
    jobsOffRunner(readFileSync(join(WORKFLOWS, name), "utf8")).map(
      (job) => `${name} ${job}`,
    ),
  );
  assert.deepEqual(offenders, []);
});

test("un job sans charles-ubuntu exact est refusé", () => {
  const source = `
jobs:
  ok: { runs-on: charles-ubuntu }
  absent: { steps: [] }
  hosted: { runs-on: ubuntu-latest }
  list: { runs-on: [charles-ubuntu] }
  group: { runs-on: { labels: charles-ubuntu } }
`;
  assert.deepEqual(jobsOffRunner(source), [
    "absent: runs-on=undefined",
    'hosted: runs-on="ubuntu-latest"',
    'list: runs-on=["charles-ubuntu"]',
    'group: runs-on={"labels":"charles-ubuntu"}',
  ]);
  assert.deepEqual(jobsOffRunner("on: push\n"), ["<aucun job>"]);
});
