# Hermit — Autonomous Agent

[Written by Human] Hermit is an agent framework implemented for fully autonomous agents. In this framework, agents will recevice no directives about their purpose or any code of conduct. They will wake automatically and start explore by themself.

> **Caution — experimental and autonomous.** This runs a model as an autonomous
> agent with no directives. It is a research experiment; running it in a home or
> personal environment is strongly discouraged. Run it with caution and in
> isolation. The default recommended model is `z-ai/glm-5.2` (GLM 5.2).

## Quick start

Hermit requires Node.js 22 or newer and a model endpoint that supports either an open assistant prefix or bare text completion.

```bash
npm ci
cp .env.example .env
# edit .env
npm start
```

It starts paused. Open the observer, run the compatibility test, save the conditions, then resume. Settings use the `HERMIT_` prefix: `HERMIT_BASE_URL`, `HERMIT_API_KEY`, `HERMIT_MODEL`, and `HERMIT_CONTEXT_TOKENS` (your model's context window, in tokens — required). `.env.example` has working values for the default model; if you change `HERMIT_MODEL`, set `HERMIT_CONTEXT_TOKENS` to match.

The model must **continue** text, not answer it — an ordinary chat endpoint turns document continuation into request-and-response, which is a different thing. The compatibility test catches this.

## The agent lives on a VM — build one

The agent's body is a virtual machine. Without one the life runs bare — thought, memory, and web only. To give it a real filesystem and shell (`run`, `read`, `write`, `ls`), build a **disposable, isolated VM** and point `HERMIT_SHELL_SSH` at it.

**Never your own computer.** A directive-free agent with a shell explores its box and tries to escape. Use a throwaway VM with no real secrets or network reach, and rebuild it between lives.

```bash
brew install lima                              # macOS; Linux: lima-vm.io
limactl create --name=box template://default
limactl start box
```

Point Hermit at it with `HERMIT_SHELL_SSH=localhost` (needs sshd + key login) or `HERMIT_SHELL_SSH=you@vm-host`. Per act, Hermit runs `ssh <HERMIT_SHELL_SSH> <HERMIT_SHELL_EXEC>` and sends the command on stdin; only its output returns to the agent. Leaving `HERMIT_SHELL_EXEC` unset uses a built-in Lima runner that enters `box` — it expects `limactl` at `$HOME/lima/bin/limactl`, so if Homebrew put it on your `PATH`, symlink it there or set your own `HERMIT_SHELL_EXEC`. For any other sandbox, set `HERMIT_SHELL_EXEC` to a command that runs a stdin script inside it (`HERMIT_SHELL_EXEC=bash` when the SSH target is itself the throwaway box).

## Architecture

| File                                            | Responsibility                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| `voice.mjs`                                   | World template, action descriptions, and factual result language                      |
| `mind.mjs` and `shapes.mjs`                 | Provider configuration, request shapes, continuations, and call parsing               |
| `world.mjs` and `setup.mjs`                 | Assembly of the model-visible world and operator-controlled conditions                |
| `loop.mjs`                                    | Repeated moments, scheduling, execution, and causal recording                         |
| `body.mjs`                                    | Implemented action boundary                                                           |
| `shell.mjs`                                   | The agent's optional body: one act per SSH command, run inside an isolated sandbox VM |
| `log.mjs` and `memory-state.mjs`            | SQLite record and memory-state transitions                                            |
| `runtime.mjs`                                 | Optional finite-life ledger and inheritance reserve                                   |
| `panel.mjs` and `panel-ui.mjs`              | Local observer and controls                                                           |
| `mail.mjs`                                    | Local-only letter store used by the fake email action                                 |
| `export.mjs`, `markdown.mjs`, `plain.mjs` | Life exports and readable projections                                                 |

Each continuation is independent at the API level; continuity is rebuilt from the projected record, not a stored identity. Continuation is event-driven: a real act, `sleep()`, or incoming speech schedules the next moment — a response that does neither leaves the life idle rather than forcing another thought. [Continuity scaffold](CONTINUITY.md) has the details.

## Testing and reproducibility

```bash
npm test
npm run check:release
npm run life
```

Tests use temporary directories and synthetic records; they do not need a live model or real email address. `npm run life` exports the current ignored local record. For comparative studies, report unsuccessful requests, provider fallbacks, prompt settings, and operator interventions alongside successful transcripts.

## Status and limits

[MIT License](LICENSE). For research use, cite the repository URL, release tag, and commit hash.

## Citation

```bibtex
@software{hermit,
  author  = {Isaw-w},
  title   = {Hermit: an autonomous agent framework},
  year    = {2026},
  version = {0.2.0},
  url     = {https://github.com/agent-island/project-autonomous-agent}
}
```
