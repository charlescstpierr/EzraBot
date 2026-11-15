import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflows = new URL("../.github/workflows/", import.meta.url);

test("pull requests require no-mistakes without exemptions", () => {
  const { name, jobs, ...workflow } = parse(
    readFileSync(new URL("require-no-mistakes.yml", workflows), "utf8"),
  );
  assert.deepEqual(
    { ...workflow, jobs: Object.values(jobs) },
    {
      on: {
        pull_request: {
          types: ["opened", "edited", "synchronize", "reopened"],
        },
      },
      permissions: { contents: "read", "pull-requests": "read" },
      jobs: [
        {
          name: "PR must be raised via no-mistakes",
          "runs-on": "charles-ubuntu",
          steps: [
            {
              uses: "kunchenguid/no-mistakes/.github/actions/require-no-mistakes@5732d1ed88a1572fa6115d6ede5d69bfec097946",
            },
          ],
        },
      ],
    },
  );
});

test("no-mistakes configures the local checks and main base", () => {
  assert.deepEqual(
    parse(
      readFileSync(new URL("../.no-mistakes.yaml", import.meta.url), "utf8"),
    ),
    {
      commands: {
        prepare: "npm ci && npm ci --prefix server",
        lint: "npm run typecheck",
      },
      ignore_patterns: ["package-lock.json", "server/package-lock.json"],
      pr: { base_branch: "main" },
    },
  );
});

function checkRunners(source, file) {
  const workflow = parse(source);
  assert.ok(
    workflow?.jobs &&
      typeof workflow.jobs === "object" &&
      !Array.isArray(workflow.jobs),
    `${file} must define a jobs map`,
  );
  assert.ok(
    Object.keys(workflow.jobs).length > 0,
    `${file} must define at least one job`,
  );
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(
      job?.["runs-on"],
      "charles-ubuntu",
      `${file}: job ${name} must use runs-on: charles-ubuntu`,
    );
  }
}

const files = readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name));

test("workflow files exist", () => assert.ok(files.length > 0));

for (const file of files) {
  test(`${file} uses charles-ubuntu for every job`, () => {
    checkRunners(readFileSync(new URL(file, workflows), "utf8"), file);
  });
}

for (const [name, source] of [
  ["missing runs-on", "jobs: {build: {steps: []}}"],
  ["hosted runner", "jobs: {build: {runs-on: ubuntu-latest}}"],
  ["runner list", "jobs: {build: {runs-on: [charles-ubuntu]}}"],
  ["runner labels map", "jobs: {build: {runs-on: {labels: charles-ubuntu}}}"],
  ["missing jobs", "name: empty"],
  ["empty jobs", "jobs: {}"],
]) {
  test(`rejects ${name}`, () =>
    assert.throws(() => checkRunners(source, name)));
}

test("accepts the exact runner for every job", () => {
  checkRunners(
    "jobs: {build: {runs-on: charles-ubuntu}, test: {runs-on: charles-ubuntu}}",
    "valid",
  );
});
