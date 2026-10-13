# TheGitAI — AI coding agent for your terminal

TheGitAI is an AI coding agent for your terminal. It reads and searches your repository,
writes and edits files, runs commands, and builds features with you.

Talk to your repo in plain English. TheGitAI can keep long-running processes
going while you work, all with your approval.

## Install

```bash
npm i -g @thegitai/cli
```

Supports Node.js 22 and newer. Node.js 24 is recommended.

This installs the `ai` command. If `ai` is already taken by another command on
your machine, `thegitai` starts the same CLI.

## Updates

`ai` checks for a newer release each time it starts, and offers to install it
for you. TheGitAI works best on the latest version, and an older CLI may not
work optimally. **Update now** is already selected, so Enter takes it — the CLI
installs the update and asks you to start `ai` again, so the whole session runs
one version — while ↑/↓ moves to **Skip** to go on with the version you have. Skipping lasts for that session
only; the next start asks again. Ctrl+C quits without installing anything.

## Usage

```text
ai                  sign in if needed, then start a session in the current repo
ai "<request>"      start a session with <request> as the first message
ai login            the same as `ai`; kept for muscle memory
ai whoami           show the signed-in account
ai --usage          show account usage and reset times
ai logout           sign out
ai --version        print the version and exit
```

Run `ai --help` for sessions, modes, keys, and chat commands.

Coding sessions require an interactive terminal on stdin and stdout. Piped
one-shot prompts are not supported. Saved history is local to the repo and can
always be viewed or resumed from that computer. Continuing it through the
service requires the TheGitAI account used for that session. Local sessions can
also be listed while signed out or offline.

Signing in opens your browser. The same screen also prints a URL you can open on
any other device and a box for an authorization code, so SSH and headless
machines need no separate command: open the URL wherever you have a browser,
choose "On another computer" on that page, and paste the code it shows.

CLI login tokens use a rolling 48-hour inactivity timeout. If one expires during
any server request, the CLI removes the expired credential and signs you in
again on the next run.

## Models and reasoning effort

Type `/model` to choose a model with **↑ / ↓** and adjust its reasoning effort
with **← / →** in the same panel: **Default / Low / Balanced / Deep**.
**Enter** saves the selected model's choice for this project; **Esc** cancels.
Each model remembers its own choice across new and resumed sessions.
The picker and footer show the effort beside the model name. The footer labels
agent mode separately as `Mode: ...`; narrow terminals place it on the next
line, keeping both settings visible while idle and working.

Default uses TheGitAI's current recommended setting for the model. Low favors
quicker responses, Balanced balances depth and speed, and Deep favors thorough
reasoning and may take longer and cost more. Choosing Default again clears your
override. Switching models preserves your conversation.
An invalid project preference file loads Default effort; saving refuses to
overwrite it until the file is repaired or removed.

## When the connection drops

A dropped connection does not end your turn. The CLI shows
`Connection interrupted · retrying in 10s · retry 1/3` under the working timer,
waits ten seconds, and reconnects to the same turn — it never starts the request
over, and a command, edit or browser action that already ran is not run again.
It tries three times. Once it is back, the turn simply continues and a short
`Connection restored` note stays in the transcript.

The same applies when you start `ai` while TheGitAI is briefly unavailable:
startup shows `Couldn't reach TheGitAI (…) · retrying in 10s · retry 1/3` and
waits up to three times before giving up.

If TheGitAI itself restarted while it was working, the turn cannot resume
where it was. It continues instead: the CLI sends your request once more with
the steps that already finished on your machine and everything you told it
during the turn, and the work picks up from there — a command that already ran
is not run again, and a correction you made still stands — with a short
`Server restarted` note in the transcript.

Press Esc at any point to stop the turn instead. If all three retries fail, the
turn ends with an error that names what was interrupted, notes that some actions
may already have completed, and leaves anything you had queued in the composer
rather than sending it on top of a turn whose outcome is unknown.

## MCP servers

Connect external tools with the Model Context Protocol (MCP). TheGitAI supports
local **stdio** servers and remote **Streamable HTTP** servers through the
official MCP SDK. Setup uses familiar `mcp` commands:

