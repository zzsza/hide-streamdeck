import { describe, expect, it } from "vitest";

import { connectionLabel } from "../src/render/index.js";
import type { ConnectionState } from "../src/source/types.js";

describe("connectionLabel", () => {
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
});
