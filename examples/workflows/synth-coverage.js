/**
 * synth-coverage.js — synthesize without dropping a topic.
 *
 * Demonstrates: a synth stage that PROVES full coverage. The synth agent
 * returns one verdict per topic key through `schema` (shape), and the script
 * asserts every input key got a verdict (coverage) — a synth that drops a
 * topic fails the run loudly instead of passing quietly.
 *
 * Reach for this whenever a synthesis fans in N inputs: pass stable keys
 * (not free-text labels), demand one verdict per key, and throw naming the
 * missing ones.
 *
 * args: { topics?: string[] } — topic keys, default alpha + beta
 *
 * Run: ask the model — "run the workflow at
 * examples/workflows/synth-coverage.js".
 */
export const meta = {
  name: 'synth-coverage',
  description: 'Research each topic, then synthesize one verdict per topic key',
  phases: [{ title: 'Research' }, { title: 'Synthesize' }],
}

const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          decision: { type: 'string' },
        },
        required: ['topic', 'decision'],
      },
    },
  },
  required: ['verdicts'],
}

const topics = args?.topics ?? ['alpha', 'beta']

// One researcher per topic key. Prose is fine here — the synth is what needs
// the shape, and its prompt carries everything below.
const research = await parallel(
  topics.map(topic => () =>
    agent(`Research the topic "${topic}". Report what matters.`, {
      label: `research:${topic}`,
      phase: 'Research',
    }),
  ),
)

const synth = await agent(
  [
    'Synthesize the research into one verdict per topic key.',
    `Cover every topic key exactly once: [${topics.join(', ')}]`,
    ...research.map((notes, i) => `--- ${topics[i]} ---\n${notes ?? '(researcher returned nothing)'}`),
  ].join('\n'),
  { label: 'synth', phase: 'Synthesize', schema: VERDICTS },
)

// A schema call can still resolve to null (skipped, or never answered through
// the tool). Say so by name rather than dying on `null.verdicts`.
if (synth === null) {
  throw new Error('synth returned nothing — no verdicts to check coverage against')
}

// Shape is the schema's job; coverage is the script's. A synth that drops a
// topic fails HERE, naming it — the run goes red instead of green-but-lossy.
const covered = new Set(synth.verdicts.map(v => v.topic))
const missing = topics.filter(topic => !covered.has(topic))
if (missing.length > 0) {
  throw new Error(`synth dropped topics: ${missing.join(', ')} — re-run the synth with every key`)
}

return { topics: topics.length, verdicts: synth.verdicts }
