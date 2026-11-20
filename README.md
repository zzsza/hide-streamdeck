# Hide Status Stream Deck Plugin

Elgato Stream Deck plugin (`com.zzsza.hide-status`) for monitoring Hide agents and missions. The Stream Deck + dashboard uses the following key order. Each UUID starts with `com.zzsza.hide-status.`.

| Row | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| Top | 작업 중 (`working-count`) | 내 차례 (`needs-you-count`) | 읽을 것 (`to-read`) | 미션 (`mission`) |
| Bottom | 머지 대기 (`merge`) | 확인 대기 (`confirmation`) | 경고 (`warning`) | CI 실패 (`ci`) |

The existing `needs-you-agent` action remains available for individual slots.

## Directory Layout

- `com.zzsza.hide-status.sdPlugin/`: Stream Deck plugin bundle directory
  - `manifest.json`: SDK v3 manifest (Node.js 24, Stream Deck 7.1+) declaring nine actions
  - `ui/count.html`: Shared Property Inspector for count actions
  - `ui/needs-you-agent.html`: Property Inspector for the single-agent slot action
  - `ui/pi-shared.js`, `ui/pi-shared.css`: Property Inspector WebSocket settings sync helper
  - `imgs/`: Plugin, category, and action icons
  - `bin/`: Rollup output (`plugin.js`, gitignored)
- `src/`
  - `plugin.ts`: Plugin entry point wiring global settings, shared `StatusHub`, and the nine actions
  - `actions/`: `working-count.ts`, `needs-you-count.ts`, `needs-you-agent.ts`
  - `source/`: `types.ts`, `fake-source.ts`, `hide-access.ts`, `hide-cli-source.ts`, `index.ts` (`createHideSource`)
  - `state/`: `classify.ts` (`classify`, `summarize`), `status-hub.ts` (`StatusHub`)
  - `render/`: `key-svg.ts`, `count-key.ts`, `agent-key.ts`
- `scripts/preview.ts`: Renders the dashboard across all fake scenarios into `preview/index.html` (gitignored)
- `tests/`: Vitest unit tests for classification, fake fixtures, polling hub, rendering, and actions

## Scripts

- `npm run build`: Bundle `src/plugin.ts` into `com.zzsza.hide-status.sdPlugin/bin/plugin.js`
- `npm run typecheck`: Run TypeScript type checking (`tsc --noEmit`)
- `npm run test`: Run Vitest test suite once (`vitest run`)
- `npm run check`: Run `typecheck`, `test`, and `build`
- `npm run validate`: Validate `com.zzsza.hide-status.sdPlugin` with `streamdeck validate`
- `npm run pack`: Package `.streamDeckPlugin` archive into `dist/` (gitignored)
- `npm run preview`: Generate `preview/index.html` showing the eight dashboard keys per fake scenario

## Data Source Interface

Defined in `src/source/types.ts`:

```ts
export interface AgentRow {
  id: string;
  name: string;
  kind: string;
  state: string;
  line: string | null;
  pane: string;
  parent?: string;
  parent_pane?: string;
}

export interface HideSnapshot {
  connection: ConnectionState;
  agents: AgentRow[];
  missions?: MissionDashboard;
  readAt: number;
}

export interface HideSource {
  read(): Promise<HideSnapshot>;
  readMissions?(signal: AbortSignal): Promise<MissionDashboard>;
  dispose?(): void;
}
```

- `createHideSource(settings)` selects `HideCliSource` (`source: "hide"`, default) or `FakeHideSource` (`source: "fake"`).
- `StatusHub` polls the active `HideSource` with a 1500ms delay after each `read()` completes, runs only when at least one visible key is subscribed, immediately delivers the latest cached snapshot to new subscribers, converts `read()` exceptions into `{ kind: "error", message }` snapshots, and swaps sources when global settings change.
- `classify(state)` maps agent state strings to `needs_you` (`turn`, `look`), `working` (`going`, `waiting`), `to_read` (`done`, `unread`), or `other` (`quiet`, `unknown`, `asleep`, and unknown values).
- `summarize(snapshot)` deduplicates agents by `id` and preserves input order for `needsYou`. Child agents send their turns to their parent. Only root agents count toward the operator’s Needs You keys.
- Visible mission keys share a separate 10-second refresh while Hide is connected. A single active mission shows completed nodes over total nodes. Multiple missions show their count. Warnings count each affected node once. CI failures follow the current PR’s CI criterion.

## Connection States

`ConnectionState` covers every Hide CLI and access lifecycle state:

- `connected`: Access is granted and `hide ps --json` succeeded
- `not_connected`: Access has not been requested yet
- `pending`: Access request is waiting for operator approval in Hide
- `refused`: Operator refused the access request
- `revoked`: Previously granted access was revoked
- `expired`: Pending access request was dropped (for example, Hide restarted or pending queue evicted it)
- `hide_unavailable`: Hide application is not currently running
- `hide_outdated`: Installed `hide` binary lacks the `access` command (update Hide to a version supporting `hide access`)
- `hide_missing`: Configured `hidePath` binary was not found
- `error`: Unexpected failure with a diagnostic `message`

## Connecting to Hide

When the data source is set to `Hide CLI (live)` (default), the plugin runs `hide access status --json` with `HIDE_ACCESS=streamdeck`. It never creates a new approval request automatically: when not yet connected (`not_connected`), disconnected (`revoked`), refused (`refused`), expired (`expired`), or unreadable (`error`), open the Stream Deck Property Inspector and click **Hide에 연결 요청** once to send `hide access request --name streamdeck --json` (and clear any stale key file). Then open Hide and approve the `streamdeck` request under **Settings › External tools** with **View only** access. While approval is pending, the plugin polls `hide access request --name streamdeck --json` at least every 3 seconds; once approved, that call exchanges the pending request for a private key and the plugin begins polling `hide ps --json` every 1.5 seconds. If `hide_outdated` is shown, update Hide to a version that includes `hide access`. You can switch between `Hide CLI (live)` and `Fake scenario`, or change `Hide Path`, at any time in the Stream Deck Property Inspector's global settings.
