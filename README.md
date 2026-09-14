# pi-codex-usage

![pi-codex-usage screenshot](https://raw.githubusercontent.com/calesennett/pi-codex-usage/main/assets/pi-codex-usage-screen.png)

Footer status extension for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that shows the weekly Codex usage window.

## Install

```bash
pi install npm:@calesennett/pi-codex-usage
```

## Footer

The footer status is intentionally minimal and shows the weekly window as percent left:

```text
codex 82% left
```

When using the Codex Spark model, the label becomes:

```text
codex spark 82% left
```

The full status text is dimmed to match Pi's normal footer styling.
