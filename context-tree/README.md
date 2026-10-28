# context-tree

A Claude Code mod that adds a file tree pane colored by what Claude did this session.

- **Faint gray**: Claude has not touched the file.
- **Light orange**: Claude read it (Read, or a Bash reader such as `cat`, `sed`, `head`).
- **Brand orange** (`#CE6535`): Claude wrote it (Write, Edit, NotebookEdit).
- **Deep orange flash**: the file Claude is touching right now, for 2.7 seconds.

Colors stay for the whole session. A folder takes the strongest color of anything inside it, so a collapsed folder still shows that Claude worked there.

When Claude touches a file inside a closed folder, the folder opens by itself. Turn this off with the **Follow Claude** option under `/plugin` → context-tree → Configure options.

A folder shows `±n` when n changed files sit inside it, so you can find changes without opening every folder. Files and folders git ignores (build output like `out/`, `.DS_Store`) are drawn fainter still, unless Claude touched them.

The right column shows `~tokens` each file added to the main conversation's context (result size divided by 4, an estimate) and its git status letter (`M`, `A`, `D`, `U` for untracked). `×3` after a name means Claude read or wrote it three times. Reads made by subagents color the file but add no tokens, since they don't enter the main context.

In a git repo, a line under the header shows the branch, how far it is ahead (`↑`) or behind (`↓`) its upstream, and how many files are changed, for example `⎇ main · ↑1 · 2 changed`. It updates after Claude writes a file or runs a Bash command. When the folder is no repo but holds repos of its own (say `api/`, `backend/`, `web/`), each of those folder rows shows its branch, `↑`/`↓` and `±changed`, and the line under the header counts them. Outside any repo the line is hidden.

**most context** at the top lists the five files that added the most tokens, with a dot bar scaled to the largest.

Each row starts with a small button. On a folder (`▸`/`▾`) it opens or closes the folder. On a file (`@`) it puts `@path` into the prompt so you can point Claude at it.

The **tree** and **touched** buttons in the header switch views (`r` and `t` while the pane has focus). **touched** lists every touched file ranked by tokens. `/context-tree` shows or hides the pane.

Built with [claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) by Kurt Buhler as a reference; no code was copied. The pane follows the session's folder: Claude Desktop starts a session in an empty spare folder and moves it into the project you pick, and the tree switches within a second. Pairs with `agent-meter` and shares its palette. Tested on Claude Code 2.1.311.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-tree --marketplace adisornwplizz/aw-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install context-tree --marketplace adisornwplizz/aw-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `adisornwplizz/aw-mods`, then Add plugin.

In the terminal the pane needs `/tui fullscreen` and a window at least 110 columns wide. Claude Desktop docks it on its own.

## Develop

```bash
claude plugin validate ./context-tree
claude plugin test ./context-tree
```

After editing, `/reload-plugins` picks up the change.
