/**
 * worklist-crawl.js — drain a dynamic queue that grows while it runs.
 *
 * Demonstrates: `worklist(seeds, fn)` with `add()` enqueuing one follow-up
 * for exactly one seed. Each item runs one `agent()`; the follow-up adds
 * nothing further, so the queue always drains.
 *
 * args: { tasks?: string[] } — seeds to crawl, default ["alpha", "beta"]
 *
 * Run: ask the model — "run the workflow at examples/workflows/worklist-crawl.js".
 */
export const meta = {
  name: 'worklist-crawl',
  description: 'Crawl two tasks, following up once on the first',
  phases: [{ title: 'Crawl' }],
}

const seeds = args?.tasks ?? ['alpha', 'beta']

phase('Crawl')
const entries = await worklist(seeds, async (item, add) => {
  const result = await agent(`Crawl ${item}. Report briefly.`, { label: `crawl:${item}` })
  if (result === null) throw new Error(`worklist-crawl: item "${item}" returned no result`)
  if (item === seeds[0]) add(`${item}-followup`)
  return result
})

return entries.map(e => ({ item: e.item, result: e.result }))