```bash
# Remote documentation tools
ai mcp add --transport http context7 https://mcp.context7.com/mcp

# Local browser tools in a separate, temporary browser profile
ai mcp add playwright -- npx -y @playwright/mcp@latest --headless --isolated

ai mcp list
ai mcp get context7
ai mcp disable playwright
ai mcp enable playwright
ai mcp remove playwright
```

Inside a chat, run **`/mcp`** to connect and see each server's status and tools.
Configured tools are connected in parallel and made available to the active
model. Tool lists are cached for one minute and refreshed when the server reports
a change. Failed connections wait one minute before retrying; `/mcp` retries
immediately, and a check you cancel is retried on the next turn. Ask normally, or name the server when you want it used—for
example, “Use Context7 to check the current API for this library.” Configuration
changes apply on the next turn or `/mcp`; they do not change an in-flight turn.
`ai mcp list` shows configuration without starting servers. `get` shows metadata
without printing URLs, arguments, or credential values.

For authentication, use headers or explicitly pass environment variables:

```bash
# Set CONTEXT7_API_KEY in your environment first. Single quotes keep the
# placeholder in the config instead of saving the secret itself.
ai mcp add --transport http docs https://mcp.context7.com/mcp \
  --header 'Authorization: Bearer ${CONTEXT7_API_KEY}'

ai mcp add --env SERVICE_TOKEN='${SERVICE_TOKEN}' local-tools -- my-mcp-server
```

The short flags `-t`, `-e` and `-H` mean `--transport`, `--env` and `--header`.
`-s user` / `--scope user` is accepted; project and local scopes are unavailable.

Values support `${VARIABLE}` and `${VARIABLE:-default}` expansion when connecting.
Missing variables produce a visible connection error. Local servers inherit a
small standard environment (such as PATH and HOME); explicitly pass service
credentials with `--env`. A local server starts in the current repository.

To reuse a server's JSON setup instructions:

```bash
ai mcp add-json docs '{"type":"http","url":"https://mcp.context7.com/mcp"}'
ai mcp add-json local-tools '{"command":"my-mcp-server","args":[],"env":{}}'
```

Configuration is saved for your user on this machine, in `mcp.json` under the
TheGitAI state directory. `ai mcp list` prints the exact path. On Linux and macOS,
the default is `~/.local/state/thegitai/mcp.json` (or under `XDG_STATE_HOME`);
on Windows it is `%LOCALAPPDATA%\thegitai\mcp.json`. The file uses an
`mcpServers` object keyed by server name; each
entry accepts `disabled` and an optional `timeout` in milliseconds (1,000–300,000,
default 60,000). The CLI does not load project `.mcp.json` files.

**Approvals and limits:** Default mode asks before each MCP call; you can approve
one call or allow that specific server/tool for the session. `/new` clears these
grants. Bypass mode approves MCP calls automatically. Plan mode blocks MCP calls,
including tools a server labels read-only. Adding a local server authorizes
starting its configured program; only add servers you trust. MCP servers can
access files or external services using their own permissions, and their changes
are not covered by TheGitAI's file-edit undo.

Server credentials and connection settings stay on your machine. Discovered tool
names, descriptions and schemas, call arguments, and results are used for your
model requests. Text, structured results, and images are supported. Audio and
binary resources are reported as unsupported. Timeouts or disconnects can leave
an action's outcome unknown; TheGitAI does not automatically repeat MCP calls.

This release supports MCP **tools**, up to 128 tools / 100 KiB of definitions per
turn (about 25,600 estimated tokens). Tool descriptions can contain up to 4,096
characters. Servers are admitted in configuration order; a server exceeding a
limit is shown as unavailable in `/mcp` while chat continues with the other tools.
Invalid server entries are shown individually and can be disabled or removed with
`ai mcp`. Invalid JSON disables MCP tools for the turn and is shown by `/mcp`;
repair the file before using configuration commands.

