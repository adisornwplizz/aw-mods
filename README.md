# aw-mods

Claude Code mods by aw.

| Mod | What it does |
| --- | --- |
| [agent-meter](./agent-meter) | A band above the prompt showing context and token usage, cost, and the subagents running now |
| [context-tree](./context-tree) | A file tree pane colored by what Claude read and wrote this session, with the context tokens each file added |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-meter --marketplace adisornwplizz/aw-mods
/plugin install context-tree --marketplace adisornwplizz/aw-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install agent-meter --marketplace adisornwplizz/aw-mods
claude plugin install context-tree --marketplace adisornwplizz/aw-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `adisornwplizz/aw-mods`, then Add plugin.
