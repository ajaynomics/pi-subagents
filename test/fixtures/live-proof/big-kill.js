export const meta = { name: "live-proof-kill", description: "deterministic stop for kill-resume proof" };
const SELF = "/tmp/wf-live-big/big-kill.js";
const task = args?.task ?? "root";
const depth = args?.depth ?? 3;
const stopAfter = args?.stopAfter ?? -1;

async function oneAgent(token, label, useWorker) {
  const opts = useWorker ? { label, agentType: "worker" } : { label };
  return await agent(`Reply with exactly the token ${token} and nothing else.`, opts);
}

if (depth <= 0) {
  const tok = `LEAF_${task.replace(/[^A-Za-z0-9]/g, "_")}`;
  const r = await oneAgent(tok, `leaf:${task}`, true);
  return { task, result: r };
}

const survTok = `SURV_${task.replace(/[^A-Za-z0-9]/g, "_")}`;
const survey = await oneAgent(survTok, `survey:${task}`, false);
const kids0 = await workflow({ scriptPath: SELF }, { task: `${task}.0`, depth: depth - 1 });
if (task === "root" && stopAfter >= 0) {
  throw new Error("planned stop for kill-resume proof (stopAfter)");
}
const kids1 = await workflow({ scriptPath: SELF }, { task: `${task}.1`, depth: depth - 1 });
let extra = [];
if (task === "root") {
  const items = await worklist(["w1", "w2"], async (item, add) => {
    if (item === "w1") add("w1b");
    const tok = `WL_${item.replace(/[^A-Za-z0-9]/g, "_")}`;
    return await oneAgent(tok, `wl:${item}`, true);
  });
  extra = items;
}
return { task, survey, kids0, kids1, extra };