MCP results share a 25,000 estimated-token limit across text and structured
content, enough for a typical browser page snapshot to arrive whole. Larger
results keep the start and end of their long text blocks, mark the omitted
middle and report the original size, so the agent can request a narrower query;
short blocks stay whole. Duplicate JSON text accompanying a structured result is
included once.

The SDK client runtime is bundled with the CLI at reviewed versions; installing
MCP support adds no runtime npm dependencies.

Browser-based OAuth login, standalone MCP resources/prompts, older SSE-only
servers, and plugin installation are not included. Context7 may require an API key
or impose rate limits; Playwright requires a supported installed browser.

Run `ai mcp --help` for the command reference.

## Chrome browser control

The TheGitAI Chrome extension is separately installed. After installing it,
start `ai` normally and ask about your current tab or a website task. It uses
your existing Chrome profile, website sessions, and terminal login. Connection
is automatic; no setup/start command, second sign-in, or manual tab attachment
is required. Tabs used by the agent join a TheGitAI tab group in an existing
window. The conversation stays in your terminal.

Default mode asks before using a website and can remember that site for the
session. Bypass all permissions allows browser actions; Plan mode reads pages
without clicking, typing, or navigating. Use Stop/Resume in the extension popup to
pause browser control, or Disable to disconnect it. Chrome's protected pages,
including browser settings and extension management, cannot be controlled.

The extension is currently a development download and is not yet listed in the
Chrome Web Store. Its version and distribution are independent of this npm
package. Ubuntu with Chrome is the initial validation target.

## Structured questions


The agent can pause its current turn to ask up to four related questions in one
form. Use **↑ / ↓**, the displayed option number, or **Enter** to choose, and
**← / →** to move between questions. **Something else / add details** is the
numbered final option; focus it and type, paste, or press **Enter** to add a
single-line note; **Enter** commits it and moves on the way any other choice
does — to the next question, or to **Submit answers** on the last one — without
submitting the form. On single-select questions it is mutually exclusive with
the listed choices, and **↑ / ↓** leaves its editor when the note is empty.
Multi-select questions toggle choices. The last question has an explicit
**Submit answers** row. **Esc** closes an open note first and otherwise cancels
the form; **Ctrl+C** cancels the whole turn.

Only the option you are on shows its description, so the whole form — every
option, the note row, **Submit answers**, and the key hints — stays on screen
without scrolling. Move between options to read the others.

Answers return to the same turn, and completed question/answer records remain
readable when the session is resumed. Default, Bypass all permissions, and Plan
modes all support the form; Bypass all permissions does not choose answers for
you.

## Visible to-do list

For larger multi-step tasks, the agent keeps a compact to-do list on screen so
you can see what it plans to do, what it is working on right now, and what is
already done.

- While the agent works, the list sits at the bottom of the live **Working**
  area, right above where you type, and updates as steps start and finish —
  one step in progress at a time — so it stays visible even when tool output
  above it runs long.
- When the turn ends, a final snapshot of the list stays readable in the
  transcript, and the footer shows a small progress chip (e.g. `◐ 4/6 to-dos`)
  while steps remain open.
- The agent's current reasoning stays visible too, right below the list, in a
  compact one-line form so it doesn't compete with the list for space.
- The list is managed entirely by the agent; simple one-step requests skip it.

## Background jobs

Some commands are meant to keep running — a dev server, a file watcher, a local
API. TheGitAI runs these as **background jobs**, so the agent can start a server,
work against it live, and stop it when the task is done, all in one session.

- Each job's block in the transcript updates on its own with a live tail of its
  latest output, and a compact indicator keeps you aware of what's still running.
- Type `/jobs` to open a picker: **↑ / ↓** to move, **Enter** to expand a job and
  read its output inline, **k** to stop it, **Esc** to close.
- `/jobs output <id>` prints a job's full output, and `/jobs kill <id>` stops one
  by id.
- When waiting for a job is all that's left, the agent can hand control back to
  you and continue automatically once the job finishes on its own.
- When you end the session, TheGitAI stops its background jobs for you.

Full documentation: <https://thegit.ai/docs>

## License

Proprietary — see the LICENSE file included in this package. Source is
visible for inspection; copying and redistribution are not permitted.
