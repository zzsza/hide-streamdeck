# Hide Status for Stream Deck

See which Hide sessions are working, which need your input, and how far your missions have progressed. On Stream Deck +, use the touch strip to display weekly quota remaining for Claude Code, Codex (shown as GPT), and Antigravity.

## Requirements

- An Apple Silicon Mac running macOS 14 or later with Hide installed. [Hide installation guide](https://withhide.dev/docs/start/install-macos/)
- Stream Deck software 7.1 or later. The layout below uses a Stream Deck +. The weekly quota actions also work on regular keys. [Elgato touch strip guide](https://help.elgato.com/hc/en-us/articles/10567698991629-Elgato-Stream-Deck-Touch-Strip)
- Node.js 24 or later and npm to build the installer from source.

The layout, Hide navigation, and weekly quota display were checked with Hide 1.2.12 and Stream Deck 7.6.1 on macOS.

## Install the plugin

From the repository root, run:

```sh
npm ci
npm run build
npm run pack
```

Double-click `dist/com.zzsza.hide-status.streamDeckPlugin` to install it. In the Stream Deck app, find **Hide Status** in the actions list and drag **Working Count** onto a key. [Elgato installer documentation](https://docs.elgato.com/streamdeck/sdk/introduction/distribution/)

## Connecting to Hide

1. Open Hide on the same Mac.
2. Select the **Working Count** key in the Stream Deck app. In the key settings below it, leave **Source** on **Hide CLI (live)**. Set **Hide Path** only if the binary is somewhere other than `/Applications/hide.app/Contents/Resources/hide`.
3. Click **Hide에 연결 요청** (Request connection to Hide) once.
4. In Hide 1.2.12, go to **Settings › Bots** and approve the `streamdeck` request. **Full** lets the bot see your existing sessions and missions and grants it permission to act as you in Hide. **Own space** limits it to work the bot owns, so your existing sessions and missions will be outside its view.
5. Check **Hide 연결** (Hide connection) in the key settings. It shows **연결됨** when the dashboard can read Hide. One approval covers the dashboard keys.

Hide 1.2.9 through 1.2.11 use **Settings › External tools** with **View only** access. If an older **View only** connection needs reapproval after an update, click **Hide에 연결 요청** again and approve the request under **Bots**.

For button navigation and weekly quota, also allow **Stream Deck** in macOS **System Settings › Privacy & Security › Accessibility**. This permission lets the plugin read the quota indicators in the Hide window and activate Hide controls when you press a key. [Apple Accessibility settings](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac)

## Set up a Stream Deck + page

Use any page in your profile. The table uses action names as they appear in the Stream Deck app.

| Position | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| Top keys | **Working Count** | **Needs You Count** | Empty | **미션** |
| Bottom keys | **작업 중 세션**, Slot 1 | **작업 중 세션**, Slot 2 | **작업 중 세션**, Slot 3 | **작업 중 세션**, Slot 4 |
| Touch strip via dials | **Claude 주간 잔여** | **GPT 주간 잔여** | **Antigravity 주간 잔여** | Empty |

- **Working Count** shows how many sessions are running or waiting and opens Hide Overview when pressed.
- **Needs You Count** shows how many sessions need your attention. Press it to open the first session under **Waiting on you**, or Overview when that list is empty.
- **미션** (Missions) opens the mission list. It shows completed steps over total steps for one active mission, or the number of active missions when there are several.
- **작업 중 세션** (Working session) displays one session name and its state. Add the same action four times, then set **Slot** to 1, 2, 3, and 4 in the four keys' settings. Running sessions appear first, followed by waiting sessions. Unoccupied slots are blank. Press an occupied key to open Overview.

For the touch strip, select **Dials** in the Stream Deck actions list and drag the three weekly quota actions onto the first three dials. Each dial controls the segment above it. On models with regular keys, select **Keys** and place the quota actions directly on available keys. [Elgato dial setup](https://help.elgato.com/hc/en-us/articles/10715833118989-Elgato-Stream-Deck-Dials-Introduction)

### Set up weekly quota

1. In Hide, pin the **7 days** usage indicator for each provider you want to display.
2. Leave the Hide window open so the plugin can read those indicators.

The Stream Deck actions check usage every 30 seconds while displayed. A provider with 80% used in Hide shows **20% remaining** on Stream Deck. A dash means the plugin could not read that provider's weekly value.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| The key shows a connection status | Open Hide. Check **Hide Path** and **Source** in the key settings. For a pending request, approve `streamdeck` in Hide. If permission was revoked or expired, request it again. |
| Connected, but your sessions and missions are missing | Check the bot's access mode in **Settings › Bots**. **Own space** shows only the bot's own work. |
| Two keys show the same session | Give each **작업 중 세션** key a different **Slot**. New keys start at Slot 1. |
| A session key is blank | Check whether enough sessions are running or waiting to fill that slot. |
| A quota shows a dash | Open the Hide window, pin the provider's **7 days** indicator, and check macOS Accessibility permission for Stream Deck. Allow up to 30 seconds for the refresh. |
| The touch strip is blank | Check that the device is on the page containing the actions and that the actions are assigned to dials on that page. |
| A navigation key shows an exclamation mark | Check macOS Accessibility permission for Stream Deck and confirm Hide has an open window. |

For additional indicators, the **Hide Status** actions list also includes **읽을 것** (Unread results), **답변 필요** (Reply needed), **Needs You Agent**, **머지 대기** (Merge pending), **확인 대기** (Confirmation pending), **경고** (Warning), and **CI 실패** (CI failed).

## Development

| Command | Result |
| --- | --- |
| `npm run check` | Type checking, Vitest tests, and a Rollup build |
| `npm run validate` | Validate the Stream Deck plugin manifest and resources |
| `npm run pack` | Package the current build into `dist/` |
| `npm run preview` | Generate `preview/index.html` with simulated dashboard keys |

To try sample data in the Stream Deck app, set **Source** to **Fake scenario** in any key's settings and pick a scenario. This setting applies to all Hide Status keys.

- [Plugin bundle](com.zzsza.hide-status.sdPlugin) contains the manifest, key artwork, key settings UI, and touch strip layout.
- [Source types](src/source/types.ts) define the data source and snapshot contracts. The live source uses `HIDE_ACCESS=streamdeck` for `hide access status --json` and `hide ps --json`. Access requests start when the user clicks the request button.
- [Status hub](src/state/status-hub.ts) shares one session poll across the visible status keys with a 1.5-second delay between reads. Visible mission keys share a separate 10-second refresh while connected.
- [State classification](src/state/classify.ts) maps Hide states to working, needs-you, and unread indicators. Only root agents count toward the operator's Needs You keys.
