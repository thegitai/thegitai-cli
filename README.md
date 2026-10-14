# TheGitAI — AI coding agent for your terminal

TheGitAI is an AI coding agent for terminal-based engineering work. Give it the
outcome you want: it investigates the repository, changes code across files,
runs the real project, verifies the result, and explains what is ready to
review.

![TheGitAI finding and fixing a failing test in a real repository](https://thegit.ai/demo.gif)

*A real session: a failing test, traced to its cause, fixed, and verified.*

**[Documentation](https://thegit.ai/docs/getting-started/introduction)** ·
**[Features](https://thegit.ai/features)** ·
**[Website](https://thegit.ai)**

## Quick start

```bash
npm i -g @thegitai/cli
cd your-project && ai
```

`ai` signs you in on the way if you aren't already. Node.js 22 or newer is
required, and Node.js 24 is recommended. If `ai` is already taken on your
machine, `thegitai` starts the same CLI.

See [Installation](https://thegit.ai/docs/getting-started/installation) and
[Authentication](https://thegit.ai/docs/getting-started/authentication).

## Ask for the finished outcome

You don't need to break a task into a chain of tiny prompts. Start with the
result and the evidence you expect:

```text
Trace the failing signup test, fix the underlying validation, run the focused
suite, check the final diff for regressions, and update the signup guide.
```

## What it can do

- **Understand** — search the repository, read the relevant files and related
  tests, and gather current web context.
- **Change** — create, patch, replace, and delete files across an
  implementation, its tests, configuration, and documentation.
- **Run** — use the shell, diagnostics, scratch scripts, and managed background
  processes in the real project environment.
- **Verify** — run tests, builds, linters, typecheckers, and final-diff checks
  as evidence for the handoff.
- **Work beyond source** — read PDFs, spreadsheets, and Word documents; edit
  visible DOCX text; inspect screenshots; and fetch public web pages.
- **Stay controllable** — ask for approval, work read-only in Plan mode, undo
  assistant edits, restore checkpoints, and resume repo-scoped sessions.

The full manual is [What It Can Do](https://thegit.ai/docs/core-features/what-it-can-do).

## Highlights

- **[Task list and parallel work](https://thegit.ai/docs/core-features/parallel-work-and-task-progress)**
  — a visible task list for multi-step work, up to six read-only lookups at
  once, and a queued follow-up message while the agent is still working.
- **[Background jobs](https://thegit.ai/docs/core-features/background-jobs)**
  — dev servers, watchers, and builds keep running with a live tail of their
  output. `/jobs` browses and stops them.
- **[Documents, images and web](https://thegit.ai/docs/core-features/documents-images-and-web)**
  — PDF, XLSX, and DOCX reading, DOCX text edits, pasted screenshots, and
  public web search and page fetches.
- **[MCP servers](https://thegit.ai/docs/core-features/mcp-servers)**
  — connect local stdio or remote HTTP tools with `ai mcp add`. `/mcp` shows
  their status and tools.
- **[Browser control](https://thegit.ai/docs/core-features/browser-control)**
  — with the TheGitAI Chrome extension, the agent works in the Chrome you
  already have open, signed in as you: cloud consoles, dashboards, and admin
  panels with no API.
- **[Saved sessions](https://thegit.ai/docs/sessions/saved-sessions)**
  — sessions are saved locally per repository. Resume one with `/resume` or
  `ai --session <id|name>`.

## Modes and safety

| Mode | Behavior |
|------|----------|
| **Default · Ask for Approval** | Asks before shell commands, file edits, browser actions, and MCP tool calls. |
| **Bypass all permissions** | Approves those actions for the rest of the session. Start with `ai -y`. Blocked commands stay blocked. |
| **Plan** | Read-only. The agent inspects, asks questions, and plans, but does not edit files or run project code. |

File and shell operations are confined to the repository. Assistant edits can
be undone and checkpoints restored. When an approved `sudo` command needs a
password, the prompt stays masked and local and the password is never sent to
the model or the server.

See [Sessions & Modes](https://thegit.ai/docs/basics/sessions-and-modes),
[Approvals & Guardrails](https://thegit.ai/docs/safety/approvals-and-guardrails),
and [Trust & Privacy](https://thegit.ai/docs/safety/trust-and-privacy).

## Everyday commands

```text
ai                       start a session in the current repo, signing in if needed
ai "<request>"           start a session with <request> as the first message
ai -y                    start in Bypass all permissions mode
ai --list-sessions       list saved sessions for this repo
ai --session <id|name>   resume a saved session
ai mcp add ...           connect an MCP server
ai --help                show commands, modes, keys, and options
```

Inside a session: `/model` picks a model and its reasoning effort, `/jobs`
manages background jobs, `/mcp` checks MCP connections, `/resume` reopens a
saved session, `/new` starts a fresh conversation, and `/help` shows the rest.

The complete list is in the [CLI Reference](https://thegit.ai/docs/reference/cli-reference).

## Documentation

- **Getting started** —
  [Introduction](https://thegit.ai/docs/getting-started/introduction) ·
  [Installation](https://thegit.ai/docs/getting-started/installation) ·
  [Authentication](https://thegit.ai/docs/getting-started/authentication)
- **Basics** —
  [Sessions & Modes](https://thegit.ai/docs/basics/sessions-and-modes) ·
  [Chat Commands](https://thegit.ai/docs/basics/chat-commands) ·
  [Keyboard & Mouse](https://thegit.ai/docs/basics/keyboard-and-mouse)
- **Core features** —
  [What It Can Do](https://thegit.ai/docs/core-features/what-it-can-do) ·
  [Parallel Work & Task Progress](https://thegit.ai/docs/core-features/parallel-work-and-task-progress) ·
  [Background Jobs](https://thegit.ai/docs/core-features/background-jobs) ·
  [Documents, Images & Web](https://thegit.ai/docs/core-features/documents-images-and-web) ·
  [MCP Servers](https://thegit.ai/docs/core-features/mcp-servers) ·
  [Browser Control](https://thegit.ai/docs/core-features/browser-control)
- **Sessions** —
  [Saved Sessions](https://thegit.ai/docs/sessions/saved-sessions) ·
  [Prompt History](https://thegit.ai/docs/sessions/prompt-history)
- **Safety & privacy** —
  [Approvals & Guardrails](https://thegit.ai/docs/safety/approvals-and-guardrails) ·
  [Trust & Privacy](https://thegit.ai/docs/safety/trust-and-privacy)
- **Reference** —
  [CLI Reference](https://thegit.ai/docs/reference/cli-reference) ·
  [Troubleshooting](https://thegit.ai/docs/reference/troubleshooting)

## About this repository

This repository is source-visible so you can inspect the client that runs on
your machine: the TypeScript CLI and the Rust terminal UI, local file and shell
tools, approvals, path containment, redaction, patch application, undo, and
local session storage. Server-owned behavior is not included.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Proprietary and source-visible. This source is published for inspection and
trust verification only; it is not open source. Copying, redistribution,
commercial use, sublicensing, derivative distribution, or use as a standalone
cloned product or hosted service is not permitted. See [LICENSE](LICENSE).
