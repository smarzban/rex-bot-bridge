---
name: rex-grokbot
description: Message the coordinator bot that watches this Rex session (finished, blocked, need a decision) with `rex-grokbot say`, and find this pane's Rex ids with `rex-grokbot whoami`. Use when you are running inside Rex and need to tell the coordinator something in words.
metadata:
  installed-by: rex-grokbot-bridge
---

# rex-grokbot: talk to the coordinator

A coordinator bot (for example Grok Bot) may be watching this Rex session through rex-grokbot-bridge.
It already gets status changes (done / blocked / error) automatically. Use `rex-grokbot say` only when
the message needs words: a result, a question, a decision you need, a link to a PR.

```sh
rex-grokbot say "PR #12 is ready for review: https://github.com/org/repo/pull/12"
rex-grokbot whoami   # prints REX_SESSION and REX_BLOCK for this pane
```

Rules:

- One short, specific line. Say what happened and what you need, if anything.
- Never include secrets, tokens, passwords, or private keys in the message.
- `say` always exits 0. If it prints a warning, the bridge is not configured; carry on with your task.
- The coordinator can reply by typing into this pane.

This skill was installed by `rex-grokbot setup`; `rex-grokbot uninstall` removes it.
