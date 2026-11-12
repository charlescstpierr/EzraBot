import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openMissions } from "../src/missions.js";

test("the agents view revision advances across process restarts", () => {
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
