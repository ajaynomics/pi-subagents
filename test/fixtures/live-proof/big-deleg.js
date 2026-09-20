export const meta = { name: "live-proof-deleg", description: "recursive run whose leaves delegate once" };
const SELF = "/tmp/wf-live-big/big-deleg.js";
const task = args?.task ?? "root";
const depth = args?.depth ?? 3;

async function oneAgent(token, label, useWorker) {
  const opts = useWorker ? { label, agentType: "worker" } : { label };
  return await agent(`Reply with exactly the token ${token} and nothing else.`, opts);
}

if (depth <= 0) {
  const tok = `LEAF_${task.replace(/[^A-Za-z0-9]/g, "_")}`;
  const childTok = `GC_${task.replace(/[^A-Za-z0-9]/g, "_")}`;
  const r = await agent(
    `Use the Agent tool to spawn one worker child that replies with exactly the token ${childTok} and nothing else. Then return the child's answer verbatim, prefixed with ${tok}:. Do nothing else.`,
    { label: `leaf:${task}`, agentType: "worker" },
  );
  return { task, result: r };
}

const survTok = `SURV_${task.replace(/[^A-Za-z0-9]/g, "_")}`;
const survey = await oneAgent(survTok, `survey:${task}`, false);
const kids = await parallel([0, 1].map(i => async () => {
  return await workflow({ scriptPath: SELF }, { task: `${task}.${i}`, depth: depth - 1 });
}));
let extra = [];
if (task === "root") {
  const items = await worklist(["w1", "w2"], async (item, add) => {
    if (item === "w1") add("w1b");
    const tok = `WL_${item.replace(/[^A-Za-z0-9]/g, "_")}`;
    return await oneAgent(tok, `wl:${item}`, true);
  });
  extra = items;
}
return { task, survey, kids, extra };
