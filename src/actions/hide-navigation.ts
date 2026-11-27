export type HideDestination = "overview" | "needs_you" | "to-read" | "mission";

const HIDE_ACCESSIBILITY_SCRIPT = String.raw`
ObjC.import("AppKit");
ObjC.import("ApplicationServices");

const labels = {
  view: ["View", "보기", "视图", "表示"],
  webArea: ["hide", "Hide"],
  overview: ["Overview", "개요", "概览", "概要"],
  overviewTabs: ["Overview view", "개요 보기", "概览视图", "概要の表示"],
  mission: ["Open missions", "미션 열기", "打开任务", "ミッションを開く"],
  work: ["Work", "작업", "工作", "作業"],
  sessions: ["Sessions", "세션 목록", "会话列表", "セッション"],
  preview: ["Session preview", "세션 미리보기", "会话预览", "セッションプレビュー"],
  waiting: ["Waiting on you", "나를 기다리는 것", "等待你的事项", "あなたを待っているもの"],
  answer: ["Go answer", "답하러 가기", "去回答", "回答しに行く"],
  filters: ["Session filter", "세션 필터", "会话筛选", "セッション絞り込み"],
  needs_you: ["My turn", "내 차례", "轮到我", "自分の番"],
  "to-read": ["Unread results", "안 읽은 결과", "未读结果", "未読の結果"],
};
const toggleRoles = ["AXButton", "AXCheckBox", "AXToggleButton"];
const groupRoles = ["AXGroup", "AXLandmarkRegion"];
const searchAttributes = $(["AXRole", "AXTitle", "AXDescription", "AXChildren"]);

function attribute(node, name) {
  const value = Ref();
  // The out parameter is a CFTypeRef, so JXA must bridge it before using it as an object.
  return node && $.AXUIElementCopyAttributeValue(node, $(name), value) === 0
    ? ObjC.castRefToObject(value[0]) : null;
}

function text(node, name) {
  return ObjC.unwrap(attribute(node, name)) || "";
}

function* accessibilityNodes(root, maxDepth) {
  const queue = root ? [[root, 0]] : [];
  for (let index = 0; index < queue.length; index++) {
    const [node, depth] = queue[index];
    const value = Ref();
    if ($.AXUIElementCopyMultipleAttributeValues(node, searchAttributes, 0, value) !== 0) continue;
    const fields = ObjC.castRefToObject(value[0]);
    yield { node, fields };
    if (depth >= maxDepth) continue;
    const children = fields.objectAtIndex(3);
    for (let child = 0; children && child < children.count; child++) queue.push([children.objectAtIndex(child), depth + 1]);
  }
}

function find(root, roles, names, numbered = false, maxDepth = Infinity, accept = () => true) {
  for (const { node, fields } of accessibilityNodes(root, maxDepth)) {
    if (roles.includes(ObjC.unwrap(fields.objectAtIndex(0)))) {
      for (const field of [1, 2]) {
        const title = ObjC.unwrap(fields.objectAtIndex(field));
        if (typeof title === "string" && names.includes(numbered ? title.replace(/\s*\d+$/, "") : title) && accept(node)) return node;
      }
    }
  }
  return null;
}

function waitFor(findElement, retries = 20) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const element = findElement();
    if (element) return element;
    $.NSThread.sleepForTimeInterval(0.05);
  }
  return null;
}

function press(node, name) {
  const result = node ? $.AXUIElementPerformAction(node, $("AXPress")) : "missing";
  if (result !== 0) throw new Error("HIDE_NAVIGATION: " + name + ": " + result);
}

function selected(node) {
  if (!node) return false;
  const state = ObjC.unwrap(attribute(node, "AXValue") ?? attribute(node, "AXSelected"));
  return state === true || state === 1 || state === "1";
}

function activate(app, node, name) {
  if (!node) throw new Error("HIDE_NAVIGATION: " + name + ": missing");
  const focused = $.AXUIElementSetAttributeValue(node, $("AXFocused"), $(true));
  if (focused !== 0) throw new Error("HIDE_NAVIGATION: " + name + ": " + focused);
  if (!waitFor(() => text(node, "AXFocused"))) throw new Error("HIDE_NAVIGATION: " + name + ": missing");
  // Chromium's AXPress can succeed without delivering a click to these controls.
  sendKey(app, 49, name);
}

function sendKey(app, keyCode, name) {
  const pid = Ref();
  const result = $.AXUIElementGetPid(app, pid);
  if (result !== 0) throw new Error("HIDE_NAVIGATION: " + name + ": " + result);
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, keyCode, down);
    $.CGEventSetFlags(event, 0);
    $.CGEventPostToPid(pid[0], event);
  }
}

function choose(app, control, name) {
  const node = waitFor(control);
  if (!selected(node)) activate(app, node, name);
  if (!waitFor(() => selected(control()), 50)) throw new Error("HIDE_NAVIGATION: " + name + ": missing");
}

function menu(app, name) {
  const view = find(attribute(app, "AXMenuBar"), ["AXMenuBarItem"], labels.view);
  press(find(view, ["AXMenuItem"], labels[name]), name);
}

function hidePage(window) {
  return find(window, ["AXWebArea"], labels.webArea, false, 12, (node) => {
    const url = attribute(node, "AXURL");
    return url && ["127.0.0.1", "localhost", "::1"].includes(ObjC.unwrap(url.host));
  });
}

function hideApplication() {
  if (!$.AXIsProcessTrusted()) throw new Error("HIDE_NAVIGATION: accessibility denied");
  const applications = () => $.NSRunningApplication.runningApplicationsWithBundleIdentifier($("me.grab.hide.desktop"));
  const running = waitFor(() => {
    const matches = applications();
    return Number(matches.count) > 0 ? matches.objectAtIndex(0) : null;
  });
  if (!running) throw new Error("HIDE_NAVIGATION: Hide not running");
  return $.AXUIElementCreateApplication(running.processIdentifier);
}
`;

