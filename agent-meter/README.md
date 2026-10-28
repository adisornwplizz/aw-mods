# agent-meter

A Claude Code mod that draws a band above the prompt with what your session costs to keep talking to, and the subagents working right now.

```
context after each prompt · last 24 → now    ctx  ●●○○○○○○○○○○ 11% of 1.0M
○○○○○○○○○○○○○○○○○○○●●●●○○ ≥500k              ↻    108k/msg · Δ +5k Bash sed
○○○○○○○○○○○○○○○●●●●●●●●●●                    ⏱    1m53s · 1 prompt · $0.60
5h 25% ↺1h38m · 7d 23% ↺6d08h · cache 99%     ⚙    0 run · 0 done
├─ ⠹ Explore [haiku-5-5] find auth code │ 31k ctx · 2k out · 42s
```

Each line on the right stays one line: one too long for the space is cut with `…`, so the band is always four lines tall beside the chart.

Dots are drawn in brand orange `#CE6535` when on and light gray `#E8EAED` when off. ● and ○ above stand for those two colors. On screen every dot is solid.

## Reading the band

| Segment | Meaning |
| --- | --- |
| Dot grid, left | One column per prompt over the last 24, oldest left. The bottom dot is on once the prompt has a reading. The top dot, in deeper orange `#9E4422`, is on when that prompt's context passed the warn line. On Desktop it is an SVG with a dashed line at the warn threshold. The chart starts with the context at load |
| `5h 42% ↺1h12m · 7d 18%` | Subscription rate-limit windows used, and when each resets. Yellow from 80%, red from 95%. Absent on API-key billing |
| `cache 98%` | Share of the latest main-thread request served from the prompt cache. Yellow below 80%, which usually means the cache lapsed and that message paid full price |
| `ctx ●●○○○○ 11% of 1.0M` | How full the context window is |
| `↻ 312k/msg` | Tokens every next message re-reads. Orange, yellow at 500k, red at 800k |
| `Δ +38k Read invoice.ts` | How much the last turn grew the context, and the largest tool result in it: a file's name for Read, the program for Bash. Orange from +20k |
| `⏱ 2d03h · 84 prompts` | Session age, and how many prompts you have sent |
| `$4.10` | Session cost, as `/cost` totals it |
| `⚙ 2 run · 1 done` | Subagents running and finished |
| `├─ ⠹ Explore [haiku-5-5] …` | One row per running subagent: type, model, task, context, output tokens, run time |

Crossing 500k and 800k each raises one toast suggesting `/compact` or a fresh session. A compaction that drops below the line re-arms it.

Type `/agent-meter` to hide or show the band.

## Settings

Change the thresholds on the plugin's details in `/plugin` (**Configure options**):

- `warnTokens`, default `500000`
- `alertTokens`, default `800000`

## Requirements

- Claude Code v2.1.287 or later in the terminal, v2.1.286 or later in the Desktop app. Tested with **2.1.311** (terminal) and **2.1.308** (Desktop).
- The band draws in the terminal and in Claude Code Desktop's Code tab.
- Only one mod can draw above the prompt. Another mod that draws there without passing it on, such as `token-weather` or `replay-theater`, hides this band.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install agent-meter --marketplace adisornwplizz/aw-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install agent-meter --marketplace adisornwplizz/aw-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `adisornwplizz/aw-mods`, then Add plugin.

After you change the code of a local copy, run `/reload-plugins` in a session to pick it up.

## Develop

```bash
claude plugin validate ./agent-meter
claude plugin test ./agent-meter
tsc -p ./agent-meter
```

`tsc` needs the declarations Claude Code writes into `.claude-plugin/types/` when it loads the mod in an interactive session. The folder is generated, so it is not committed.

## How it works

- `session.start` reads the starting usage, registers `/agent-meter`, and polls `$.agent.list()` once a second for the subagent roster.
- `tool.call` remembers the largest main-thread tool result of the turn.
- `session.measure` runs after each main-thread turn. It records the context size, its growth, the sparkline point, and raises the threshold toasts.
- `agent.spawn` adds a row for a new subagent with the model it was started on.
- `turn.step` adds each subagent model call's tokens to its row and records the model that answered.
- `ui.render` on `AbovePrompt` draws the band.

Every value lives in `$.state`, declared in `types/index.d.ts`, so it survives a reload of the mod.
