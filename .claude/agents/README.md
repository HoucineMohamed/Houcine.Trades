# Review agents

Five **review helpers** (Claude Code "sub-agents") for this project. Each one is a plain text
file in this folder. They are advice-givers: they never replace the rules in the project's
`CLAUDE.md`, which always win (rules 1 to 9, paper mode, the risk engine's final say, step-up and
the authentication guards). Each file starts with the line "Houcine.Trades CLAUDE.md overrides this
agent." and a test (`tests/tooling/agents.test.ts`) fails if that line goes missing.

## The agents and what each is for

| Agent | What it is for (plain language) |
| --- | --- |
| `code-reviewer` | A general second pair of eyes on any change: bugs, readability, risky shortcuts. It also reads `CLAUDE.md` and checks the change follows the project's rules. |
| `typescript-reviewer` | Looks at TypeScript problems: loose types, mistakes with `async` code, unsafe patterns. Runs the type check, lint and tests. |
| `security-reviewer` | Hunts for security mistakes: secrets in code, unsafe input handling, injection, weak crypto. Runs `npm audit`. |
| `silent-failure-hunter` | Finds errors that are swallowed or hidden, and "fallbacks" that quietly continue when they should stop. This matches the project's "fail closed" rule. |
| `tdd-guide` | Helps write the tests first, then the code (test-driven development). Used when adding or changing domain logic. |

## What each agent is allowed to do

- **`tdd-guide` can write and edit files** (its tools are Read, Write, Edit, Bash and Grep). It is
  the only one that can change files.
- **The other four only read and run commands** (their tools are Read, Grep, Glob and Bash). They
  do not edit files.
- **Two agents run `npm audit`, which contacts the npm registry** over the internet:
  `security-reviewer` and `typescript-reviewer`.
- None of them installs anything, adds hooks or changes settings files. Nothing here may do that
  without the owner's explicit approval (see "Review workflow" in `CLAUDE.md`).

## Known gaps (left as they are on purpose)

- `tdd-guide` ends by pointing to a skill called `tdd-workflow`, which is **not** included here.
- `typescript-reviewer` mentions an agent called `react-reviewer`, which is **not** included here.

Those two pointers lead nowhere in this project. They were deliberately not added.

## Where they came from, and what was edited

These are edited copies of agents from the open-source project **everything-claude-code**
(https://github.com/affaan-m/everything-claude-code), commit
`ef648e01899ba3e8dc6371642deaaf64b4477775`, by Affaan Mustafa. They were vetted and edited in the
owner's `houcine-tools` repository (`staging/claude-components/`, see its `EDIT-NOTES.md`). The edits:

- All five: added the line `> Houcine.Trades CLAUDE.md overrides this agent.` and an HTML comment
  saying the file is an edited copy.
- `security-reviewer`: removed the line `npx eslint . --plugin security` (it could make `npx`
  download code).
- `tdd-guide`: removed the "80%+ test coverage" wording, the "Verify Coverage" step and the
  "Supabase, Redis, OpenAI" examples.

The files are kept byte for byte as vetted (this folder is in `.prettierignore` so the formatter
does not change them).

## License and attribution

These files are derived from everything-claude-code by Affaan Mustafa, used under the MIT License,
which requires this notice to be kept:

```
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
