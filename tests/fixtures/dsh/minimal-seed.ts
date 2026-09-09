/** Balanced v2 replay seed used by gateway tests; no constructor/live events. */
export const MINIMAL_DSH_SEED = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1,
    data: {
      id: 'fixture-user',
      role: 'user',
      content: [{ type: 'text', text: 'Imported fixture context.' }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-threadbridge',
        sourceAgent: 'codex',
        sourceSessionId: 'source-session-1',
        rolloutRevisionId: 'rollout-1',
        fingerprint: 'fingerprint-123456',
        mode: 'full',
        compilerSchema: '1.0.0',
        form: 'notice',
        summary: 'Imported read-only Codex history; historical tools were not executed.',
      },
    },
    surfaceOp: 'append',
  },
  { type: 'step/end', seq: 3, time: 1, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 4, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
] as const
