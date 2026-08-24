# TheGitAI — AI coding agent for your terminal

TheGitAI is an agentic AI coding tool for your terminal. It reads and searches
your repository, writes and edits files, runs commands, and builds features with
you.

Talk to your repo in plain English. TheGitAI can keep long-running processes
under your approval while you work.

## Install

```bash
npm i -g @thegitai/cli
```

Requires Node.js 24 or newer.

## Start

```text
ai                  sign in if needed, then start a session in the current repo
ai "fix the tests"  start with a request
ai login            the same as `ai`; kept for muscle memory
ai --help           show commands, modes, keys, and options
```

Documentation: https://thegit.ai/docs

## Source Visibility

This repository is source-visible so customers can inspect the local client that
runs on their machine. It contains the TypeScript CLI client and Rust terminal
UI source used for local UX, local auth/session files, prompt history, local
file and shell tools, path containment, redaction, patch application, undo, and
local diagnostics.

TheGitAI remains a proprietary client/server product. Server-owned behavior is
not included here: provider access, model routing, prompts, orchestration,
semantic retrieval, reranking, auth enforcement, entitlements, quota enforcement,
and telemetry policy.

This source is published for inspection and trust verification only. It is not
open source. Copying, redistribution, commercial use, sublicensing, derivative
distribution, or use as a standalone cloned product or hosted service is not
permitted.

## License

Proprietary. See [LICENSE](LICENSE).
