# Hide Status Stream Deck Plugin

Elgato Stream Deck plugin (`com.zzsza.hide-status`) that displays Hide coding agent status across count keys and per-slot agent keys.

## Directory Layout

- `com.zzsza.hide-status.sdPlugin/`: Stream Deck plugin bundle directory
  - `manifest.json`: SDK v3 manifest (Node.js 24, Stream Deck 7.1+) declaring 3 actions:
    - `com.zzsza.hide-status.working-count` (Working Count)
    - `com.zzsza.hide-status.needs-you-count` (Needs You Count)
    - `com.zzsza.hide-status.needs-you-agent` (Needs You Agent)
  - `ui/count.html`: Shared Property Inspector for count actions
  - `ui/needs-you-agent.html`: Property Inspector for the single-agent slot action
  - `ui/pi-shared.js`, `ui/pi-shared.css`: Property Inspector WebSocket settings sync helper
  - `imgs/`: Plugin, category, and action icons
  - `bin/`: Rollup output (`plugin.js`, gitignored)
- `src/`
  - `plugin.ts`: Plugin entry point wiring global settings, shared `StatusHub`, and the 3 actions
  - `actions/`: `working-count.ts`, `needs-you-count.ts`, `needs-you-agent.ts`
  - `source/`: `types.ts`, `fake-source.ts`, `hide-access.ts`, `hide-cli-source.ts`, `index.ts` (`createHideSource`)
  - `state/`: `classify.ts` (`classify`, `summarize`), `status-hub.ts` (`StatusHub`)
  - `render/`: `key-svg.ts`, `count-key.ts`, `agent-key.ts`
- `scripts/preview.ts`: Renders every key across all fake scenarios into `preview/index.html` (gitignored)
- `tests/`: Vitest unit tests for classification, fake fixtures, polling hub, rendering, and actions

## Scripts

- `npm run build`: Bundle `src/plugin.ts` into `com.zzsza.hide-status.sdPlugin/bin/plugin.js`
- `npm run typecheck`: Run TypeScript type checking (`tsc --noEmit`)
- `npm run test`: Run Vitest test suite once (`vitest run`)
- `npm run check`: Run `typecheck`, `test`, and `build`
- `npm run validate`: Validate `com.zzsza.hide-status.sdPlugin` with `streamdeck validate`
- `npm run pack`: Package `.streamDeckPlugin` archive into `dist/` (gitignored)
- `npm run preview`: Generate `preview/index.html` showing all rendered keys per fake scenario

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
}

export interface HideSnapshot {
  connection: ConnectionState;
  agents: AgentRow[];
  readAt: number;
}

export interface HideSource {
  read(): Promise<HideSnapshot>;
  dispose?(): void;
}
```

- `createHideSource(settings)` selects `HideCliSource` (`source: "hide"`, default) or `FakeHideSource` (`source: "fake"`).
- `StatusHub` polls the active `HideSource` with a 1500ms delay after each `read()` completes, runs only when at least one visible key is subscribed, immediately delivers the latest cached snapshot to new subscribers, converts `read()` exceptions into `{ kind: "error", message }` snapshots, and swaps sources when global settings change.
- `classify(state)` maps agent state strings to `needs_you` (`turn`, `look`), `working` (`going`, `waiting`), `to_read` (`done`, `unread`), or `other` (`quiet`, `unknown`, `asleep`, and unknown values).
- `summarize(snapshot)` deduplicates agents by `id` and preserves input (`pane`) order for `needsYou`.

## Connection States

`ConnectionState` covers every Hide CLI and access lifecycle state:

- `connected`: Access is granted and `hide ps --json` succeeded
- `not_connected`: Access has not been requested yet
- `pending`: Access request is waiting for operator approval in Hide
- `refused`: Operator refused the access request
- `revoked`: Previously granted access was revoked
- `expired`: Pending access request was dropped (for example, Hide restarted or pending queue evicted it) and is automatically re-requested
- `hide_unavailable`: Hide application is not currently running
- `hide_outdated`: Installed `hide` binary lacks the `access` command (update Hide to a version supporting `hide access`)
- `hide_missing`: Configured `hidePath` binary was not found
- `error`: Unexpected failure with a diagnostic `message`

## Connecting to Hide

When the data source is set to `Hide CLI (live)` (default), the plugin runs `hide access status --json` on its first poll with `HIDE_ACCESS=streamdeck`. If no key exists yet (`access_not_connected`), or if a pending request expired (`access_request_expired`) or the key file is unreadable (`access_key_unreadable`), it runs `hide access request --name streamdeck --json` to open a request. Open Hide and approve the `streamdeck` request under **Settings › External tools** with **View only** access. While approval is pending, the plugin polls `hide access request --name streamdeck --json` at least every 3 seconds; once approved, that call exchanges the pending request for a private key and the plugin begins polling `hide ps --json` every 1.5 seconds. If the operator refuses (`refused`) or disconnects (`revoked`) the tool, the plugin keeps showing that state without re-requesting automatically; press any Hide Status key on the Stream Deck to retry `hide access request`. If `hide_outdated` is shown, update Hide to a version that includes `hide access`. You can switch between `Hide CLI (live)` and `Fake scenario`, or change `Hide Path`, at any time in the Stream Deck Property Inspector's global settings.