export const HIDE_NAVIGATION_SCRIPT = HIDE_ACCESSIBILITY_SCRIPT + String.raw`
function run(argv) {
  const app = hideApplication();
  const window = () => attribute(app, "AXFocusedWindow") || attribute(app, "AXMainWindow");
  if (!waitFor(window)) throw new Error("HIDE_NAVIGATION: window missing");

  const destination = argv[0];
  if (destination === "mission") return menu(app, "mission");

  // Search below Hide's renderer, separately from any browser view open beside it.
  const page = () => hidePage(window());
  if (!waitFor(page)) throw new Error("HIDE_NAVIGATION: webArea: missing");

  const overviewTabs = () => find(page(), ["AXTabGroup"], labels.overviewTabs, false, 12);
  let tabs = overviewTabs();
  if (!tabs) {
    menu(app, "overview");
    tabs = waitFor(overviewTabs);
  }
  if (!tabs) throw new Error("HIDE_NAVIGATION: overview: missing");
  if (destination === "overview") return;

  const work = find(tabs, ["AXRadioButton", "AXTab", "AXButton"], labels.work, true, 3);
  if (work && !selected(work)) activate(app, work, "work");

  if (destination === "needs_you") {
    const preview = find(page(), [...groupRoles, "AXLandmarkComplementary"], labels.preview, false, 16);
    if (preview) sendKey(app, 53, destination);
    const answer = waitFor(() => {
      const waiting = find(page(), groupRoles, labels.waiting, false, 18);
      return find(waiting, ["AXButton"], labels.answer, false, 8);
    });
    if (!answer) return;
    activate(app, answer, destination);
    if (!waitFor(() => !overviewTabs(), 50)) throw new Error("HIDE_NAVIGATION: needs_you: missing");
    return;
  }

  choose(app, () => find(page(), ["AXRadioButton"], labels.sessions, false, 16), "sessions");

  const currentFilter = () => {
    const filters = find(page(), groupRoles, labels.filters, false, 16);
    return find(filters, toggleRoles, labels[destination], true, 3);
  };
  choose(app, currentFilter, destination);
}
`;

export const HIDE_WEEKLY_USAGE_SCRIPT = HIDE_ACCESSIBILITY_SCRIPT + String.raw`
function weeklyReading(label) {
  const match = typeof label === "string" && /^(Claude Code|Codex|Antigravity),\s*(?:7 days|7일|7天|7日間),\s*(\d{1,3})%$/.exec(label);
  if (!match) return null;
  const providers = { "Claude Code": "claude", Codex: "codex", Antigravity: "antigravity" };
  return [providers[match[1]], Math.max(0, 100 - Number(match[2]))];
}

function run() {
  const app = hideApplication();
  const page = hidePage(attribute(app, "AXMainWindow")) || hidePage(attribute(app, "AXFocusedWindow"));
  const results = {};
  for (const { fields } of accessibilityNodes(page, 16)) {
    const role = ObjC.unwrap(fields.objectAtIndex(0));
    if (role !== "AXPopUpButton" && role !== "AXButton") continue;
    for (const field of [1, 2]) {
      const reading = weeklyReading(ObjC.unwrap(fields.objectAtIndex(field)));
      if (reading) results[reading[0]] = reading[1];
    }
    if (Object.keys(results).length === 3) break;
  }
  return JSON.stringify(results);
}
`;
