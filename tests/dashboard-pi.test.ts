import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";
import { mapRefusalCodeToConnectionState } from "../src/source/hide-access.js";
import { renderCountKey } from "../src/render/count-key.js";

it("routes a PI request to its action and displays the acknowledgement, approval and refusal code", async () => {
  let click: (() => void) | undefined;
  const status = { textContent: "" };
  const button = { disabled: false, addEventListener: (_type: string, fn: () => void) => { click = fn; } };
  const sent: Record<string, unknown>[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() { socket = this; }
    send(message: string) { sent.push(JSON.parse(message)); }
  }
  let socket!: Socket;
  const window: { connectElgatoStreamDeckSocket?: (...args: unknown[]) => void } = {};
  vm.runInNewContext(await readFile("com.zzsza.hide-status.sdPlugin/ui/pi-shared.js", "utf8"), {
    window, WebSocket: Socket,
    document: { readyState: "interactive", querySelectorAll: (selector: string) =>
      selector === "[data-request-access]" ? [button] : selector === "[data-connection-status]" ? [status] : [] },
  });
  window.connectElgatoStreamDeckSocket!(12345, "sample-inspector", "registerPropertyInspector", "{}",
    JSON.stringify({ action: "sample-action", context: "sample-key" }));
  socket.onopen!();
  click!();
  expect(sent.at(-1)).toMatchObject({ event: "sendToPlugin", context: "sample-key", payload: { event: "requestAccess" } });
  expect(status.textContent).toBe("요청 보냄");
  const receive = (payload: object) => socket.onmessage!({
    data: JSON.stringify({ event: "sendToPropertyInspector", payload: { event: "connection", ...payload } }),
  });
  receive({ kind: "pending" });
  expect(status.textContent).toBe("승인 대기");
  receive({ kind: "connected" });
  expect(status.textContent).toBe("연결됨");
  for (const [code, expected] of [
    ["access_from_pane", "Hide pane 안에서 실행됨: Stream Deck 앱을 Hide 밖에서 다시 실행"],
    ["synthetic_refusal", "synthetic_refusal"],
  ] as const) {
    const state = mapRefusalCodeToConnectionState(code, "synthetic private detail");
    if (state.kind !== "error") throw new Error("Expected a refusal");
    receive({ kind: state.kind, refusalCode: state.refusalCode });
    expect(status.textContent).toBe(expected);
    expect(button.disabled).toBe(false);
    const svg = renderCountKey("warning", { connection: state, readAt: 0, agents: [] });
    expect(svg).toContain(">오류</text>");
    expect(svg).not.toContain(code);
    expect(svg).not.toContain("private");
  }
});
