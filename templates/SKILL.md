---
name: rex-bot
description: Message the coordinator bot that watches this Rex session (finished, blocked, need a decision) with `rex-bot say`, and find this pane's Rex ids with `rex-bot whoami`. Use when you are running inside Rex and need to tell the coordinator something in words.
metadata:
  installed-by: rex-bot-bridge
---

# rex-bot: talk to the coordinator

A coordinator bot (for example Grok Bot) may be watching this Rex session through rex-bot-bridge.
It already gets status changes (done / blocked / error) automatically. Use `rex-bot say` only when
the message needs words: a result, a question, a decision you need, a link to a PR.

```sh
rex-bot say "PR #12 is ready for review: https://github.com/org/repo/pull/12"
rex-bot whoami   # prints REX_SESSION and REX_BLOCK for this pane
```

Rules:

- One short, specific line. Say what happened and what you need, if anything.
- Never include secrets, tokens, passwords, or private keys in the message.
- `say` always exits 0. If it prints a warning, the bridge is not configured; carry on with your task.
- The coordinator can reply by typing into this pane.

This skill was installed by `rex-bot setup`; `rex-bot uninstall` removes it.
