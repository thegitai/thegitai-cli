# TheGitAI — AI coding agent for your terminal

TheGitAI is an AI coding agent for your terminal. It reads and searches your repository,
writes and edits files, runs commands, and builds features with you.

Talk to your repo in plain English. TheGitAI can keep long-running processes
going while you work, all with your approval.

## Install

```bash
npm i -g @thegitai/cli
```

Requires Node.js 24 or newer.

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

## Structured questions

The agent can pause its current turn to ask up to four related questions in one
form. Use **↑ / ↓**, the displayed option number, or **Enter** to choose, and
**← / →** to move between questions. **Something else / add details** is the
numbered final option; focus it and type, paste, or press **Enter** to add a
single-line note. On single-select questions it is mutually exclusive with the
listed choices, and **↑ / ↓** leaves its editor when the note is empty.
Multi-select questions toggle choices. The last question has an explicit
**Submit answers** row. **Esc** closes an open note first and otherwise cancels
the form; **Ctrl+C** cancels the whole turn.

Answers return to the same turn, and completed question/answer records remain
readable when the session is resumed. Default, Auto-Accept, and Plan modes all
support the form; Auto-Accept does not choose answers for you.

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
- When you end the session, TheGitAI stops its background jobs for you.

Full documentation: <https://thegit.ai/docs>

## License

Proprietary — see the LICENSE file included in this package. Source is
visible for inspection; copying and redistribution are not permitted.
