# TheGitAI — AI coding agent for your terminal

TheGitAI is an agentic AI coding tool for your terminal. It reads and searches
your repository, writes and edits files, runs commands, and builds features with
you.

Talk to your repo in plain English. TheGitAI can keep long-running processes
under your approval while you work.

![TheGitAI finding and fixing a failing test in a real repository](https://thegit.ai/demo.gif)

*A real session: a failing test, traced to its cause, fixed, and verified.*

## Install

```bash
npm i -g @thegitai/cli
```

Supports Node.js 22 and newer. Node.js 24 is recommended.

## Start

```text
ai                  sign in if needed, then start a session in the current repo
ai "fix the tests"  start with a request
ai login            the same as `ai`; kept for muscle memory
ai --help           show commands, modes, keys, and options
```

Documentation: https://thegit.ai/docs

## Source Visibility

This source is published for inspection and trust verification only. It is not
open source. Copying, redistribution, commercial use, sublicensing, derivative
distribution, or use as a standalone cloned product or hosted service is not
permitted.

## License

Proprietary. See [LICENSE](LICENSE).
