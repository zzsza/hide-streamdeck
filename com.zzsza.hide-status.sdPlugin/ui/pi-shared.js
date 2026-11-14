(function () {
  const DEFAULT_GLOBAL_SETTINGS = {
    source: "hide",
    hidePath: "/Applications/hide.app/Contents/Resources/hide",
    fakeScenario: "needs-you-many",
  };

  let websocket = null;
  let inspectorUuid = "";
  let hasLoadedGlobalSettings = false;
  let storedGlobalSettings = {};
  let pendingGlobalPatch = {};
  let actionSettings = {};
  const actionListeners = [];
  const globalListeners = [];
  const committedValues = new WeakMap();

  function send(payload) {
    if (websocket && websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify(payload));
    }
  }

  function effectiveGlobalSettings() {
    return Object.assign({}, DEFAULT_GLOBAL_SETTINGS, storedGlobalSettings, pendingGlobalPatch);
  }

  function mergePatch(base, patch) {
    const next = Object.assign({}, base);
    Object.keys(patch).forEach(function (key) {
      if (patch[key] === undefined) {
        delete next[key];
      } else {
        next[key] = patch[key];
      }
    });
    return next;
  }

  function readElementValue(el) {
    if (el.type === "checkbox") {
      return el.checked;
    }
    if (el.type === "number") {
      const trimmed = el.value.trim();
      if (trimmed === "") {
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return el.value;
  }

  function writeElementValue(el, value, fallback) {
    const resolved = value !== undefined && value !== null ? value : fallback;
    if (el.type === "checkbox") {
      el.checked = Boolean(resolved);
      committedValues.set(el, readElementValue(el));
      return;
    }
    el.value = resolved !== undefined && resolved !== null ? String(resolved) : "";
    committedValues.set(el, readElementValue(el));
  }

  function updateVisibility() {
    const current = effectiveGlobalSettings();
    const isFake = current.source === "fake";
    document.querySelectorAll("[data-visible-when-source]").forEach(function (node) {
      const expected = node.getAttribute("data-visible-when-source");
      const visible = (expected === "fake" && isFake) || (expected === "hide" && !isFake);
      node.classList.toggle("is-hidden", !visible);
    });
  }

  function applyGlobalSettingsToDom() {
    const current = effectiveGlobalSettings();
    document.querySelectorAll("[data-global-setting]").forEach(function (el) {
      const key = el.getAttribute("data-global-setting");
      if (!key) return;
      writeElementValue(el, current[key], DEFAULT_GLOBAL_SETTINGS[key]);
    });
    updateVisibility();
    globalListeners.forEach(function (fn) {
      fn(Object.assign({}, current));
    });
  }

  function applyActionSettingsToDom() {
    document.querySelectorAll("[data-action-setting]").forEach(function (el) {
      const key = el.getAttribute("data-action-setting");
      const fallback = el.getAttribute("data-default");
      if (!key) return;
      writeElementValue(el, actionSettings[key], fallback);
    });
    actionListeners.forEach(function (fn) {
      fn(Object.assign({}, actionSettings));
    });
  }

  function persistGlobalSettings(patch) {
    if (!hasLoadedGlobalSettings && websocket) {
      pendingGlobalPatch = mergePatch(pendingGlobalPatch, patch);
      updateVisibility();
      return;
    }
    storedGlobalSettings = mergePatch(storedGlobalSettings, patch);
    updateVisibility();
    send({
      event: "setGlobalSettings",
      context: inspectorUuid,
      payload: storedGlobalSettings,
    });
  }

  function persistActionSettings(patch) {
    actionSettings = mergePatch(actionSettings, patch);
    send({
      event: "setSettings",
      context: inspectorUuid,
      payload: actionSettings,
    });
  }

  function bindControlEvents(el, onCommit) {
    if (el.tagName === "SELECT" || el.type === "checkbox") {
      el.addEventListener("change", onCommit);
      return;
    }
    committedValues.set(el, readElementValue(el));
    const commitIfChanged = function () {
      const currentValue = readElementValue(el);
      if (currentValue === committedValues.get(el)) {
        return;
      }
      committedValues.set(el, currentValue);
      onCommit();
    };
    el.addEventListener("change", commitIfChanged);
    el.addEventListener("blur", commitIfChanged);
  }

  function bindInputs() {
    applyGlobalSettingsToDom();
    applyActionSettingsToDom();

    document.querySelectorAll("[data-global-setting]").forEach(function (el) {
      const key = el.getAttribute("data-global-setting");
      if (!key) return;
      bindControlEvents(el, function () {
        const next = {};
        next[key] = readElementValue(el);
        persistGlobalSettings(next);
      });
    });

    document.querySelectorAll("[data-action-setting]").forEach(function (el) {
      const key = el.getAttribute("data-action-setting");
      if (!key) return;
      bindControlEvents(el, function () {
        const next = {};
        next[key] = readElementValue(el);
        persistActionSettings(next);
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindInputs);
  } else {
    bindInputs();
  }

  window.hidePropertyInspector = {
    getGlobalSettings: effectiveGlobalSettings,
    setGlobalSettings: persistGlobalSettings,
    onGlobalSettings: function (listener) {
      globalListeners.push(listener);
    },
    getActionSettings: function () {
      return Object.assign({}, actionSettings);
    },
    setActionSettings: persistActionSettings,
    onActionSettings: function (listener) {
      actionListeners.push(listener);
    },
  };

  window.connectElgatoStreamDeckSocket = function (
    inPort,
    inPropertyInspectorUUID,
    inRegisterEvent,
    _inInfo,
    inActionInfo
  ) {
    inspectorUuid = inPropertyInspectorUUID;
    hasLoadedGlobalSettings = false;
    try {
      const parsedAction = JSON.parse(inActionInfo || "{}");
      if (parsedAction && parsedAction.payload && parsedAction.payload.settings) {
        actionSettings = Object.assign({}, parsedAction.payload.settings);
      }
    } catch (_err) {
      actionSettings = {};
    }

    applyActionSettingsToDom();

    websocket = new WebSocket("ws://127.0.0.1:" + inPort);
    websocket.onopen = function () {
      send({
        event: inRegisterEvent,
        uuid: inPropertyInspectorUUID,
      });
      send({
        event: "getGlobalSettings",
        context: inPropertyInspectorUUID,
      });
      send({
        event: "getSettings",
        context: inPropertyInspectorUUID,
      });
    };

    websocket.onmessage = function (evt) {
      let message;
      try {
        message = JSON.parse(evt.data);
      } catch (_err) {
        return;
      }
      if (message.event === "didReceiveGlobalSettings") {
        const incoming = (message.payload && message.payload.settings) || {};
        hasLoadedGlobalSettings = true;
        const hadPending = Object.keys(pendingGlobalPatch).length > 0;
        storedGlobalSettings = mergePatch(incoming, pendingGlobalPatch);
        pendingGlobalPatch = {};
        applyGlobalSettingsToDom();
        if (hadPending) {
          send({
            event: "setGlobalSettings",
            context: inspectorUuid,
            payload: storedGlobalSettings,
          });
        }
      } else if (message.event === "didReceiveSettings") {
        const incoming = (message.payload && message.payload.settings) || {};
        actionSettings = Object.assign({}, incoming);
        applyActionSettingsToDom();
      }
    };
  };
})();
