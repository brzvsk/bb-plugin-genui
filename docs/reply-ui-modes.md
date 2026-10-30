# UI in replies: the two reply modes

This is the design note for the plugin's *UI in replies* setting: why it exists,
what the two modes inject, how it is wired, and what the prompt battery and a
few days of real use showed.

## The problem

An agent that has learned the components tends to use them wherever a shape
appears: a comparison becomes a table, a status becomes a row of metrics, a
plan becomes a Timeline. That is usually right. But some replies read fine as
prose, and a block added to those replies is noise: the user has to parse a
card to learn something a sentence already said.

The setting lets the same agent use the same language and components with a
different rule about when a block is allowed, without changing the component
set or the rendering path.

## The two modes

Both modes get the full reference (`UI_REFERENCE` and `UI_REFERENCE_MORE` on
the `check_ui` and `ui_examples` tools), the code-work contribution, and no
skills. They differ in the configure text and the code-work section.

- **Prefer visuals** (default) keeps the upstream injection byte for byte.
  `AGENT_INSTRUCTIONS` asks for a block wherever part of the reply is better
  seen or used than read, and `CODE_WORK_INSTRUCTIONS` says which component
  shows each kind of tool output. A reply that would pass the technical checks
  but silently changed this text would violate the compatibility promise.
- **When it helps** uses `AGENT_INSTRUCTIONS_BALANCED` and
  `CODE_WORK_INSTRUCTIONS_BALANCED`. The language and components are the same,
  but a block must replace something worse in the same reply: a markdown
  table, pasted code or output, an ASCII or mermaid diagram, a hand-formatted
  series, a schedule, or a question with options. A concept, opinion,
  narrative, short fact, wording help or status stays prose. At most one block
  is allowed per reply. After a task, prose is the default; a failure, error,
  review, or output the user explicitly asked to see earns the block.

The mode is a `select` setting in `reply-ui.ts`, with exactly those two
options and *Prefer visuals* as the default. A stored value that is no longer
an option, including a previously stored *Only when asked*, resolves through
the same unknown-value path to the default.

## How it is wired

- `reply-ui.ts` defines the setting and a pure `replyUiConfiguration(mode, webOn)`
  that returns the instructions, the code-work section (or `null`), and the
  tool list for one session. It is pure so the tests can compare the exact
  strings without a running plugin.
- The setting is read like `web/lookups.ts`: `bb.settings.define` declares it,
  `settings.get()` fills a cached value, and `settings.onChange` refreshes it.
  `bb.agents.configure` needs a synchronous answer, so it reads that cache
  rather than awaiting settings.
- `server.ts` resolves one configuration per session in `bb.agents.configure`,
  remembers the code-work string per person-facing thread, and serves it
  through `bb.agents.contributeInstructions`. The code-work section therefore
  reaches exactly the sessions that get the other sections, and the stored
  string cannot mix modes if the setting changes between the two calls.
- `reply-ui.test.ts` keeps the default injection byte-identical, keeps the
  balanced constants unchanged, and checks the two-option select and the
  unknown/stored-value fallback.

## The battery

`scripts/reply-ui-battery.mjs` runs 40 single-turn prompts, one run per prompt
per mode and model, through headless `claude -p` with exactly the text the
plugin injects. It counts `ui` and `app` code blocks and compiles each one with
the plugin's own parser and app linter. Models were Haiku 5.5 and Sonnet 5.5.

Prompts are labelled by what the right answer is:

- **V** (15): the content is natively visual, such as a comparison, series,
  flow, calculator or choice.
- **P** (16): prose is the right answer, such as a concept, opinion,
  narrative, short fact, wording help or status.
- **A** (9): the user explicitly asks for a visual or interactive form.

Results below are for the two current modes only. Rates are replies with at
least one block; compile is blocks that compiled over all blocks; `<=1` is
replies with at most one block. `V no block + table` counts V replies that fell
back to a markdown table instead of a component.

| Mode | Model | V | P | A | All | Compile | <=1 block | V no block + table |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Prefer visuals | Haiku 5.5 | 15/15 (100%) | 5/16 (31.3%) | 9/9 (100%) | 29/40 (72.5%) | 34/35 (97.1%) | 35/40 (87.5%) | 0 |
| Prefer visuals | Sonnet 5.5 | 15/15 (100%) | 7/16 (43.8%) | 9/9 (100%) | 31/40 (77.5%) | 43/45 (95.6%) | 32/40 (80.0%) | 0 |
| When it helps | Haiku 5.5 | 15/15 (100%) | 0/16 (0%) | 9/9 (100%) | 24/40 (60.0%) | 24/24 (100%) | 40/40 (100%) | 0 |
| When it helps | Sonnet 5.5 | 14/15 (93.3%) | 0/16 (0%) | 9/9 (100%) | 23/40 (57.5%) | 23/23 (100%) | 40/40 (100%) | 0 |

The battery is a development instrument, not a held-out benchmark: the same
prompts tuned the texts. A V miss on Sonnet (a test-run summary answered in
prose) and P misses on the first balanced draft each produced a paragraph or
example that then went into `AGENT_INSTRUCTIONS_BALANCED` or
`CODE_WORK_INSTRUCTIONS_BALANCED`. The numbers above are the final one-run
pass, not an independent estimate for a new prompt set.

## Real use

The author used *When it helps* for three days and kept it. *Only when asked*
was never used, which is why it and its stub, skill, tests and battery path
were removed rather than kept as an unused third option.
