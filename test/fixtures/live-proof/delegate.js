export const meta = { name: "live-delegate", description: "one worker delegates once" };
const a = await agent("Reply with exactly the token DEL_A and nothing else.", { label: "plain" });
const b = await agent(
  "Use the Agent tool to spawn one worker child that replies with exactly the token DEL_CHILD and nothing else. Then return the child's answer verbatim, prefixed with DEL_B:. Do nothing else.",
  { label: "delegator", agentType: "worker" },
);
return [a, b];
