import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openMissions } from "../src/missions.js";

test("the agents view revision advances across process restarts", (t) => {
  const base = mkdtempSync(join(tmpdir(), "ezrabot-revision-"));
  const home = join(base, "home"),
    project = join(home, "project"),
    dataDir = join(base, "service", "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const options = {
    path: join(dataDir, "missions.sqlite"),
    minoRoot: join(base, "service"),
    dataDir,
    home,
  };
  const first = openMissions(options);
  const added = first.dispatch({
    type: "project.add",
    requestId: "revision-project-0001",
    path: project,
  });
  assert(added.ok);
  const before = first.view().rev;
  first.close();
  t.mock.method(Date, "now", () => 0);
  const second = openMissions(options);
  try {
    assert(
      second.view().rev > before,
      "a browser holding the old revision must accept the restarted server snapshot",
    );
    assert.equal(second.view().projects[0]?.id, added.id);
  } finally {
    second.close();
  }
});

test("the first upgrade of a legacy database advances past an open browser revision", () => {
  const base = mkdtempSync(join(tmpdir(), "ezrabot-legacy-revision-"));
  const project = join(base, "home", "project");
  const dataDir = join(base, "service", "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const options = {
    path: join(dataDir, "missions.sqlite"),
    minoRoot: join(base, "service"),
    dataDir,
    home: join(base, "home"),
  };
  const initial = openMissions(options);
  assert(
    initial.dispatch({
      type: "project.add",
      requestId: "legacy-project-0001",
      path: project,
    }).ok,
  );
  initial.close();
  const legacy = new DatabaseSync(options.path);
  legacy.prepare("DELETE FROM meta WHERE key = 'view_rev'").run();
  legacy.close();
  const browserRevision = 10;
  const upgraded = openMissions(options);
  try {
    assert(
      upgraded.view().rev > browserRevision,
      "the first upgraded snapshot must replace the old process snapshot without a reload",
    );
    assert.equal(upgraded.view().projects.length, 1);
    const before = upgraded.view().rev;
    assert(
      upgraded.dispatch({
        type: "project.update",
        requestId: "legacy-project-0002",
        projectId: upgraded.view().projects[0]!.id,
        checkCommand: "node --version",
      }).ok,
    );
    assert(upgraded.view().rev > before);
  } finally {
    upgraded.close();
  }
});
