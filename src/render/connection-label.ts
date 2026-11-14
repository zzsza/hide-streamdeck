import type { ConnectionState } from "../source/types.js";

export function connectionLabel(state: ConnectionState): string | null {
  switch (state.kind) {
    case "connected":
      return null;
    case "not_connected":
      return "연결 안 됨";
    case "pending":
      return "승인 대기";
    case "refused":
      return "거절됨";
    case "revoked":
      return "연결 끊김";
    case "expired":
      return "요청 만료";
    case "hide_unavailable":
      return "Hide 꺼짐";
    case "hide_outdated":
      return "Hide 업데이트 필요";
    case "hide_missing":
      return "hide 없음";
    case "error":
      return "오류";
  }
}

export function connectionHint(state: ConnectionState): string | null {
  switch (state.kind) {
    case "revoked":
    case "refused":
      return "눌러서 다시 요청";
    default:
      return null;
  }
}
