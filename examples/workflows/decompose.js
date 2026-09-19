/**
 * decompose.js — split a task, recurse, combine.
 *
 * Demonstrates: recursive `workflow()` nesting. The split agent proposes
 * subtasks (one schema call), each subtask runs as a nested `workflow()` of
 * this same file with `depth - 1`, and depth 0 does the work inline with a
 * single `agent()` instead of splitting again.
 *
 * Nesting is bounded by maxWorkflowDepth (default 6); this example only needs
 * two levels. A `workflow()` past the limit throws — catch it if you want to
 * fall back to doing the subtask here.
 *
 * args: { task?: string, depth?: number, fanout?: number }
 *
 * Run: ask the model — "run the workflow at examples/workflows/decompose.js".
 */
export const meta = {
  name: 'decompose',
  description: 'Split a task into subtasks, recurse, then combine the results',
  phases: [{ title: 'Split' }, { title: 'Work' }],
}

const task = args?.task ?? 'audit src/'
const depth = args?.depth ?? 1
const fanout = args?.fanout ?? 2

const SPLIT_SCHEMA = {
  type: 'object',
  properties: { subtasks: { type: 'array', items: { type: 'string' } } },
  required: ['subtasks'],
}

async function workInline() {
  phase('Work')
  const result = await agent(`Do this subtask: ${task}`, { label: `work:${task}` })
  return { task, subtasks: [], results: [{ task, result }] }
}

if (depth <= 0) {
  return await workInline()
}

phase('Split')
const split = await agent(`Split "${task}" into at most ${fanout} concrete subtasks.`, {
  label: 'split',
  schema: SPLIT_SCHEMA,
})
const subtasks = (split === null ? [] : split.subtasks ?? []).slice(0, fanout)

if (subtasks.length === 0) {
  return await workInline()
}

phase('Work')
const results = await parallel(subtasks.map(sub => () => workflow('decompose', { task: sub, depth: depth - 1, fanout })))
for (let i = 0; i < results.length; i++) {
  if (results[i] === null) throw new Error(`decompose: subtask "${subtasks[i]}" returned no result (it failed or hit maxWorkflowDepth)`)
}
return { task, subtasks, results }
