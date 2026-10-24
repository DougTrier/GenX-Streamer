# UI components

The screens and the shell, in plain DOM with no framework: the layout, remote
and keyboard navigation for TVs, phones and PCs, the in-app selects, Settings,
pop-ups and the stylesheets. `src/main.ts` is the composition root that
creates every area in start-up order.

## Where the code is

| Where | What |
| --- | --- |
| `src/main.ts` | Creates the shared application context (`app`) and every area, in start-up order. |
| `src/application/shell/` | Start-up, closing, the foreground and background, pages, Settings, the panel divider, `shared-context.ts` |
| `src/ui/shell/` | `shell.ts` (the static layout), `viewport.ts`, `remote-navigation.ts` (the D-pad and keyboard focus engine), `in-app-select.ts`, the start-up status, the VPN indicator |
| `src/ui/settings/` | Settings navigation, About, data transfer, the event history, storage recovery, exit |
| `src/ui/<area>/` | Each area's screens: `scan/`, `guide/`, `genxtra/`, `accounts/`, `player/`, `channels/` |
| `src/ui/*.css` | The stylesheets, imported by `main.ts` in cascade order. `style.css` and `responsive.css` are indexes of their parts; `dialog-polish.css` is the shared pop-up look. |

## Start here

- `src/ui/shell/shell.ts`: the layout every screen fits into.
- `src/ui/shell/remote-navigation.ts`: how focus moves with a remote.
- [navigation-invariants.md](../navigation-invariants.md): the rules for
  remote, keyboard and touch.

## Rules it keeps

UX01–UX06 and REMOTE01 in the [Engineering Spec](../../Engineering%20Spec.MD);
NV01–NV14 in [navigation-invariants.md](../navigation-invariants.md). Text
from outside the app is always rendered as text. Layouts must work at 200%
text size, on phones held upright, and on TVs with a remote only.

## Tests

```powershell
npx vitest run tests/navigation tests/unit tests/application
npx playwright test tests/ui
```
