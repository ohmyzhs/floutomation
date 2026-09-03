(() => {
  const LEGACY_FLOW_PATH = /^\/fx\/(?:[^/]+\/)?tools\/flow(?:\/|$)/i;
  const DIRECT_FLOW_PATH = /^\/project\/[^/]+(?:\/|$)/i;
  const DIRECT_FLOW_HOSTS = new Set(["flow.google", "flow.google.com", "fow.google"]);
  const isDirectFlowProject = DIRECT_FLOW_HOSTS.has(location.hostname)
    && DIRECT_FLOW_PATH.test(location.pathname);
  if (!LEGACY_FLOW_PATH.test(location.pathname) && !isDirectFlowProject) return;
  if (window.__FLOW_BATCH_STUDIO_LOADED__) return;
  window.__FLOW_BATCH_STUDIO_LOADED__ = true;

  const pageSessionId = crypto.randomUUID();
  let activeJobId = null;
  let activeTaskType = null;
  let pauseRequested = false;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const UI_SETTLE_MS = 1_200;
  const NAVIGATION_SETTLE_MS = 1_800;
  const MAX_TRACKED_GENERATED_IMAGES = 4;

  function normalize(value) {
    return String(value || "")
      .replace(/arrow_forward|arrow_drop_down|crop_16_9|radio_button_(?:checked|unchecked)|tune|add_2/gi, "")
      .replace(/[\s🍌]+/g, "")
      .toLowerCase();
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hiddenPage = document.visibilityState === "hidden";
    const hasLayout = rect.width > 0 && rect.height > 0;
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0
      && (hasLayout || hiddenPage);
  }

  function emit(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  async function emitReliable(message, { retries = 3 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.ok === false) throw new Error(response.error || "확장 상태 저장에 실패했습니다.");
        return response;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < retries) await sleep(300 * (attempt + 1));
      }
    }
    throw new Error(`Flow 작업 상태를 저장하지 못했습니다: ${String(lastError?.message || lastError)}`);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 200, error = "Flow 화면 요소를 찾지 못했습니다." } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    throw new Error(error);
  }

  function findPromptInput() {
    return Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]'))
      .filter((element) => element instanceof HTMLElement && visible(element))
      .find((element) => element.getAttribute("contenteditable") === "true") || null;
  }

  function findDirectProjectNavigationItem(label) {
    if (!isDirectFlowProject) return null;
    const target = normalize(label);
    return Array.from(document.querySelectorAll("mat-list-item")).find((item) => {
      if (!visible(item)) return false;
      const descriptor = normalize(`${item.textContent || ""} ${item.getAttribute("aria-label") || ""}`);
      return descriptor.includes(target);
    }) || null;
  }

  function isDirectFlowProjectWorkspace() {
    return isDirectFlowProject && /^\/project\/[^/]+\/?$/i.test(location.pathname);
  }

  function findAllMediaNavigationButton() {
    const directNavigationItem = findDirectProjectNavigationItem("전체 미디어");
    if (directNavigationItem) return directNavigationItem;
    return Array.from(document.querySelectorAll('button, [role="button"], a')).find((control) => {
      if (!visible(control)) return false;
      const text = String(control.textContent || "").replace(/\s+/g, "").toLowerCase();
      const label = String(control.getAttribute("aria-label") || "").replace(/\s+/g, "").toLowerCase();
      const descriptor = `${text}${label}`;
      return (text.includes("dashboard") || label.includes("dashboard")) && /모든미디어|allmedia/.test(descriptor);
    }) || null;
  }

  function navigationItemSelected(control) {
    if (!(control instanceof HTMLElement)) return false;
    if (control.getAttribute("aria-current") === "page" || control.getAttribute("aria-selected") === "true") return true;
    return [control, control.parentElement].some((container) => {
      if (!(container instanceof HTMLElement)) return false;
      const background = getComputedStyle(container).backgroundColor;
      const rgba = background.match(/rgba?\(([^)]+)\)/i)?.[1]?.split(",").map((part) => Number(part.trim()));
      if (!rgba || rgba.length < 3) return false;
      return rgba.length === 3 || Number(rgba[3] || 0) > 0.05;
    });
  }

  function findAgentConversationCloseButton() {
    return Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visible(button)) return false;
      const descriptor = `${button.textContent || ""}${button.getAttribute("aria-label") || ""}`
        .replace(/\s+/g, "")
        .toLowerCase();
      return descriptor === "close닫기" || descriptor === "closeclose";
    }) || null;
  }

  function findAgentModeButton() {
    return Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visible(button)) return false;
      const descriptor = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
      return descriptor === normalize("에이전트") || descriptor === "agent";
    }) || null;
  }

  function agentModeEnabled(button = findAgentModeButton()) {
    return Boolean(button && (
      button.getAttribute("aria-pressed") === "true"
      || button.getAttribute("data-state") === "on"
      || button.getAttribute("data-state") === "active"
    ));
  }

  function findDirectSettingsButton(input = null) {
    const isSettingsButton = (button) => {
      if (!visible(button)) return false;
      const descriptor = String(button.textContent || button.getAttribute("aria-label") || "")
        .replace(/\s+/g, "")
        .toLowerCase();
      return /(?:banana|imagen|veo)/i.test(descriptor)
        && /(?:crop_|16:9|4:3|1:1|3:4|9:16|x[1-4])/.test(descriptor);
    };

    let node = input?.parentElement || null;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const match = Array.from(node.querySelectorAll("button")).find(isSettingsButton);
      if (match) return match;
    }
    return Array.from(document.querySelectorAll("button")).find(isSettingsButton) || null;
  }

  function findDirectPromptInput() {
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((element) => element instanceof HTMLElement && visible(element));
    return candidates.find((input) => {
      let node = input.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        const hasAgentToggle = Array.from(node.querySelectorAll("button")).some((button) => {
          const descriptor = normalize(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
          return visible(button) && (descriptor === normalize("에이전트") || descriptor === "agent");
        });
        if (hasAgentToggle) return true;
      }
      return false;
    }) || null;
  }

  async function selectSettingsTab(section, label, matcher) {
    const target = Array.from(section.querySelectorAll('[role="tab"]'))
      .find((tab) => visible(tab) && matcher(normalize(tab.textContent), normalize(label)));
    if (!target) throw new Error(`Flow 설정에서 ${label} 옵션을 찾지 못했습니다.`);
    const selected = target.getAttribute("aria-selected") === "true" || target.getAttribute("data-state") === "active";
    if (!selected) {
      await clickTrusted(target);
      await waitFor(
        () => target.getAttribute("aria-selected") === "true" || target.getAttribute("data-state") === "active",
        { error: `${label} 설정이 선택되지 않았습니다.` }
      );
    }
  }

  const SUPPORTED_FLOW_MODELS = Object.freeze([
    "Nano Banana Pro",
    "Nano Banana 2",
    "Nano Banana 2 Lite"
  ]);
  const SUPPORTED_FLOW_ASPECT_RATIOS = Object.freeze(["16:9", "4:3", "1:1", "3:4", "9:16"]);

  function requestedFlowModel(value) {
    const requested = String(value || "");
    return SUPPORTED_FLOW_MODELS.includes(requested) ? requested : "Nano Banana 2";
  }

  function canonicalFlowModel(value) {
    const text = normalize(value);
    if (text.includes("nanobananapro")) return "Nano Banana Pro";
    if (text.includes("nanobanana2lite")) return "Nano Banana 2 Lite";
    if (text.includes("nanobanana2")) return "Nano Banana 2";
    return null;
  }

  function isExactFlowModel(value, expectedModel) {
    return canonicalFlowModel(value) === requestedFlowModel(expectedModel);
  }

  function findDirectSettingsMenu() {
    return Array.from(document.querySelectorAll('[role="menu"]')).find((menu) => {
      if (!(menu instanceof HTMLElement) || !visible(menu)) return false;
      const tabs = Array.from(menu.querySelectorAll('[role="tab"]')).filter(visible);
      const hasImageTab = tabs.some((tab) => /이미지|image/.test(normalize(tab.textContent)));
      const hasRatio = tabs.some((tab) => SUPPORTED_FLOW_ASPECT_RATIOS.some((ratio) => normalize(tab.textContent).endsWith(normalize(ratio))));
      const hasCount = tabs.some((tab) => /^x[1-4]$/.test(normalize(tab.textContent)));
      return hasImageTab && hasRatio && hasCount;
    }) || null;
  }

  async function ensureDirectImageModel(section, requestedModel) {
    const model = requestedFlowModel(requestedModel);
    const modelButton = Array.from(section.querySelectorAll("button"))
      .find((button) => visible(button) && /banana|imagen/i.test(button.textContent || ""));
    if (!modelButton) throw new Error("Flow 일반 이미지 생성의 모델 선택 버튼을 찾지 못했습니다.");
    if (isExactFlowModel(modelButton.textContent, model)) return;

    await clickTrusted(modelButton, { settleMs: NAVIGATION_SETTLE_MS });
    const menuItem = await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .find((item) => visible(item) && isExactFlowModel(item.textContent, model)),
      { error: `Flow 일반 이미지 생성에서 ${model} 모델을 찾지 못했습니다.` }
    );
    await clickTrusted(menuItem);
    await waitFor(() => isExactFlowModel(modelButton.textContent, model), {
      error: `Flow 일반 이미지 모델을 ${model}(으)로 바꾸지 못했습니다.`
    });
  }

  function requestedFlowAspectRatio(value) {
    const requested = String(value || "");
    return SUPPORTED_FLOW_ASPECT_RATIOS.includes(requested) ? requested : "16:9";
  }

  function requestedFlowImageCount(value) {
    const requested = Number(value);
    return Number.isFinite(requested) ? Math.min(4, Math.max(1, Math.round(requested))) : 2;
  }

  async function ensureDirectImageSettings(input, requestedModel, requestedAspectRatio, requestedImagesPerPrompt) {
    const aspectRatio = requestedFlowAspectRatio(requestedAspectRatio);
    const imagesPerPrompt = requestedFlowImageCount(requestedImagesPerPrompt);
    const settingsButton = await waitFor(() => findDirectSettingsButton(input), {
      timeoutMs: 15_000,
      intervalMs: 200,
      error: "Flow 모든 미디어의 일반 이미지 설정 버튼을 찾지 못했습니다. 에이전트 모드가 꺼져 있는지 확인해 주세요."
    });
    await clickTrusted(settingsButton, { settleMs: 600 });
    const section = await waitFor(findDirectSettingsMenu, {
      timeoutMs: 8_000,
      intervalMs: 100,
      error: "Flow 일반 이미지 설정 메뉴를 열지 못했습니다."
    });

    await selectSettingsTab(section, "이미지", (value, target) => value.endsWith(target) || value === "image");
    await selectSettingsTab(section, aspectRatio, (value, target) => value.endsWith(target));
    await selectSettingsTab(section, `x${imagesPerPrompt}`, (value, target) => value === target || value === `${imagesPerPrompt}x`);
    await ensureDirectImageModel(section, requestedModel);

    if (findDirectSettingsMenu() && document.contains(settingsButton)) {
      await clickTrusted(settingsButton, { settleMs: 600 });
    }
    return waitFor(findDirectPromptInput, {
      timeoutMs: 8_000,
      intervalMs: 100,
      error: "Flow 일반 이미지 설정 후 프롬프트 입력창으로 돌아오지 못했습니다."
    });
  }

  function placeCaretAtEnd(input) {
    input.focus();
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      const length = input.value.length;
      input.setSelectionRange(length, length);
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function insertTrustedText(input, text, { clear = false } = {}) {
    if (!(input instanceof HTMLElement) || !document.contains(input)) {
      throw new Error("Flow 입력란이 화면에서 사라졌습니다.");
    }
    placeCaretAtEnd(input);
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_TRUSTED_TYPE",
      text: String(text || ""),
      clear: Boolean(clear)
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Flow 입력란에 실제 키 입력을 전달하지 못했습니다.");
    }
    await sleep(80);
  }

  async function pressTrustedAtSign(input) {
    if (!(input instanceof HTMLElement) || !document.contains(input)) {
      throw new Error("Flow 입력란이 화면에서 사라졌습니다.");
    }
    placeCaretAtEnd(input);
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_TRUSTED_KEY",
      key: "@"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Flow 애셋 선택창을 여는 실제 키 입력을 전달하지 못했습니다.");
    }
    await sleep(250);
  }

  async function clickTrusted(element, { settleMs = UI_SETTLE_MS } = {}) {
    if (!(element instanceof HTMLElement) || !document.contains(element) || !visible(element)) {
      throw new Error("클릭할 Flow 화면 요소가 사라졌습니다.");
    }
    element.focus?.({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const hiddenPage = document.visibilityState === "hidden";
    if (hiddenPage || rect.width <= 0 || rect.height <= 0) {
      element.click();
      await sleep(Math.max(UI_SETTLE_MS, Number(settleMs || 0)));
      return { ok: true, clicked: true, synthetic: true };
    }
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_TRUSTED_CLICK",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Flow 화면에 실제 클릭을 전달하지 못했습니다.");
    }
    await sleep(Math.max(UI_SETTLE_MS, Number(settleMs || 0)));
  }

  async function doubleClickTrusted(element, { settleMs = NAVIGATION_SETTLE_MS } = {}) {
    if (!(element instanceof HTMLElement) || !document.contains(element) || !visible(element)) {
      throw new Error("더블클릭할 Flow 캐릭터 카드가 사라졌습니다.");
    }
    element.focus?.({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const hiddenPage = document.visibilityState === "hidden";
    if (hiddenPage || rect.width <= 0 || rect.height <= 0) {
      element.click();
      element.click();
      await sleep(Math.max(UI_SETTLE_MS, Number(settleMs || 0)));
      return { ok: true, clicked: true, synthetic: true };
    }
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_TRUSTED_DOUBLE_CLICK",
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Flow 캐릭터 카드에 실제 더블클릭을 전달하지 못했습니다.");
    }
    await sleep(Math.max(UI_SETTLE_MS, Number(settleMs || 0)));
    return response;
  }

  async function submitWithTrustedEnter(element) {
    if (!(element instanceof HTMLElement) || !document.contains(element) || !visible(element)) {
      throw new Error("전송할 Flow 버튼이 사라졌습니다.");
    }
    element.focus({ preventScroll: true });
    const response = await chrome.runtime.sendMessage({ type: "FLOW_TRUSTED_SUBMIT" });
    if (!response?.ok) {
      throw new Error(response?.error || "Flow 전송 키 입력을 전달하지 못했습니다.");
    }
    await sleep(UI_SETTLE_MS);
  }

  function normalizedEditorText(input) {
    return String(input.innerText || input.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function setPrompt(input, prompt) {
    await insertTrustedText(input, prompt, { clear: true });
    const expected = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 80);
    await waitFor(() => !expected || normalizedEditorText(input).includes(expected), {
      timeoutMs: 3_000,
      intervalMs: 100,
      error: "Flow 편집기가 입력 내용을 반영하지 못했습니다. Flow 탭에 DevTools가 열려 있는지 확인해 주세요."
    });
  }

  function findAssetPickerDialog() {
    return Array.from(document.querySelectorAll('[role="dialog"]')).find((dialog) => {
      if (!(dialog instanceof HTMLElement) || !visible(dialog)) return false;
      const search = Array.from(dialog.querySelectorAll('input, [role="textbox"]')).find((control) => {
        const descriptor = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("placeholder") || ""}`;
        return /애셋\s*검색|search\s*assets?/i.test(descriptor);
      });
      const addButton = Array.from(dialog.querySelectorAll("button")).find((button) => {
        const text = String(button.textContent || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        return /^(?:프롬프트에 추가|add to prompt)$/i.test(text);
      });
      return Boolean(search && addButton);
    }) || null;
  }

  function findAssetSearchInput(dialog = findAssetPickerDialog()) {
    if (!dialog) return null;
    return Array.from(dialog.querySelectorAll('input, [role="textbox"]')).find((control) => {
      if (!(control instanceof HTMLElement) || !visible(control)) return false;
      const descriptor = `${control.getAttribute("aria-label") || ""} ${control.getAttribute("placeholder") || ""}`;
      return /애셋\s*검색|search\s*assets?/i.test(descriptor);
    }) || null;
  }

  function findCharacterAssetFilter(dialog = findAssetPickerDialog()) {
    if (!dialog) return null;
    const dialogRect = dialog.getBoundingClientRect();
    const isCharacterLabel = (element) => {
      if (!(element instanceof HTMLElement) || !visible(element) || element.closest('[role="option"]')) return false;
      const text = String(element.textContent || element.getAttribute("aria-label") || "")
        .replace(/accessibility_new|person|character/gi, (token) => token.toLowerCase() === "character" ? "character" : "")
        .replace(/\s+/g, "")
        .toLowerCase();
      const rect = element.getBoundingClientRect();
      return (text === "캐릭터" || text === "character")
        && (document.visibilityState === "hidden"
          || rect.left + rect.width / 2 < dialogRect.left + dialogRect.width * 0.3);
    };

    const semantic = Array.from(dialog.querySelectorAll('button, [role="tab"], [role="button"]')).find(isCharacterLabel);
    if (semantic) return semantic;
    const label = Array.from(dialog.querySelectorAll("div, span, p"))
      .filter((element) => element.children.length === 0)
      .find(isCharacterLabel);
    return label?.closest('button, [role="tab"], [role="button"], [tabindex]') || label?.parentElement || null;
  }

  async function selectCharacterAssetFilter(dialog) {
    const characterFilter = await waitFor(() => findCharacterAssetFilter(dialog), {
      timeoutMs: 5_000,
      intervalMs: 100,
      error: "Flow 애셋 창에서 '캐릭터' 필터를 찾지 못했습니다."
    });
    await clickTrusted(characterFilter, { settleMs: 800 });
    return waitFor(() => {
      const currentDialog = findAssetPickerDialog();
      const currentFilter = currentDialog ? findCharacterAssetFilter(currentDialog) : null;
      return currentDialog && currentFilter && navigationItemSelected(currentFilter) && findAssetSearchInput(currentDialog)
        ? currentDialog
        : null;
    }, {
      timeoutMs: 5_000,
      intervalMs: 100,
      error: "Flow 애셋 창의 캐릭터 필터를 선택한 뒤 검색 화면이 준비되지 않았습니다."
    });
  }

  function findCharacterAssetOption(dialog, key) {
    if (!dialog) return null;
    const target = normalize(key).replace(/^@/, "");
    return Array.from(dialog.querySelectorAll('[role="option"], button')).find((option) => {
      if (!(option instanceof HTMLElement) || !visible(option)) return false;
      const text = normalize(option.textContent);
      const imageLabel = normalize(option.querySelector("img")?.getAttribute("alt") || "");
      const exactName = imageLabel === target
        || text === target
        || text === `${target}${target}`
        || text === `${target}${target}${normalize("캐릭터")}`
        || text === `${target}${target}character`;
      return exactName && !option.contains(findAssetSearchInput(dialog));
    }) || null;
  }

  function findAssetAddButton(dialog = findAssetPickerDialog()) {
    if (!dialog) return null;
    return Array.from(dialog.querySelectorAll("button")).find((button) => {
      if (!visible(button)) return false;
      const text = String(button.textContent || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      return /^(?:프롬프트에 추가|add to prompt)$/i.test(text);
    }) || null;
  }

  function accessibleDescriptor(element) {
    if (!(element instanceof HTMLElement)) return "";
    const imageLabels = Array.from(element.querySelectorAll("img"))
      .flatMap((image) => [image.getAttribute("alt"), image.getAttribute("aria-label")])
      .filter(Boolean)
      .join(" ");
    return `${element.textContent || ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${imageLabels}`
      .replace(/\s+/g, " ")
      .trim();
  }

  function findCharacterReferenceControls(input) {
    let node = input?.parentElement || null;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const matches = Array.from(node.querySelectorAll("button")).filter((button) => {
        if (!visible(button)) return false;
        const descriptor = accessibleDescriptor(button);
        return /캐릭터\s*참고\s*이미지|character\s*reference\s*image/i.test(descriptor);
      });
      if (matches.length) return matches;
    }
    return [];
  }

  function findPromptClearButton(input) {
    let node = input?.parentElement || null;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const button = Array.from(node.querySelectorAll("button")).find((candidate) => {
        if (!visible(candidate)) return false;
        const descriptor = accessibleDescriptor(candidate).replace(/\s+/g, "").toLowerCase();
        return descriptor.includes("프롬프트지우기") || descriptor.includes("clearprompt");
      });
      if (button) return button;
    }
    return null;
  }

  async function clearScenePrompt(input) {
    const clearButton = findPromptClearButton(input);
    if (clearButton) {
      await clickTrusted(clearButton);
      input = await waitFor(findDirectPromptInput, {
        timeoutMs: 5_000,
        intervalMs: 100,
        error: "Flow 프롬프트를 지운 뒤 입력란을 다시 찾지 못했습니다."
      });
    } else {
      await insertTrustedText(input, "", { clear: true });
    }

    await waitFor(() => findCharacterReferenceControls(input).length === 0, {
      timeoutMs: 5_000,
      intervalMs: 100,
      error: "이전 캐릭터 참조 칩을 초기화하지 못했습니다. Flow의 프롬프트 지우기 버튼으로 비운 뒤 재시도해 주세요."
    });
    return input;
  }

  async function bindCharacterAssetReference(input, key) {
    const beforeReferenceCount = findCharacterReferenceControls(input).length;
    await pressTrustedAtSign(input);
    let dialog = await waitFor(findAssetPickerDialog, {
      timeoutMs: 8_000,
      intervalMs: 100,
      error: `@${key} 입력 후 Flow 애셋 선택창이 열리지 않았습니다.`
    });
    dialog = await selectCharacterAssetFilter(dialog);
    const searchInput = await waitFor(() => findAssetSearchInput(dialog), {
      timeoutMs: 3_000,
      intervalMs: 100,
      error: "Flow 애셋 검색 입력란을 찾지 못했습니다."
    });
    await insertTrustedText(searchInput, key, { clear: true });

    const option = await waitFor(() => findCharacterAssetOption(dialog, key), {
      timeoutMs: 8_000,
      intervalMs: 150,
      error: `Flow 애셋에서 @${key} 캐릭터를 찾지 못했습니다. 등록 이름과 유형이 '캐릭터'인지 확인해 주세요.`
    });
    const selected = option.getAttribute("aria-selected") === "true" || option.getAttribute("data-state") === "checked";
    if (!selected) await clickTrusted(option, { settleMs: 500 });

    const openDialog = findAssetPickerDialog();
    if (openDialog) {
      const addButton = await waitFor(() => {
        const button = findAssetAddButton(openDialog);
        return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
      }, {
        timeoutMs: 5_000,
        intervalMs: 100,
        error: `@${key} 캐릭터의 '프롬프트에 추가' 버튼이 활성화되지 않았습니다.`
      });
      await clickTrusted(addButton);
    }

    await waitFor(() => !findAssetPickerDialog(), {
      timeoutMs: 8_000,
      intervalMs: 100,
      error: `@${key} 캐릭터를 추가한 뒤 애셋 선택창이 닫히지 않았습니다.`
    });
    await waitFor(() => {
      const referenceCount = findCharacterReferenceControls(input).length;
      return referenceCount > beforeReferenceCount;
    }, {
      timeoutMs: 5_000,
      intervalMs: 100,
      error: `@${key}가 실제 캐릭터 참조 칩으로 연결되지 않았습니다.`
    });
  }

  async function setPromptWithCharacterReferences(input, prompt, expectedRefs = []) {
    const expected = new Set(expectedRefs.map(String));
    const matches = [...prompt.matchAll(/@([A-Za-z][\w-]*)/g)];
    const boundKeys = new Set();
    input = await clearScenePrompt(input);
    let cursor = 0;

    for (const match of matches) {
      const key = match[1];
      if (!expected.has(key)) {
        throw new Error(`정의되지 않은 캐릭터 참조 @${key}가 포함되어 있습니다.`);
      }
      await insertTrustedText(input, prompt.slice(cursor, match.index));
      if (boundKeys.has(key)) {
        // A character can be mentioned repeatedly in prose, but Flow only needs one reference chip per character.
        await insertTrustedText(input, key);
      } else {
        await bindCharacterAssetReference(input, key);
        boundKeys.add(key);
      }
      cursor = Number(match.index) + match[0].length;
    }

    await insertTrustedText(input, prompt.slice(cursor));
    const proseSegments = String(prompt || "")
      .split(/@[A-Za-z][\w-]*/g)
      .map((segment) => segment.replace(/[\s\u200b]+/g, ""))
      .filter(Boolean);
    await waitFor(() => {
      const editorText = normalizedEditorText(input).replace(/[\s\u200b]+/g, "");
      const referenceCount = findCharacterReferenceControls(input).length;
      return referenceCount >= boundKeys.size && proseSegments.every((segment) => editorText.includes(segment));
    }, {
      timeoutMs: 8_000,
      intervalMs: 100,
      error: "캐릭터 참조는 연결됐지만 장면 프롬프트 본문 전체가 입력되지 않았습니다. 생성 요청은 보내지 않았습니다."
    });
  }

  function submitButtonDescriptor(button) {
    return accessibleDescriptor(button)
      + ` ${button.getAttribute("data-testid") || ""} ${button.getAttribute("data-test-id") || ""}`;
  }

  function submitButtonScore(button, input, depth) {
    if (!(button instanceof HTMLElement) || !visible(button)) return Number.NEGATIVE_INFINITY;
    const descriptor = submitButtonDescriptor(button).replace(/\s+/g, " ").trim();
    const compact = descriptor.replace(/\s+/g, "").toLowerCase();
    const type = String(button.getAttribute("type") || "").toLowerCase();
    const role = String(button.getAttribute("role") || "").toLowerCase();
    const looksLikeSubmit = /(?:arrow_forward|arrow_right_alt|send|play_arrow|east|만들기|생성|전송|보내기|create|generate|submit)/i.test(compact);
    const explicitSubmitLabel = /(?:만들기|생성|전송|보내기|create|generate|submit|send)/i.test(descriptor);
    const hasSubmitTestId = /(?:submit|send|create|generate)/i.test(`${button.getAttribute("data-testid") || ""} ${button.getAttribute("data-test-id") || ""}`);
    const form = input?.closest("form");
    const associatedForm = button.getAttribute("form");
    const sameForm = Boolean(form && (button.closest("form") === form || (associatedForm && associatedForm === form.id)));
    if (!looksLikeSubmit && type !== "submit" && !hasSubmitTestId) return Number.NEGATIVE_INFINITY;

    let score = 0;
    if (type === "submit") score += 140;
    if (sameForm) score += 100;
    if (role === "button") score += 8;
    if (explicitSubmitLabel) score += 55;
    if (hasSubmitTestId) score += 45;
    if (/arrow_forward|arrow_right_alt|send|play_arrow|east/i.test(compact)) score += 30;
    if (/close|뒤로|back|삭제|delete|cancel/i.test(descriptor)) score -= 120;
    return score - depth * 5;
  }

  function findSubmitButton(input = findPromptInput()) {
    const candidates = new Map();
    const addCandidates = (root, depth) => {
      if (!(root instanceof HTMLElement)) return;
      root.querySelectorAll("button, [role=\"button\"]").forEach((button) => {
        const score = submitButtonScore(button, input, depth);
        if (score === Number.NEGATIVE_INFINITY) return;
        const previous = candidates.get(button);
        if (!previous || score > previous) candidates.set(button, score);
      });
    };

    const form = input?.closest("form");
    if (form) addCandidates(form, 0);
    let node = input?.parentElement || null;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      addCandidates(node, depth);
    }
    addCandidates(document.body, 12);

    return Array.from(candidates.entries())
      .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
  }

  function isCharacterSubmitButton(button) {
    if (!(button instanceof HTMLElement) || !visible(button)) return false;
    const hasForwardIcon = Array.from(button.querySelectorAll('i.google-symbols, i, mat-icon, [data-mat-icon-type="font"]'))
      .some((icon) => String(icon.textContent || "").trim() === "arrow_forward");
    const hasCreateLabel = Array.from(button.querySelectorAll("span"))
      .some((label) => /^(?:만들기|create)$/i.test(String(label.textContent || "").trim()));
    if (!hasForwardIcon) return false;
    if (hasCreateLabel) return true;

    const descriptor = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("data-testid") || ""}`
      .replace(/\s+/g, " ")
      .trim();
    return String(button.textContent || "").trim() === "arrow_forward"
      || /(?:생성\s*시작|create|generate|submit)/i.test(descriptor);
  }

  function findCharacterSubmitButton(input = findCharacterCreatorInput()) {
    let node = input?.parentElement || null;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const button = Array.from(node.querySelectorAll('button, [role="button"]')).find(isCharacterSubmitButton);
      if (button) return button;
    }
    return Array.from(document.querySelectorAll('button, [role="button"]')).find(isCharacterSubmitButton) || null;
  }

  async function clickCharacterSubmit(button) {
    if (!submitControlIsEnabled(button)) {
      throw new Error("Flow 캐릭터 만들기 버튼이 비활성 상태입니다.");
    }
    button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    button.focus({ preventScroll: true });
    button.click();
    await sleep(UI_SETTLE_MS);
    return { ok: true, clicked: true, method: "button.click" };
  }

  function assetIdFromDetailUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      const match = url.pathname.match(/\/(?:edit|character)\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]).trim() : "";
    } catch {
      return "";
    }
  }

  function mediaFingerprint(element, index) {
    const detailUrl = element.closest?.('a[href*="/edit/"]')?.href || "";
    const assetId = assetIdFromDetailUrl(detailUrl);
    if (assetId) return `asset:${assetId}`;
    if (element instanceof HTMLImageElement) return `img:${element.currentSrc || element.src || element.srcset || index}`;
    if (element instanceof HTMLVideoElement) return `video:${element.poster || element.currentSrc || index}`;
    if (element instanceof HTMLCanvasElement) return `canvas:${element.width}x${element.height}:${index}`;
    const style = element.getAttribute("style") || "";
    const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)/i);
    return match ? `bg:${match[1]}` : `media:${index}`;
  }

  function downloadableMediaAsset(element) {
    if (element instanceof HTMLImageElement) {
      const url = String(element.currentSrc || element.src || "").trim();
      if (!/^https:\/\//i.test(url)) return null;
      const detailUrl = String(element.closest?.('a[href*="/edit/"]')?.href || "").trim();
      return {
        url,
        detailUrl,
        assetId: assetIdFromDetailUrl(detailUrl)
      };
    }
    const style = element.getAttribute("style") || "";
    const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)/i);
    return match && /^https:\/\//i.test(match[1]) ? { url: match[1], detailUrl: "", assetId: "" } : null;
  }

  function captureLargeMediaAssets({ includeOffscreen = false } = {}) {
    const candidates = Array.from(document.querySelectorAll('img, video[poster], canvas, [style*="background-image"]'));
    const assets = new Map();
    candidates.forEach((element, index) => {
      if (!(element instanceof HTMLElement)) return;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0) return;
      if (!includeOffscreen && !visible(element)) return;
      if (element.closest('button[aria-label*="프로필"], button[aria-label*="profile" i]')) return;
      const rect = element.getBoundingClientRect();
      const intrinsicWidth = element instanceof HTMLImageElement ? element.naturalWidth : element instanceof HTMLCanvasElement ? element.width : rect.width;
      const intrinsicHeight = element instanceof HTMLImageElement ? element.naturalHeight : element instanceof HTMLCanvasElement ? element.height : rect.height;
      const largeEnough = (rect.width >= 160 && rect.height >= 90) || (intrinsicWidth >= 512 && intrinsicHeight >= 288);
      if (!largeEnough) return;
      const fingerprint = mediaFingerprint(element, index);
      assets.set(fingerprint, downloadableMediaAsset(element));
    });
    return assets;
  }

  function captureLargeMedia() {
    return new Set(captureLargeMediaAssets({ includeOffscreen: true }).keys());
  }

  function newDownloadableAssets(mediaAssets, baselineMedia) {
    function collectLeading(entries) {
      const seen = new Set();
      const assets = [];
      for (const [fingerprint, asset] of entries) {
        if (baselineMedia.has(fingerprint)) break;
        const identity = asset?.assetId || asset?.detailUrl || asset?.url;
        if (!asset?.url || seen.has(identity)) continue;
        seen.add(identity);
        assets.push(asset);
      }
      return assets;
    }
    const entries = Array.from(mediaAssets.entries());
    // Flow normally inserts newest cards first. The reverse pass keeps this
    // safe if the localized Flow surface renders the card list oldest-first.
    const newestBlock = collectLeading(entries);
    const oldestBlock = collectLeading(entries.slice().reverse());
    const assets = newestBlock.length ? newestBlock : oldestBlock;
    // The UI supports at most four images per request. Anything beyond this
    // is almost certainly a card that became visible outside this generation
    // boundary, so leave it available for explicit manual mapping instead of
    // attaching dozens of unrelated cards to one scene.
    return assets.slice(0, MAX_TRACKED_GENERATED_IMAGES);
  }

  function captureCompletionSignals() {
    const pattern = /(?:이미지.{0,30}(?:완료|생성|만들)|(?:created|generated|finished|complete).{0,30}images?)/i;
    return new Set(
      Array.from(document.querySelectorAll('p, [role="status"], [data-testid*="message" i]'))
        .filter(visible)
        .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 3 && text.length < 500 && pattern.test(text))
        .slice(-30)
    );
  }

  function normalizeTrackingPrompt(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/@(?=[A-Za-z][\w-]*)/g, "")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function progressCardMatchesPrompt(cardPrompt, expectedPrompt) {
    const actual = normalizeTrackingPrompt(cardPrompt);
    const expected = normalizeTrackingPrompt(expectedPrompt);
    if (!expected || !actual) return true;
    if (actual.includes(expected) || expected.includes(actual)) return true;
    const sampleSize = Math.min(120, expected.length);
    return sampleSize >= 40
      && actual.includes(expected.slice(0, sampleSize))
      && actual.includes(expected.slice(-sampleSize));
  }

  function findGenerationProgressCards(expectedPrompt = "") {
    const percentageNodes = Array.from(document.querySelectorAll("div, span, p"))
      .filter((element) => element instanceof HTMLElement && visible(element) && element.children.length === 0)
      .map((element) => {
        const match = String(element.textContent || "").trim().match(/^(100|\d{1,2})\s*%$/);
        return match ? { element, percentage: Number(match[1]) } : null;
      })
      .filter(Boolean);

    const cards = [];
    for (const item of percentageNodes) {
      let node = item.element.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const hasImageIcon = Array.from(node.querySelectorAll("i, span")).some((element) => {
          if (!(element instanceof HTMLElement) || !visible(element) || element.children.length > 0) return false;
          return String(element.textContent || "").trim().toLowerCase() === "image"
            && (element.tagName === "I" || element.classList.contains("google-symbols"));
        });
        if (!hasImageIcon) continue;

        const prompt = Array.from(node.querySelectorAll("div, p"))
          .filter((element) => element instanceof HTMLElement && visible(element) && element.children.length === 0)
          .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
          .filter((text) => text.length >= 40 && !/^(100|\d{1,2})\s*%$/.test(text))
          .sort((left, right) => right.length - left.length)[0] || "";
        if (!prompt) continue;

        cards.push({
          percentage: item.percentage,
          prompt,
          matchesPrompt: progressCardMatchesPrompt(prompt, expectedPrompt)
        });
        break;
      }
    }

    if (!expectedPrompt) return cards;
    const matching = cards.filter((card) => card.matchesPrompt);
    return matching.length ? matching : cards;
  }

  function hasBusySignal(progressCards = null) {
    if ((progressCards || findGenerationProgressCards()).length > 0) return true;
    if (Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some(visible)) return true;
    return Array.from(document.querySelectorAll('button, [role="status"]')).some((element) => {
      if (!visible(element)) return false;
      const text = String(element.textContent || "").replace(/\s+/g, "").toLowerCase();
      return /(?:생성중|만드는중|처리중|creating|generating|progress|hourglass|stop_circle)/.test(text);
    });
  }

  function captureGenerationFailureCards() {
    const failurePattern = /(?:생성.{0,30}(?:일일\s*)?한도|일일\s*한도|다른\s*모델을\s*사용|generation.{0,30}(?:quota|limit)|quota|limit reached|not enough credits|가이드라인|안전\s*정책|moderation|safety|guideline|unsafe|blocked|violat(?:e|ion))/i;
    return Array.from(document.querySelectorAll("button"))
      .filter((button) => {
        if (!(button instanceof HTMLElement) || !visible(button)) return false;
        const text = String(button.textContent || "").replace(/\s+/g, " ").trim();
        return /(?:실패|failed|warning|차단|blocked|safety|policy|guideline|moderation|unsafe|위반)/i.test(text)
          && failurePattern.test(text);
      });
  }

  function generationFailureMessage(cards = captureGenerationFailureCards()) {
    const card = cards.at(-1);
    if (!card) return null;
    const text = String(card.textContent || "").replace(/\s+/g, " ").trim();
    if (/(?:생성.{0,30}일일\s*한도|generation.{0,30}(?:daily\s*)?(?:quota|limit))/i.test(text)) {
      const failedModel = canonicalFlowModel(text) || "선택한 모델";
      return `${failedModel} 생성 일일 한도에 도달했습니다. 다른 모델을 선택한 뒤 실패 작업을 재시도해 주세요.`;
    }
    return text;
  }

  function findFlowError({ baselineFailureCount = null } = {}) {
    const errorPattern = /(?:오류|실패|한도|크레딧.{0,12}부족|잠시 후 다시|로봇이 아님|사람인지 확인|가이드라인|안전\s*정책|콘텐츠.{0,20}(?:차단|생성할 수)|error|failed|quota|limit reached|not enough credits|captcha|verify (?:that )?you(?:'re| are) human|moderation|safety|guideline|unsafe|blocked|violat(?:e|ion))/i;
    const elements = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [data-sonner-toast], [data-state="open"]'));
    let message = elements
      .filter(visible)
      .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
      .find((text) => errorPattern.test(text) && !/실수를 할 수|can make mistakes/i.test(text));
    const failureCards = captureGenerationFailureCards();
    if (!message && (baselineFailureCount == null || failureCards.length > baselineFailureCount)) {
      message = generationFailureMessage(failureCards);
    }
    if (!message) return null;
    if (/(?:로봇이 아님|사람인지 확인|captcha|verify (?:that )?you(?:'re| are) human)/i.test(message)) {
      return "Flow에서 사용자 확인이 필요합니다. 자동 실행을 멈췄습니다. 직접 확인을 완료한 뒤 실패 작업을 재시도해 주세요.";
    }
    return message;
  }

  function submitControlIsEnabled(control) {
    return control instanceof HTMLElement
      && document.contains(control)
      && visible(control)
      && !(control instanceof HTMLButtonElement && control.disabled)
      && !control.hasAttribute("disabled")
      && control.getAttribute("aria-disabled") !== "true";
  }

  function submissionDiagnostic(control, action) {
    if (!(control instanceof HTMLElement) || !document.contains(control)) {
      return `${action} · 전송 버튼을 찾지 못함`;
    }
    const rect = control.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(centerX, centerY) : null;
    const hitText = hit instanceof HTMLElement
      ? `${hit.tagName.toLowerCase()}${hit.getAttribute("aria-label") ? `:${hit.getAttribute("aria-label")}` : ""}`
      : "없음";
    const enabled = submitControlIsEnabled(control) ? "활성" : "비활성";
    const descriptor = accessibleDescriptor(control).replace(/\s+/g, " ").trim().slice(0, 100) || "라벨 없음";
    const type = control.getAttribute("type") || control.getAttribute("role") || control.tagName.toLowerCase();
    return `${action} · ${enabled} · ${type} · ${Math.round(rect.width)}×${Math.round(rect.height)} · 중심 대상 ${hitText} · ${descriptor}`;
  }

  async function confirmGenerationStarted({
    input = null,
    expectedPrompt,
    baselineFailureCount = 0,
    findSubmitControl = findSubmitButton,
    retrySubmit = submitWithTrustedEnter,
    additionalStartSignal = null,
    failureMessage = "Flow가 생성 요청을 시작하지 않았습니다. 프롬프트 길이와 무관하게 버튼이 활성 상태로 남았습니다. 좌표 클릭 후 키보드 전송까지 한 번 재시도했지만 생성 신호를 확인하지 못해 작업을 중단했습니다.",
    onRetry
  }) {
    const startedAt = Date.now();
    let retrySubmitted = false;

    while (Date.now() - startedAt < 24_000) {
      if (pauseRequested) return false;
      const error = findFlowError({ baselineFailureCount });
      if (error) throw new Error(error);

      const progressCards = findGenerationProgressCards(expectedPrompt);
      if (additionalStartSignal?.()) return true;
      const liveInput = input instanceof HTMLElement && document.contains(input) ? input : findPromptInput();
      const currentSubmitButton = findSubmitControl(liveInput);
      if (hasBusySignal(progressCards) || (currentSubmitButton && !submitControlIsEnabled(currentSubmitButton))) return true;

      // Flow can ignore one trusted click while leaving its submit control
      // enabled. Verify that a request actually started, then retry exactly
      // once instead of waiting through the full generation timeout.
      if (!retrySubmitted && Date.now() - startedAt >= 8_000) {
        const currentInput = input instanceof HTMLElement && document.contains(input) ? input : findPromptInput();
        const currentButton = findSubmitControl(currentInput);
        if (submitControlIsEnabled(currentButton)) {
          retrySubmitted = true;
          await onRetry?.(currentButton);
          await retrySubmit(currentButton);
          continue;
        }
      }
      await sleep(400);
    }

    throw new Error(failureMessage);
  }

  async function monitorGeneration({ jobId, expectedImages, expectedPrompt, timeoutMs, baselineMedia, baselineSignals, baselineFailureCount = 0 }) {
    const startedAt = Date.now();
    let seenBusy = false;
    let busyStoppedAt = null;
    let assetsStableAt = null;
    let lastDetectedCount = 0;
    let lastProgressSentAt = 0;
    let lastProgressSignature = "";

    while (Date.now() - startedAt < timeoutMs) {
      if (pauseRequested) {
        return { paused: true, imagesGenerated: 0, assets: [] };
      }
      const elapsed = Date.now() - startedAt;
      const progressCards = findGenerationProgressCards(expectedPrompt).slice(0, expectedImages);
      const generationPercentages = progressCards.map((card) => card.percentage);
      const busy = hasBusySignal(progressCards);
      seenBusy ||= busy;
      if (seenBusy && !busy) busyStoppedAt ||= Date.now();
      if (busy) busyStoppedAt = null;

      const error = findFlowError({ baselineFailureCount });
      if (error) throw new Error(error);

      const currentMediaAssets = captureLargeMediaAssets({ includeOffscreen: true });
      const resultAssets = newDownloadableAssets(currentMediaAssets, baselineMedia);
      const detectedImages = resultAssets.length;
      if (detectedImages !== lastDetectedCount) {
        lastDetectedCount = detectedImages;
        assetsStableAt = detectedImages > 0 ? Date.now() : null;
      } else if (detectedImages > 0 && !assetsStableAt) {
        assetsStableAt = Date.now();
      }

      const currentSignals = captureCompletionSignals();
      const hasNewCompletionText = Array.from(currentSignals).some((item) => !baselineSignals.has(item));

      if (detectedImages >= expectedImages && assetsStableAt && !busy && Date.now() - assetsStableAt >= 4_000) {
        return {
          imagesGenerated: detectedImages,
          assets: resultAssets
        };
      }

      if (hasNewCompletionText && detectedImages >= expectedImages && !busy && elapsed >= 15_000) {
        return {
          imagesGenerated: detectedImages,
          assets: resultAssets
        };
      }

      if (seenBusy && busyStoppedAt && Date.now() - busyStoppedAt >= 12_000 && elapsed >= 30_000) {
        if (detectedImages > 0 && assetsStableAt && Date.now() - assetsStableAt >= 4_000) {
          return {
            imagesGenerated: detectedImages,
            assets: resultAssets
          };
        }
        throw new Error(`Flow 생성이 끝났지만 다운로드 가능한 결과 이미지 ${expectedImages}장을 확인하지 못했습니다.`);
      }

      const assetSignature = resultAssets.map((asset) => asset.assetId || asset.detailUrl || asset.url).join(",");
      const progressSignature = `${generationPercentages.join(",")}|${detectedImages}|${assetSignature}`;
      if (progressSignature !== lastProgressSignature || Date.now() - lastProgressSentAt >= 5_000) {
        const timeProgress = Math.min(88, 25 + Math.round((elapsed / timeoutMs) * 65));
        const flowProgress = generationPercentages.length ? Math.min(...generationPercentages) : null;
        const progressLabel = generationPercentages.length
          ? generationPercentages.map((percentage, index) => `이미지 ${index + 1} ${percentage}%`).join(" · ")
          : "";
        emit({
          type: "FLOW_JOB_PROGRESS",
          jobId,
          phase: "generating",
          stage: progressLabel || (detectedImages > 0 ? `결과 확인 중 · ${detectedImages}/${expectedImages}장 감지` : "Flow 생성 응답 대기 중"),
          progress: flowProgress == null ? timeProgress : Math.max(25, Math.min(94, flowProgress)),
          detectedImages,
          generationPercentages,
          assets: resultAssets
        });
        lastProgressSentAt = Date.now();
        lastProgressSignature = progressSignature;
      }

      await sleep(1_000);
    }

    throw new Error("10분 안에 이미지 생성 완료를 확인하지 못했습니다. Flow 결과를 확인한 뒤 재시도해 주세요.");
  }

  function findCharacterCreatorInput() {
    const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((element) => element instanceof HTMLElement && visible(element));
    return candidates.find((element) => {
      const placeholder = element.querySelector('[data-slate-placeholder="true"]')?.textContent
        || element.getAttribute("aria-label")
        || element.getAttribute("placeholder")
        || element.textContent
        || "";
      return /캐릭터.*설명|describe.*character/i.test(placeholder);
    }) || null;
  }

  function findCharacterNavigationButton() {
    const directNavigationItem = findDirectProjectNavigationItem("캐릭터");
    if (directNavigationItem) return directNavigationItem;
    return Array.from(document.querySelectorAll('button, [role="button"], a')).find((control) => {
      if (!visible(control)) return false;
      const text = String(control.textContent || "").replace(/\s+/g, "").toLowerCase();
      const label = String(control.getAttribute("aria-label") || "").replace(/\s+/g, "").toLowerCase();
      return (text.includes("accessibility_new") || /캐릭터|character/.test(label)) && /캐릭터|character/.test(`${text}${label}`);
    }) || null;
  }

  function findNewCharacterButton() {
    const semanticControl = Array.from(document.querySelectorAll('button, [role="button"], a')).find((control) => {
      if (!visible(control)) return false;
      const text = normalize(control.textContent || control.getAttribute("aria-label"));
      return text === normalize("신규 캐릭터") || text === "newcharacter";
    });
    if (semanticControl) return semanticControl;

    const label = Array.from(document.querySelectorAll("span, p, div")).find((element) => {
      if (!visible(element)) return false;
      const text = normalize(element.textContent);
      return text === normalize("신규 캐릭터") || text === "newcharacter";
    });
    if (!label) return null;

    let clickable = getComputedStyle(label).cursor === "pointer" ? label : null;
    let node = label.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      if (!visible(node) || getComputedStyle(node).cursor !== "pointer") break;
      clickable = node;
    }
    return clickable;
  }

  function findCharacterModelButton() {
    return Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'))
      .find((button) => {
        if (!visible(button)) return false;
        const text = String(button.textContent || "");
        return /banana/i.test(text) && !/crop[_\s:]?16[_\s:]?9|16\s*:\s*9|\bx[1-4]\b/i.test(text);
      }) || null;
  }

  function findFlowBackButton() {
    return Array.from(document.querySelectorAll('button, [role="button"], a')).find((control) => {
      if (!visible(control)) return false;
      const text = String(control.textContent || "").replace(/\s+/g, "").toLowerCase();
      const label = String(control.getAttribute("aria-label") || "").replace(/\s+/g, "").toLowerCase();
      return text.includes("arrow_back") || /뒤로|back/.test(label);
    }) || null;
  }

  function characterCreatorControls() {
    const input = findCharacterCreatorInput();
    if (!input) return null;
    const modelButton = findCharacterModelButton();
    const submitButton = findCharacterSubmitButton(input);
    return modelButton && submitButton ? { input, modelButton, submitButton } : null;
  }

  async function enterCharacterCreator() {
    const alreadyOpen = characterCreatorControls();
    if (alreadyOpen) return alreadyOpen;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const creatorInput = findCharacterCreatorInput();
      if (creatorInput) {
        return waitFor(characterCreatorControls, {
          timeoutMs: 20_000,
          intervalMs: 200,
          error: "신규 캐릭터 화면은 열렸지만 입력란·모델·만들기 버튼 준비를 확인하지 못했습니다."
        });
      }

      let destinationPredicate;
      const newCharacterButton = findNewCharacterButton();
      if (newCharacterButton) {
        await clickTrusted(newCharacterButton, { settleMs: NAVIGATION_SETTLE_MS });
        destinationPredicate = () => characterCreatorControls() || findCharacterCreatorInput();
      } else {
        const navigationButton = findCharacterNavigationButton();
        if (navigationButton) {
          await clickTrusted(navigationButton, { settleMs: NAVIGATION_SETTLE_MS });
          destinationPredicate = () => characterCreatorControls() || findCharacterCreatorInput() || findNewCharacterButton();
        } else {
          if (isDirectFlowProjectWorkspace()) break;
          const backButton = findFlowBackButton();
          if (!backButton) break;
          await clickTrusted(backButton, { settleMs: NAVIGATION_SETTLE_MS });
          destinationPredicate = () => characterCreatorControls() || findCharacterCreatorInput() || findNewCharacterButton() || findCharacterNavigationButton();
        }
      }

      try {
        const destination = await waitFor(
          destinationPredicate,
          {
            timeoutMs: 12_000,
            intervalMs: 200,
            error: "Flow 캐릭터 메뉴로 이동하는 중입니다."
          }
        );
        if (destination?.input) return destination;
      } catch {
        // Flow has nested SPA screens; the next pass can use the newly visible controls.
      }
    }

    throw new Error("현재 Flow 위치에서 캐릭터 메뉴를 찾지 못했습니다. 프로젝트 화면을 연 뒤 다시 시도해 주세요.");
  }

  async function enterDirectMediaWorkspace() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const allMediaButton = findAllMediaNavigationButton();
      if (allMediaButton) {
        if (!navigationItemSelected(allMediaButton)) {
          await clickTrusted(allMediaButton, { settleMs: NAVIGATION_SETTLE_MS });
        }

        const conversationCloseButton = findAgentConversationCloseButton();
        if (conversationCloseButton) {
          await clickTrusted(conversationCloseButton, { settleMs: NAVIGATION_SETTLE_MS });
        }

        const agentButton = await waitFor(findAgentModeButton, {
          timeoutMs: 15_000,
          intervalMs: 200,
          error: "Flow 모든 미디어의 일반 생성 입력창을 준비하지 못했습니다."
        });
        if (agentModeEnabled(agentButton)) {
          await clickTrusted(agentButton, { settleMs: NAVIGATION_SETTLE_MS });
          await waitFor(() => !agentModeEnabled(findAgentModeButton()) && findDirectSettingsButton(), {
            timeoutMs: 10_000,
            intervalMs: 150,
            error: "Flow 에이전트 모드를 끄지 못했습니다."
          });
        }

        return waitFor(findDirectPromptInput, {
          timeoutMs: 15_000,
          intervalMs: 200,
          error: "Flow 모든 미디어의 일반 프롬프트 입력창을 찾지 못했습니다."
        });
      }
      if (isDirectFlowProjectWorkspace()) break;
      const backButton = findFlowBackButton();
      if (!backButton) break;
      await clickTrusted(backButton, { settleMs: NAVIGATION_SETTLE_MS });
      try {
        await waitFor(() => findAllMediaNavigationButton() || findCharacterNavigationButton() || findNewCharacterButton(), {
          timeoutMs: 10_000,
          error: "Flow 모든 미디어 메뉴가 있는 프로젝트 화면으로 돌아오는 중입니다."
        });
      } catch {
        // Try one more visible back action when Flow has nested character screens.
      }
    }
    throw new Error("일반 이미지 생성을 시작할 Flow 왼쪽 메뉴의 '모든 미디어' 항목을 찾지 못했습니다.");
  }

  async function ensureCharacterModel(requestedModel) {
    const model = requestedFlowModel(requestedModel);
    const modelButton = await waitFor(findCharacterModelButton, {
      timeoutMs: 20_000,
      intervalMs: 200,
      error: "캐릭터 생성 모델 선택 버튼을 찾지 못했습니다. 신규 캐릭터 화면이 완전히 열린 뒤 재시도해 주세요."
    });
    if (isExactFlowModel(modelButton.textContent, model)) return;
    await clickTrusted(modelButton, { settleMs: NAVIGATION_SETTLE_MS });
    const menuItem = await waitFor(
      () => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .find((item) => visible(item) && isExactFlowModel(item.textContent, model)),
      { error: `캐릭터 생성에서 ${model} 모델을 찾지 못했습니다.` }
    );
    await clickTrusted(menuItem);
    await waitFor(() => isExactFlowModel(modelButton.textContent, model), {
      error: `캐릭터 생성 모델을 ${model}(으)로 바꾸지 못했습니다.`
    });
  }

  function controlDescriptor(control) {
    const id = control.id;
    const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent : "";
    return `${label || ""} ${control.getAttribute("aria-label") || ""} ${control.getAttribute("placeholder") || ""} ${control.getAttribute("name") || ""}`.trim();
  }

  function findCharacterNameControl() {
    const controls = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, [contenteditable="true"]'))
      .filter((element) => element instanceof HTMLElement && visible(element));
    const named = controls.find((control) => /캐릭터\s*이름|character\s*name|(?:^|\s)(?:이름|name)(?:\s|$)/i.test(controlDescriptor(control)));
    if (named) return named;
    const nativeTextControls = controls.filter((control) => control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement);
    return nativeTextControls.length === 1 && !findCharacterCreatorInput() ? nativeTextControls[0] : null;
  }

  function characterTileLabels(tile) {
    if (!(tile instanceof HTMLElement)) return [];
    const labels = [
      tile.getAttribute("aria-label"),
      tile.querySelector(".character-tile-name")?.textContent
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return labels.length ? labels : [String(tile.textContent || "").trim()];
  }

  function normalizedCharacterTileLabel(value) {
    return normalize(value).replace(/^@/, "");
  }

  function characterTileThumbnail(tile) {
    return tile?.querySelector?.("img.character-tile-thumbnail, img[alt*='캐릭터'], img") || null;
  }

  function findLatestUnnamedCharacterTile(baselineMedia = null) {
    const unnamedLabels = new Set([
      normalizedCharacterTileLabel("제목 없는 캐릭터"),
      normalizedCharacterTileLabel("Untitled character")
    ]);
    const candidates = Array.from(document.querySelectorAll("flow-grid-tile-container"))
      .filter((tile) => visible(tile) && characterTileLabels(tile).some((label) => unnamedLabels.has(normalizedCharacterTileLabel(label))));
    if (!candidates.length) return null;

    // Flow inserts the newest project card first. Prefer a thumbnail that was
    // not present in the pre-generation media boundary when one is available.
    if (baselineMedia instanceof Set && baselineMedia.size) {
      const fresh = candidates.find((tile) => {
        const image = characterTileThumbnail(tile);
        return image && !baselineMedia.has(mediaFingerprint(image, 0));
      });
      if (fresh) return fresh;
    }
    return candidates[0];
  }

  function findRegisteredCharacterImage(key) {
    const target = normalize(key).replace(/^@/, "");
    const image = Array.from(document.querySelectorAll("img")).find((image) => {
      if (!visible(image)) return false;
      const rect = image.getBoundingClientRect();
      const label = normalize(image.getAttribute("alt") || image.getAttribute("aria-label") || "").replace(/^@/, "");
      const hasImageSize = rect.width >= 80 && rect.height >= 80
        || image.naturalWidth >= 80 && image.naturalHeight >= 80
        || document.visibilityState === "hidden";
      return label === target && hasImageSize;
    });
    if (image) return image;

    const tile = Array.from(document.querySelectorAll("flow-grid-tile-container, flow-character-tile"))
      .find((candidate) => {
        if (!visible(candidate)) return false;
        return characterTileLabels(candidate).some((label) => {
          const normalized = normalizedCharacterTileLabel(label);
          return normalized === target || normalized.includes(`@${target}`);
        });
      });
    if (tile) return characterTileThumbnail(tile) || tile;

    return Array.from(document.querySelectorAll('a[href*="/character/"]')).find((link) => {
      if (!visible(link)) return false;
      const card = link.closest("button") || link.parentElement;
      const text = normalize(card?.textContent || link.textContent).replace(/^@/, "");
      return text.includes(target);
    }) || null;
  }

  function registeredCharacterAsset(key) {
    const match = findRegisteredCharacterImage(key);
    const image = match instanceof HTMLImageElement ? match : match?.querySelector?.("img");
    const rawUrl = String(image?.currentSrc || image?.src || "").trim();
    if (!/^https:\/\//i.test(rawUrl)) return null;
    const link = image.closest?.('a[href*="/character/"]') || match?.closest?.('a[href*="/character/"]');
    return {
      name: String(key || "").replace(/^@/, ""),
      url: rawUrl.replace(/([?&])mediaUrlType=[^&]+&?/i, (_whole, prefix) => prefix === "?" ? "" : "&").replace(/[?&]$/, ""),
      detailUrl: String(link?.href || ""),
      assetId: assetIdFromDetailUrl(link?.href)
    };
  }

  function characterKeyFromLabel(value) {
    const key = String(value || "").trim().replace(/^@/, "");
    return /^[A-Za-z][\w-]*$/.test(key) ? key : "";
  }

  function discoverRegisteredCharacterKeys() {
    const keys = new Set();
    for (const image of Array.from(document.querySelectorAll("img"))) {
      if (!visible(image)) continue;
      const rect = image.getBoundingClientRect();
      const hasImageSize = rect.width >= 80 && rect.height >= 80
        || image.naturalWidth >= 80 && image.naturalHeight >= 80
        || document.visibilityState === "hidden";
      if (!hasImageSize) continue;
      const key = characterKeyFromLabel(image.getAttribute("alt") || image.getAttribute("aria-label"));
      if (key) keys.add(key);
    }
    for (const link of Array.from(document.querySelectorAll('a[href*="/character/"]'))) {
      if (!visible(link)) continue;
      const labels = [link.getAttribute("aria-label"), link.textContent, link.querySelector("img")?.getAttribute("alt")];
      for (const label of labels) {
        const direct = characterKeyFromLabel(label);
        if (direct) keys.add(direct);
        for (const match of String(label || "").matchAll(/@([A-Za-z][\w-]*)/g)) keys.add(match[1]);
      }
    }
    for (const tile of Array.from(document.querySelectorAll("flow-grid-tile-container, flow-character-tile"))) {
      if (!visible(tile)) continue;
      const labels = characterTileLabels(tile);
      for (const label of labels) {
        const direct = characterKeyFromLabel(label);
        if (direct) keys.add(direct);
        for (const match of String(label || "").matchAll(/@([A-Za-z][\w-]*)/g)) keys.add(match[1]);
      }
    }
    return [...keys];
  }

  function detectFlowSurface() {
    if (findCharacterCreatorInput()) return "character-creator";
    if (findNewCharacterButton()) return "character-library";
    if (findAllMediaNavigationButton() || findCharacterNavigationButton()) return "project-workspace";
    return "unknown";
  }

  function characterEditorHasUserText(input) {
    const slateText = Array.from(input.querySelectorAll('[data-slate-string="true"]'))
      .map((element) => element.textContent || "")
      .join("")
      .trim();
    const editors = new Set([
      ...(input.classList.contains("ProseMirror") ? [input] : []),
      ...input.querySelectorAll(".ProseMirror")
    ]);
    const proseMirrorText = [...editors].map((editor) => {
      const clone = editor.cloneNode(true);
      clone.querySelectorAll(".prosemirror-placeholder, .ProseMirror-separator, br.ProseMirror-trailingBreak")
        .forEach((element) => element.remove());
      return clone.textContent || "";
    }).join("").trim();
    return Boolean(slateText || proseMirrorText);
  }

  function emptyCharacterScanResult(surface = "character-creator") {
    return {
      ready: true,
      inProgress: false,
      surface,
      registeredKeys: [],
      characterAssets: []
    };
  }

  async function scanFlowCharacters(characterKeys) {
    const keys = Array.from(new Set((characterKeys || []).map(String).filter(Boolean)));
    if (hasBusySignal()) {
      return { ready: true, inProgress: true, surface: detectFlowSurface(), registeredKeys: [] };
    }

    const creatorInput = findCharacterCreatorInput();
    if (creatorInput && characterEditorHasUserText(creatorInput)) {
      return { ready: true, inProgress: true, surface: "character-creator", registeredKeys: [] };
    }

    if (creatorInput) {
      const backButton = findFlowBackButton();
      if (backButton) {
        await clickTrusted(backButton, { settleMs: NAVIGATION_SETTLE_MS });
        await waitFor(() => findNewCharacterButton() || findCharacterNavigationButton(), {
          timeoutMs: 15_000,
          intervalMs: 250,
          error: "Flow 캐릭터 목록으로 돌아오지 못했습니다."
        });
      }
    }

    if (!findNewCharacterButton()) {
      const navigationButton = findCharacterNavigationButton();
      if (navigationButton) {
        await clickTrusted(navigationButton, { settleMs: NAVIGATION_SETTLE_MS });
        await waitFor(() => findNewCharacterButton() || findCharacterCreatorInput(), {
          timeoutMs: 15_000,
          intervalMs: 250,
          error: "Flow 캐릭터 메뉴를 열지 못했습니다."
        });

        // An empty Flow project opens the creator directly because there is no
        // character library yet. This is a valid zero-character scan and also
        // leaves the first creation form ready for runCharacter().
        if (findCharacterCreatorInput() && !findNewCharacterButton()) {
          return emptyCharacterScanResult();
        }
      }
    }

    if (findCharacterCreatorInput() && !findNewCharacterButton()) {
      const backButton = findFlowBackButton();
      if (backButton) {
        await clickTrusted(backButton, { settleMs: NAVIGATION_SETTLE_MS });
        await waitFor(() => findNewCharacterButton() || findCharacterNavigationButton(), {
          timeoutMs: 15_000,
          intervalMs: 250,
          error: "Flow 캐릭터 목록을 표시하지 못했습니다."
        });
        // When the creator was the empty project's only character surface,
        // Back returns to the project workspace instead of a library page.
        if (!findNewCharacterButton() && findCharacterNavigationButton()) {
          return emptyCharacterScanResult("project-workspace");
        }
      }
    }

    const registeredKeys = keys.filter((key) => Boolean(findRegisteredCharacterImage(key)));
    return {
      ready: true,
      inProgress: false,
      surface: detectFlowSurface(),
      registeredKeys,
      characterAssets: registeredKeys.map(registeredCharacterAsset).filter(Boolean)
    };
  }

  async function discoverFlowCharacters() {
    const scan = await scanFlowCharacters([]);
    if (scan.inProgress) return scan;
    const registeredKeys = discoverRegisteredCharacterKeys();
    return {
      ...scan,
      registeredKeys,
      characterAssets: registeredKeys.map(registeredCharacterAsset).filter(Boolean)
    };
  }

  async function setFormControlValue(control, value) {
    if (control.getAttribute("contenteditable") === "true") {
      await setPrompt(control, value);
      return;
    }
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(control, value);
    else control.value = value;
    control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findExactActionButton(labels) {
    const targets = labels.map(normalize);
    return Array.from(document.querySelectorAll("button")).find((button) => {
      if (!visible(button)) return false;
      return targets.includes(normalize(button.textContent));
    }) || null;
  }

  function findCharacterRegistrationSurface() {
    if (!/\/character\/[^/?#]+(?:\/|$)/i.test(location.pathname)) return null;
    const nameControl = findCharacterNameControl();
    const doneButton = findExactActionButton(["완료", "Done"]);
    return nameControl && doneButton ? { nameControl, doneButton } : null;
  }

  async function finishCharacterRegistration(character, baselineMedia, timeoutMs) {
    const startedAt = Date.now();
    let lastProgressSentAt = 0;
    let continueClicked = false;
    let unnamedTileOpened = false;
    let detectedImages = 0;

    while (Date.now() - startedAt < timeoutMs) {
      if (pauseRequested) {
        return { completed: false, paused: true, referenceImages: detectedImages, assets: [] };
      }
      const error = findFlowError();
      if (error) throw new Error(error);

      const currentMedia = captureLargeMedia();
      detectedImages = Array.from(currentMedia).filter((item) => !baselineMedia.has(item)).length;
      if (findRegisteredCharacterImage(character.key)) {
        return {
          completed: true,
          referenceImages: Math.max(1, detectedImages),
          assets: [registeredCharacterAsset(character.key)].filter(Boolean)
        };
      }

      if (!unnamedTileOpened && isDirectFlowProjectWorkspace() && detectedImages > 0) {
        const unnamedTile = findLatestUnnamedCharacterTile(baselineMedia);
        if (unnamedTile) {
          unnamedTileOpened = true;
          const tileTarget = unnamedTile.querySelector("flow-character-tile") || unnamedTile;
          emit({
            type: "FLOW_CHARACTER_PROGRESS",
            characterId: character.id,
            phase: "generating",
            stage: "제목 없는 캐릭터 카드 열기 · 이름 등록 준비",
            progress: 90,
            detectedImages
          });
          try {
            await doubleClickTrusted(tileTarget, { settleMs: NAVIGATION_SETTLE_MS });
            await waitFor(findCharacterRegistrationSurface, {
              timeoutMs: 20_000,
              intervalMs: 250,
              error: "생성된 제목 없는 캐릭터의 상세 화면을 열지 못했습니다."
            });
            continue;
          } catch {
            // The card can still be rendering while the project list settles.
            // Allow the next poll to locate and open it again.
            unnamedTileOpened = false;
          }
        }
      }

      const nameControl = findCharacterNameControl();
      if (nameControl) {
        await setFormControlValue(nameControl, character.key);
        const doneButton = await waitFor(() => {
          const button = findExactActionButton(["완료", "Done"]);
          return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null;
        }, {
          timeoutMs: 15_000,
          error: `캐릭터 이름 '${character.key}'을 입력했지만 완료 버튼이 활성화되지 않았습니다.`
        });
        await clickTrusted(doneButton);
        try {
          await waitFor(() => !document.contains(nameControl) || !visible(nameControl), {
            timeoutMs: 20_000,
            error: "캐릭터 저장 완료 화면으로 전환되지 않았습니다."
          });
          const registered = await waitFor(() => registeredCharacterAsset(character.key), {
            timeoutMs: 20_000,
            intervalMs: 300,
            error: "저장된 캐릭터 카드의 다운로드 이미지를 아직 찾지 못했습니다."
          }).catch(() => null);
          return {
            completed: true,
            referenceImages: Math.max(1, detectedImages),
            assets: [registered].filter(Boolean)
          };
        } catch {
          return { completed: false, referenceImages: Math.max(1, detectedImages), assets: [] };
        }
      }

      const continueButton = detectedImages > 0 && !continueClicked
        ? findExactActionButton(["계속", "다음", "Continue", "Next"])
        : null;
      if (continueButton && !continueButton.disabled && continueButton.getAttribute("aria-disabled") !== "true") {
        await clickTrusted(continueButton);
        continueClicked = true;
      }

      if (detectedImages > 0 && Date.now() - startedAt >= 120_000) {
        return { completed: false, referenceImages: detectedImages, assets: [] };
      }

      if (Date.now() - lastProgressSentAt >= 5_000) {
        const elapsed = Date.now() - startedAt;
        emit({
          type: "FLOW_CHARACTER_PROGRESS",
          characterId: character.id,
          phase: "generating",
          stage: detectedImages > 0 ? `참조 이미지 ${detectedImages}장 생성 · 등록 화면 확인 중` : "캐릭터 참조 이미지 생성 중",
          progress: Math.min(88, 24 + Math.round((elapsed / timeoutMs) * 64)),
          detectedImages
        });
        lastProgressSentAt = Date.now();
      }
      await sleep(1_000);
    }

    return { completed: false, referenceImages: detectedImages, assets: [] };
  }

  async function reconcileCharacterAfterNavigation(character, options) {
    activeJobId = character.id;
    activeTaskType = "character";
    pauseRequested = false;

    try {
      const existingAsset = registeredCharacterAsset(character.key);
      const creatorInput = findCharacterCreatorInput();
      const idleCreator = creatorInput && !characterEditorHasUserText(creatorInput) && !hasBusySignal();
      const characterLibrary = findNewCharacterButton() && !hasBusySignal();
      if (!existingAsset && (idleCreator || characterLibrary)) {
        emit({
          type: "FLOW_CHARACTER_PAUSED",
          characterId: character.id,
          stage: "Flow 캐릭터 미등록 · 다시 생성 대기"
        });
        return;
      }
      emit({
        type: "FLOW_CHARACTER_PROGRESS",
        characterId: character.id,
        phase: "generating",
        stage: `@${character.key} 화면 전환 후 등록 상태 확인 중`,
        progress: 35
      });
      const result = await finishCharacterRegistration(
        character,
        new Set(),
        Math.min(5 * 60_000, Number(options.generationTimeoutMs || 5 * 60_000))
      );
      if (result.paused) {
        emit({ type: "FLOW_CHARACTER_PAUSED", characterId: character.id, stage: "캐릭터 생성 중단 · 다시 생성 대기" });
      } else if (result.completed) {
        emit({
          type: "FLOW_CHARACTER_COMPLETED",
          characterId: character.id,
          referenceImages: result.referenceImages,
          assets: result.assets
        });
      } else {
        emit({ type: "FLOW_CHARACTER_NEEDS_REVIEW", characterId: character.id, referenceImages: result.referenceImages });
      }
    } catch (error) {
      emit({ type: "FLOW_CHARACTER_FAILED", characterId: character.id, error: String(error?.message || error) });
    } finally {
      activeJobId = null;
      activeTaskType = null;
      pauseRequested = false;
    }
  }

  async function reconcileSceneAfterNavigation(job, options) {
    activeJobId = job.id;
    activeTaskType = "scene";
    pauseRequested = false;

    let restartConfiguration = false;
    try {
      await emitReliable({
        type: "FLOW_JOB_PROGRESS",
        jobId: job.id,
        phase: job.requestSubmittedAt ? "generating" : "configuring",
        stage: "Flow 화면 재연결 · 현재 생성 상태 확인 중",
        progress: Math.max(job.requestSubmittedAt ? 28 : 18, Number(job.progress || 0)),
        generationMode: "direct"
      });

      const recoveryBaseline = new Set(Array.isArray(job.baselineMedia) ? job.baselineMedia : []);
      // A submit timestamp without its accompanying media snapshot cannot
      // identify which existing cards belong to this request. Treat the
      // current gallery as the boundary in that case instead of attaching the
      // newest unrelated cards to the recovering scene.
      const hasStoredBaseline = Boolean(job.baselineCapturedAt) && recoveryBaseline.size > 0;
      const progressCardsBeforeWorkspace = findGenerationProgressCards(job.prompt);
      const busyBeforeWorkspace = hasBusySignal(progressCardsBeforeWorkspace);
      await enterDirectMediaWorkspace();
      const currentMedia = captureLargeMedia();
      const detectedSinceBaseline = hasStoredBaseline
        ? Array.from(currentMedia).filter((item) => !recoveryBaseline.has(item)).length
        : 0;
      const progressCardsAfterWorkspace = findGenerationProgressCards(job.prompt);
      const generationVisible = busyBeforeWorkspace
        || hasBusySignal(progressCardsAfterWorkspace)
        || (hasStoredBaseline && detectedSinceBaseline > 0);

      if (!job.requestSubmittedAt && !generationVisible) {
        restartConfiguration = true;
        await emitReliable({
          type: "FLOW_JOB_PROGRESS",
          jobId: job.id,
          phase: "configuring",
          stage: "제출 전 화면 전환 확인 · 동일 장면 설정 재개",
          progress: 10,
          generationMode: "direct",
          baselineMedia: Array.from(currentMedia),
          baselineCapturedAt: Date.now()
        });
      } else {
        const baselineMedia = hasStoredBaseline ? recoveryBaseline : currentMedia;
        const generationResult = await monitorGeneration({
          jobId: job.id,
          expectedImages: Number(options.imagesPerPrompt || 2),
          expectedPrompt: job.prompt,
          timeoutMs: Number(options.generationTimeoutMs || 10 * 60_000),
          baselineMedia,
          baselineSignals: new Set(),
          baselineFailureCount: Number.isInteger(job.baselineFailureCount) ? job.baselineFailureCount : 0
        });
        if (generationResult.paused) {
          emit({ type: "FLOW_JOB_PAUSED", jobId: job.id });
          return;
        }
        emit({
          type: "FLOW_JOB_COMPLETED",
          jobId: job.id,
          imagesGenerated: generationResult.imagesGenerated,
          assets: generationResult.assets
        });
      }
    } catch (error) {
      emit({ type: "FLOW_JOB_FAILED", jobId: job.id, error: String(error?.message || error) });
    } finally {
      activeJobId = null;
      activeTaskType = null;
      pauseRequested = false;
    }

    if (restartConfiguration) await runJob(job, options);
  }

  function emitCharacterRegistrationResult(character, result) {
    if (result.paused) {
      emit({ type: "FLOW_CHARACTER_PAUSED", characterId: character.id, stage: "캐릭터 생성 중단 · 다시 생성 대기" });
    } else if (result.completed) {
      emit({
        type: "FLOW_CHARACTER_COMPLETED",
        characterId: character.id,
        referenceImages: result.referenceImages,
        assets: result.assets
      });
    } else {
      emit({ type: "FLOW_CHARACTER_NEEDS_REVIEW", characterId: character.id, referenceImages: result.referenceImages });
    }
  }

  async function runCharacter(character, options) {
    activeJobId = character.id;
    activeTaskType = "character";
    pauseRequested = false;

    try {
      if (findCharacterRegistrationSurface()) {
        emit({
          type: "FLOW_CHARACTER_PROGRESS",
          characterId: character.id,
          phase: "generating",
          stage: "생성된 캐릭터 상세 화면 복구 · 이름 저장 중",
          progress: 35
        });
        const recoveredResult = await finishCharacterRegistration(
          character,
          new Set(),
          Math.min(5 * 60_000, Number(options.generationTimeoutMs || 5 * 60_000))
        );
        emitCharacterRegistrationResult(character, recoveredResult);
        return;
      }

      emit({
        type: "FLOW_CHARACTER_PROGRESS",
        characterId: character.id,
        phase: "configuring",
        stage: `@${character.key} 캐릭터 생성 화면 준비 중`,
        progress: 10
      });
      const { input } = await enterCharacterCreator();
      await ensureCharacterModel(options.model);
      await setPrompt(input, character.prompt);
      emit({
        type: "FLOW_CHARACTER_PROGRESS",
        characterId: character.id,
        phase: "configuring",
        stage: "캐릭터 프롬프트 입력 완료",
        progress: 18
      });

      let submitButton = await waitFor(() => {
        const button = findCharacterSubmitButton(input);
        return submitControlIsEnabled(button) ? button : null;
      }, {
        timeoutMs: 15_000,
        error: "Flow 캐릭터 만들기 버튼이 활성화되지 않았습니다."
      });

      if (pauseRequested) {
        emit({ type: "FLOW_CHARACTER_PAUSED", characterId: character.id });
        return;
      }

      const baselineMedia = captureLargeMedia();
      const baselineFailureCount = captureGenerationFailureCards().length;
      const refreshedSubmitButton = findCharacterSubmitButton(input);
      if (submitControlIsEnabled(refreshedSubmitButton)) submitButton = refreshedSubmitButton;
      await clickCharacterSubmit(submitButton);
      await emitReliable({
        type: "FLOW_CHARACTER_PROGRESS",
        characterId: character.id,
        phase: "generating",
        stage: "캐릭터 생성 요청 접수 확인 중",
        progress: 24,
        submissionDiagnostic: submissionDiagnostic(submitButton, "button.click 직접 전송")
      });
      await confirmGenerationStarted({
        input,
        expectedPrompt: character.prompt,
        baselineFailureCount,
        findSubmitControl: findCharacterSubmitButton,
        retrySubmit: clickTrusted,
        additionalStartSignal: findCharacterRegistrationSurface,
        failureMessage: "Flow 캐릭터 만들기 버튼을 찾았지만 생성 요청이 시작되지 않았습니다. button.click 직접 실행 후 같은 버튼에 실제 좌표 클릭까지 재시도했으나 생성 신호를 확인하지 못했습니다.",
        onRetry: async (currentButton) => emitReliable({
          type: "FLOW_CHARACTER_PROGRESS",
          characterId: character.id,
          phase: "generating",
          stage: "생성 시작 신호 없음 · 같은 만들기 버튼 실제 좌표 클릭 재시도",
          progress: 24,
          submissionDiagnostic: submissionDiagnostic(currentButton, "만들기 버튼 좌표 클릭 재시도")
        })
      });

      const result = await finishCharacterRegistration(
        character,
        baselineMedia,
        Number(options.generationTimeoutMs || 10 * 60_000)
      );
      emitCharacterRegistrationResult(character, result);
    } catch (error) {
      emit({ type: "FLOW_CHARACTER_FAILED", characterId: character.id, error: String(error?.message || error) });
    } finally {
      activeJobId = null;
      activeTaskType = null;
      pauseRequested = false;
    }
  }

  async function runJob(job, options) {
    activeJobId = job.id;
    activeTaskType = "scene";
    pauseRequested = false;

    try {
      emit({ type: "FLOW_JOB_PROGRESS", jobId: job.id, phase: "configuring", stage: "모든 미디어 · 에이전트 끄기", progress: 8, generationMode: "direct" });
      let input = await enterDirectMediaWorkspace();
      const workspaceBaselineMedia = captureLargeMedia();
      const baselineCapturedAt = Date.now();
      await emitReliable({
        type: "FLOW_JOB_PROGRESS",
        jobId: job.id,
        phase: "configuring",
        stage: `일반 생성 · ${requestedFlowModel(options.model)} · ${requestedFlowAspectRatio(options.aspectRatio)} · ${requestedFlowImageCount(options.imagesPerPrompt)}장 확인 중`,
        progress: 12,
        generationMode: "direct",
        baselineMedia: Array.from(workspaceBaselineMedia),
        baselineCapturedAt
      });
      input = await ensureDirectImageSettings(input, options.model, options.aspectRatio, options.imagesPerPrompt);

      if (pauseRequested) {
        emit({ type: "FLOW_JOB_PAUSED", jobId: job.id });
        return;
      }

      await setPromptWithCharacterReferences(input, job.prompt, job.characterRefs || []);
      await emitReliable({
        type: "FLOW_JOB_PROGRESS",
        jobId: job.id,
        phase: "configuring",
        stage: (job.characterRefs || []).length ? `일반 생성 참조 연결 · ${(job.characterRefs || []).map((key) => `@${key}`).join(" + ")}` : "일반 생성 프롬프트 입력 완료",
        progress: 18,
        generationMode: "direct"
      });

      let submitButton = await waitFor(() => {
        const button = findSubmitButton(input);
        return submitControlIsEnabled(button) ? button : null;
      }, {
        timeoutMs: 15_000,
        error: "Flow 만들기 버튼이 활성화되지 않았습니다."
      });

      if (pauseRequested) {
        emit({ type: "FLOW_JOB_PAUSED", jobId: job.id });
        return;
      }

      // Let Flow finish lazy-loading the existing gallery before the boundary
      // snapshot. Otherwise old cards that appeared a moment after entering
      // the workspace can look like the next request's newest results.
      await sleep(UI_SETTLE_MS);
      const baselineMedia = captureLargeMedia();
      const baselineSignals = captureCompletionSignals();
      const baselineFailureCount = captureGenerationFailureCards().length;
      const requestSubmittedAt = Date.now();
      const refreshedSubmitButton = findSubmitButton(input);
      if (submitControlIsEnabled(refreshedSubmitButton)) submitButton = refreshedSubmitButton;
      await emitReliable({
        type: "FLOW_JOB_PROGRESS",
        jobId: job.id,
        phase: "generating",
        stage: "모든 미디어에 일반 생성 요청 전송 중",
        progress: 22,
        generationMode: "direct",
        baselineMedia: Array.from(baselineMedia),
        baselineCapturedAt,
        baselineFailureCount,
        requestSubmittedAt
      });
      await clickTrusted(submitButton);
      await emitReliable({
        type: "FLOW_JOB_PROGRESS",
        jobId: job.id,
        phase: "generating",
        stage: "일반 생성 요청 접수 확인 중",
        progress: 24,
        generationMode: "direct",
        baselineFailureCount,
        requestSubmittedAt,
        submissionDiagnostic: submissionDiagnostic(submitButton, "좌표 클릭 전송")
      });
      await confirmGenerationStarted({
        input,
        expectedPrompt: job.prompt,
        baselineFailureCount,
        onRetry: async (currentButton) => emitReliable({
          type: "FLOW_JOB_PROGRESS",
          jobId: job.id,
          phase: "generating",
          stage: "생성 시작 신호 없음 · 키보드 전송 1회 재시도",
          progress: 24,
          generationMode: "direct",
          baselineFailureCount,
          requestSubmittedAt,
          submissionDiagnostic: submissionDiagnostic(currentButton, "키보드 Enter 재시도")
        })
      });

      const generationResult = await monitorGeneration({
        jobId: job.id,
        expectedImages: Number(options.imagesPerPrompt || 2),
        expectedPrompt: job.prompt,
        timeoutMs: Number(options.generationTimeoutMs || 10 * 60_000),
        baselineMedia,
        baselineSignals,
        baselineFailureCount
      });
      if (generationResult.paused) {
        emit({ type: "FLOW_JOB_PAUSED", jobId: job.id });
        return;
      }
      emit({
        type: "FLOW_JOB_COMPLETED",
        jobId: job.id,
        imagesGenerated: generationResult.imagesGenerated,
        assets: generationResult.assets
      });
    } catch (error) {
      emit({ type: "FLOW_JOB_FAILED", jobId: job.id, error: String(error?.message || error) });
    } finally {
      activeJobId = null;
      activeTaskType = null;
      pauseRequested = false;
    }
  }

  async function prepareManualScenePrompt(job, options) {
    activeJobId = job.id;
    activeTaskType = "manual";
    pauseRequested = false;

    try {
      let input = await enterDirectMediaWorkspace();
      input = await ensureDirectImageSettings(input, options.model, options.aspectRatio, options.imagesPerPrompt);
      await setPromptWithCharacterReferences(input, job.prompt, job.characterRefs || []);
      return { prepared: true };
    } finally {
      activeJobId = null;
      activeTaskType = null;
      pauseRequested = false;
    }
  }

  function currentProjectTitle() {
    const editableTitle = Array.from(document.querySelectorAll(
      'input[aria-label="수정 가능한 텍스트"], [contenteditable="true"][aria-label="수정 가능한 텍스트"]'
    ))
      .map((element) => String(element.value || element.textContent || "").trim())
      .find((value) => value && value.length < 120);
    if (editableTitle) return editableTitle;

    const title = String(document.title || "").replace(/^Google Flow\s*[-–—]\s*/i, "").trim();
    if (title && !/^Google Flow$/i.test(title)) return title;

    const fallbackTitle = Array.from(document.querySelectorAll("input, [contenteditable=\"true\"]"))
      .map((element) => String(element.value || element.textContent || "").trim())
      .find((value) => value && value.length < 120);
    return fallbackTitle || "Flow project";
  }

  function sceneMediaCardAssets() {
    return Array.from(document.querySelectorAll('a[href*="/edit/"]'))
      .map((link) => {
        const image = link.querySelector("img");
        const rawUrl = String(image?.currentSrc || image?.src || "").trim();
        const url = rawUrl.replace(/([?&])mediaUrlType=[^&]+&?/i, (_whole, prefix) => prefix === "?" ? "" : "&").replace(/[?&]$/, "");
        if (!/^https:\/\//i.test(url)) return null;
        return {
          url,
          detailUrl: String(link.href || ""),
          assetId: assetIdFromDetailUrl(link.href),
          width: Number(image?.naturalWidth || 0),
          height: Number(image?.naturalHeight || 0)
        };
      })
      .filter(Boolean);
  }

  function findMediaScrollContainer() {
    const firstCard = document.querySelector('a[href*="/edit/"]');
    for (let node = firstCard?.parentElement; node; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 100 && /auto|scroll/.test(style.overflowY)) return node;
    }
    return Array.from(document.querySelectorAll("body *"))
      .filter((element) => element instanceof HTMLElement
        && element.scrollHeight > element.clientHeight + 200
        && element.querySelector('a[href*="/edit/"]'))
      .sort((left, right) => right.scrollHeight - left.scrollHeight)[0]
      || document.scrollingElement;
  }

  async function scanAllSceneMediaAssets() {
    await enterDirectMediaWorkspace();
    await waitFor(() => document.querySelector('a[href*="/edit/"]'), {
      timeoutMs: 20_000,
      intervalMs: 250,
      error: "Flow 모든 미디어에서 다운로드할 이미지 카드를 찾지 못했습니다."
    });

    const container = findMediaScrollContainer();
    const originalTop = Number(container?.scrollTop || 0);
    const found = new Map();
    let stagnantPasses = 0;
    let previousSize = 0;

    try {
      if (container) {
        container.scrollTop = 0;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
        await sleep(180);
      }

      for (let pass = 0; pass < 140; pass += 1) {
        for (const asset of sceneMediaCardAssets()) {
          if (!found.has(asset.detailUrl || asset.url)) found.set(asset.detailUrl || asset.url, asset);
        }
        stagnantPasses = found.size === previousSize ? stagnantPasses + 1 : 0;
        previousSize = found.size;

        if (!container) break;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        if (container.scrollTop >= maxTop - 4 && stagnantPasses >= 4) break;
        const nextTop = Math.min(maxTop, container.scrollTop + Math.max(640, Math.round(container.clientHeight * 0.92)));
        if (nextTop === container.scrollTop) {
          stagnantPasses += 1;
        } else {
          container.scrollTop = nextTop;
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        await sleep(180);
      }
    } finally {
      if (container) {
        container.scrollTop = originalTop;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    }

    // Flow's All Media UI is newest-first. The queue uses oldest-first, and
    // this deliberately trusts the visual card sequence prepared by the user.
    return Array.from(found.values()).reverse();
  }

  async function scanFlowProjectAssets(characterKeys) {
    if (activeJobId || hasBusySignal()) {
      throw new Error("Flow 생성이 진행 중입니다. 현재 작업을 중단하거나 완료한 뒤 프로젝트를 다운로드해 주세요.");
    }
    const projectTitle = currentProjectTitle();
    const allMediaAssets = await scanAllSceneMediaAssets();
    const characterScan = await scanFlowCharacters(characterKeys || []);
    if (characterScan.inProgress) throw new Error("Flow 캐릭터 생성이 진행 중이라 다운로드 목록을 만들 수 없습니다.");
    await enterDirectMediaWorkspace();
    const characterUrls = new Set((characterScan.characterAssets || []).map((asset) => asset.url));
    const sceneAssets = allMediaAssets.filter((asset) => !characterUrls.has(asset.url));
    return {
      ready: true,
      projectTitle,
      sceneAssets,
      characterAssets: characterScan.characterAssets || [],
      allMediaCount: allMediaAssets.length,
      removedCharacterMediaCount: allMediaAssets.length - sceneAssets.length
    };
  }

  function diagnostics() {
    const input = findDirectPromptInput() || findPromptInput();
    const settingsButton = findDirectSettingsButton(findDirectPromptInput());
    const settingsSection = findDirectSettingsMenu();
    const generationProgressCards = findGenerationProgressCards();
    return {
      ready: Boolean(input || settingsSection),
      path: location.pathname,
      title: document.title,
      promptInputFound: Boolean(input),
      settingsButtonFound: Boolean(settingsButton),
      settingsOpen: Boolean(settingsSection),
      directPromptFound: Boolean(findDirectPromptInput()),
      agentModeEnabled: agentModeEnabled(),
      generationProgress: generationProgressCards.map((card) => card.percentage),
      characterCreatorOpen: Boolean(findCharacterCreatorInput()),
      activeJobId,
      activeTaskType
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING_FLOW_CONTENT") {
      sendResponse({ ready: true, pageSessionId });
      return false;
    }

    if (message?.type === "GET_FLOW_DIAGNOSTICS") {
      sendResponse(diagnostics());
      return false;
    }

    if (message?.type === "SCAN_FLOW_CHARACTERS") {
      void scanFlowCharacters(message.characterKeys || [])
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ready: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "DISCOVER_FLOW_CHARACTERS") {
      void discoverFlowCharacters()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ready: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "SCAN_FLOW_PROJECT_ASSETS") {
      void scanFlowProjectAssets(message.characterKeys || [])
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ready: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "RECONCILE_FLOW_CHARACTER") {
      if (activeJobId) {
        sendResponse({ accepted: false, error: "Flow 페이지에서 이미 다른 작업을 진행 중입니다." });
        return false;
      }
      sendResponse({ accepted: true });
      void reconcileCharacterAfterNavigation(message.character, message.options || {});
      return false;
    }

    if (message?.type === "RECONCILE_FLOW_JOB") {
      if (activeJobId) {
        sendResponse({ accepted: false, error: "Flow 페이지에서 이미 다른 작업을 진행 중입니다." });
        return false;
      }
      sendResponse({ accepted: true });
      void reconcileSceneAfterNavigation(message.job, message.options || {});
      return false;
    }

    if (message?.type === "RUN_FLOW_JOB") {
      if (activeJobId) {
        sendResponse({ accepted: false, error: "Flow 페이지에서 이미 다른 작업을 진행 중입니다." });
        return false;
      }
      sendResponse({ accepted: true });
      void runJob(message.job, message.options || {});
      return false;
    }

    if (message?.type === "PREPARE_MANUAL_SCENE_PROMPT") {
      if (activeJobId) {
        sendResponse({ accepted: false, error: "Flow 페이지에서 이미 다른 작업을 진행 중입니다." });
        return false;
      }
      void prepareManualScenePrompt(message.job, message.options || {})
        .then((result) => sendResponse({ accepted: true, ...result }))
        .catch((error) => sendResponse({ accepted: false, error: String(error?.message || error) }));
      return true;
    }

    if (message?.type === "RUN_FLOW_CHARACTER") {
      if (activeJobId) {
        sendResponse({ accepted: false, error: "Flow 페이지에서 이미 다른 작업을 진행 중입니다." });
        return false;
      }
      sendResponse({ accepted: true });
      void runCharacter(message.character, message.options || {});
      return false;
    }

    if (message?.type === "STOP_FLOW_TASK" || message?.type === "PAUSE_FLOW_TASK") {
      if (!message.taskId || message.taskId === activeJobId) pauseRequested = true;
      sendResponse({ accepted: true, activeJobId, activeTaskType });
      return false;
    }

    return false;
  });

  const initialFailureCards = captureGenerationFailureCards();
  emit({
    type: "FLOW_READY",
    pageSessionId,
    generationFailureCount: initialFailureCards.length,
    generationFailureMessage: generationFailureMessage(initialFailureCards)
  });
})();
