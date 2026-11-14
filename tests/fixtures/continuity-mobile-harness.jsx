import React from "react";
import { createRoot } from "react-dom/client";
import { Work } from "../../server/mobile/src/details";
import { MobileSnapshotSchema } from "../../server/src/mobile-protocol";

const snapshot = MobileSnapshotSchema.parse({
  ...(await (await fetch("/api/view")).json()),
  schemaVersion: 1,
});
const work = snapshot.works.find(
  (work) => work.id === new URLSearchParams(location.search).get("workId"),
);
const root = document.getElementById("root");
if (!root || !work) throw Error("Travail synthétique absent");
createRoot(root).render(
  <Work
    work={work}
    snapshot={snapshot}
    send={async () => {
      throw Error("Preuve en lecture seule");
    }}
    canApprove={false}
  />,
);
