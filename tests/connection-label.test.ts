import { describe, expect, it } from "vitest";

import { connectionHint, connectionLabel } from "../src/render/index.js";
import type { ConnectionState } from "../src/source/types.js";

describe("connectionLabel and connectionHint", () => {
  it("returns null for connected and exact short Korean labels for all 9 non-connected states", () => {
    const cases: ReadonlyArray<[ConnectionState, string | null]> = [
      [{ kind: "connected" }, null],
      [{ kind: "not_connected" }, "연결 안 됨"],
      [{ kind: "pending" }, "승인 대기"],
      [{ kind: "refused" }, "거절됨"],
      [{ kind: "revoked" }, "연결 끊김"],
      [{ kind: "expired" }, "요청 만료"],
      [{ kind: "hide_unavailable" }, "Hide 꺼짐"],
      [{ kind: "hide_outdated" }, "Hide 업데이트 필요"],
      [{ kind: "hide_missing" }, "hide 없음"],
      [{ kind: "error", message: "synthetic failure" }, "오류"],
    ];

    expect(cases).toHaveLength(10);
    for (const [state, expected] of cases) {
      expect(connectionLabel(state)).toBe(expected);
    }
  });

  it("returns retry hint only for refused and revoked states", () => {
    const cases: ReadonlyArray<[ConnectionState, string | null]> = [
      [{ kind: "connected" }, null],
      [{ kind: "not_connected" }, null],
      [{ kind: "pending" }, null],
      [{ kind: "refused" }, "눌러서 다시 요청"],
      [{ kind: "revoked" }, "눌러서 다시 요청"],
      [{ kind: "expired" }, null],
      [{ kind: "hide_unavailable" }, null],
      [{ kind: "hide_outdated" }, null],
      [{ kind: "hide_missing" }, null],
      [{ kind: "error", message: "synthetic failure" }, null],
    ];

    expect(cases).toHaveLength(10);
    for (const [state, expected] of cases) {
      expect(connectionHint(state)).toBe(expected);
    }
  });
});
