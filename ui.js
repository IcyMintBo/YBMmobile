// ui.js —— 外置手机界面（复古诺基亚）

import { DOM_IDS, PHONE_PREFIX, getContextSafe } from "./core.js";
import {
  pushUserMessage,
  pushCharMessage,
  resetHistory,
  getHistory,
  saveHistoryToMetadata,
  loadHistoryFromMetadata,
  pushPendingChunk,
  getPendingMessages,
  consumeAllPending,
  revokePendingById,
  deletePendingById,
  registerContactIdGetter,
  getHistoryTextsForContact,
  revokeLastCharMessage,
} from "./storage.js";
import { YBMPhoneContacts } from "./contacts.js";
import { callToolApi, renderApiSettingsScreen } from "./api.js";


const {
  PHONE_ID,
  BUTTON_ID,
  CHAT_LIST_ID,
  CHAT_INPUT_ID,
  CHAT_SEND_ID,
  CHAT_BUFFER_ID,
} = DOM_IDS;

const EXT_ID = "ybm_phone_ext";

let currentApp = "home"; // home | sms | memo | forum | bounty | api
let phoneScreenMode = "contacts"; // sms 下：contacts | chat

let phoneContacts = null;

// ===== 手机扩展设置 & 预设 / 世界书加载 =====
function getPhoneExtSettings() {
  const ctx = getContextSafe() || {};
  if (!ctx.extension_settings) {
    ctx.extension_settings = {};
  }
  if (!ctx.extension_settings[EXT_ID]) {
    ctx.extension_settings[EXT_ID] = {};
  }
  // 默认：启用手机预设，关闭世界书
  const st = ctx.extension_settings[EXT_ID];
  if (typeof st.usePhonePreset === "undefined") {
    st.usePhonePreset = true;
  }
  if (typeof st.usePhoneWorldbook === "undefined") {
    st.usePhoneWorldbook = true;
  }
  return {
    ctx,
    settings: st,
    save: () => {
      try {
        if (typeof ctx.saveSettingsDebounced === "function") {
          ctx.saveSettingsDebounced();
        } else if (typeof ctx.saveSettings === "function") {
          ctx.saveSettings();
        }
      } catch (e) {
        console.warn("[外置手机] 保存扩展设置失败：", e);
      }
    },
  };
}

let _phonePresetCache = null;
let _phoneWorldbookCache = null;

async function loadPhonePresetJson() {
  if (_phonePresetCache) return _phonePresetCache;
  try {
    const url = new URL("./phone-memo-preset.json", import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    _phonePresetCache = json || {};
    return _phonePresetCache;
  } catch (e) {
    console.warn("[外置手机] 读取 phone-memo-preset.json 失败：", e);
    _phonePresetCache = {};
    return _phonePresetCache;
  }
}

async function loadPhoneWorldbookJson() {
  if (_phoneWorldbookCache) return _phoneWorldbookCache;
  try {
    const url = new URL("./phone-worldbook.json", import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    _phoneWorldbookCache = json || {};
    return _phoneWorldbookCache;
  } catch (e) {
    console.warn("[外置手机] 读取 phone-worldbook.json 失败：", e);
    _phoneWorldbookCache = {};
    return _phoneWorldbookCache;
  }
}
// ===== 手机预设配置：从 JSON 初始化到 extension_settings，之后都走这里 =====

let _presetConfigInitPromise = null;

function createFallbackPresetItems() {
  // 如果没找到 phone-memo-preset.json，就用这一份兜底预设
  return [
    {
      id: "preset_header",
      label: "头部",
      enabled: true,
      order: 10,
      content:
        "【手机聊天总体原则】你正在通过一部老式手机和对方聊天。请把回复当作短信气泡，而不是旁白或说明书。"
    },
    {
      id: "preset_task",
      label: "手机任务说明",
      enabled: true,
      order: 20,
      content:
        "你要根据世界书和最近对话，真实扮演当前角色，维持《边水往事》的世界观与人际关系，不要跳出角色和玩家讲规则。"
    },
    {
      id: "preset_format",
      label: "手机内容结构",
      enabled: true,
      order: 30,
      content:
        "普通聊天时，每次回复建议 1~3 行，每一行是一个独立气泡；语言简短、自然，符合角色说话习惯。"
    },
    {
      id: "preset_style",
      label: "手机内容风格",
      enabled: true,
      order: 40,
      content:
        "注意抓住对方刚刚说过的重点和情绪，结合角色性格作出回应，可以适当含蓄、绕弯或直接，视角色而定。"
    },
    {
      id: "preset_draft",
      label: "草稿内容使用说明",
      enabled: true,
      order: 50,
      content:
        "如果系统说明中提到草稿或暂存内容，请优先参考那部分信息组织回复，但不要在对话中显式提及“草稿”二字。"
    }
  ];
}

function ensurePresetConfigInitialized() {
  if (_presetConfigInitPromise) return _presetConfigInitPromise;

  _presetConfigInitPromise = (async () => {
    const { settings, save } = getPhoneExtSettings();

    // 已有配置直接用
    if (
      settings.promptPreset &&
      Array.isArray(settings.promptPreset.items) &&
      settings.promptPreset.items.length
    ) {
      return settings.promptPreset;
    }

    let items = [];

    try {
      // 先从 phone-memo-preset.json 读预设
      const json = await loadPhonePresetJson();
      if (json && Array.isArray(json.items) && json.items.length) {
        items = json.items.map((it, idx) => ({
          id: it.id || `preset_${idx + 1}`,
          label: it.label || it.name || `条目${idx + 1}`,
          enabled:
            typeof it.enabled === "boolean" ? it.enabled : true,
          order:
            typeof it.order === "number" ? it.order : idx + 1,
          content: typeof it.content === "string" ? it.content : "",
        }));
      }
    } catch (e) {
      console.warn("[外置手机] 初始化手机预设配置失败：", e);
    }

    if (!items.length) {
      items = createFallbackPresetItems();
    }

    // 🔁 在这里把“世界书”塞成一个额外预设条目
    try {
      const world = await loadPhoneWorldbookJson(); // 读 phone-worldbook.json
      const wbText = buildWorldbookTextForPhone(world);
      if (wbText) {
        items.push({
          id: "worldbook_for_phone",
          label: "世界观设定（手机）",
          enabled: true,
          order: items.length + 1,
          content: wbText,
        });
      }
    } catch (e) {
      console.warn("[外置手机] 合并世界书到预设失败：", e);
    }

    settings.promptPreset = { items };
    save();
    return settings.promptPreset;
  })();

  return _presetConfigInitPromise;
}

function buildWorldbookTextForPhone(worldJson) {
  if (!worldJson || !Array.isArray(worldJson.entries)) return "";
  // 简单版：把所有 entry 的 comment + content 串起来
  const parts = [];
  for (const entry of worldJson.entries) {
    if (!entry) continue;
    const title = entry.comment || entry.name || "";
    const body = entry.content || "";
    if (!body) continue;
    if (title) {
      parts.push(`【${title}】\n${body}`);
    } else {
      parts.push(body);
    }
  }
  return parts.join("\n\n");
}

/**
 * 构建手机用的“前缀上下文”：
 * - 手机预设（按条目开关 / 顺序拼接）
 * - 世界书中与当前对话有关的信息（简单版：全部 entries）
 *
 * options: { mode: "sms" | "memo", charName?: string, contactName?: string }
 */
/**
 * 构建手机用的“前缀上下文”：
 * - 手机预设（只在查手机 / memo 模式下启用）
 * - 世界书（如果用户勾选的话）
 *
 * options: { mode: "sms" | "memo", charName?: string, contactName?: string }
 */
async function buildPhoneContextPrefix(options = {}) {
  const { settings } = getPhoneExtSettings();
  let blocks = [];

  const mode = options.mode || "sms";
  const activeCharName = (options.charName || "").trim();

  // 1. 手机预设：短信 + 查手机 都启用
  if (settings.usePhonePreset) {
    try {
      const preset = await loadPhonePresetJson();
      if (preset && Array.isArray(preset.items)) {
        const sorted = [...preset.items].sort((a, b) => {
          const oa = typeof a.order === "number" ? a.order : 0;
          const ob = typeof b.order === "number" ? b.order : 0;
          return oa - ob;
        });

        // 根据当前角色过滤：通用规则 / 世界观项不过滤，只有「角色 · XXX」才按 charName 过滤
        const filtered = sorted.filter((it) => {
          if (!it || typeof it.content !== "string") return false;

          const label = typeof it.label === "string" ? it.label : "";

          // 查手机模式：直接全量给（以后你真要拆也可以再细化）
          if (mode === "memo") return true;

          // 短信模式：带有“角色 · XXX”字样的，只保留当前角色对应的那一条
          if (mode === "sms" && label.includes("角色 · ")) {
            if (!activeCharName) return false;

            if (label.includes("岩白眉") && activeCharName !== "岩白眉") return false;
            if (label.includes("猜叔") && activeCharName !== "猜叔") return false;
            if (label.includes("但拓") && activeCharName !== "但拓") return false;
            if (label.includes("州槟") && activeCharName !== "州槟") return false;
          }

          // 其他没写 label 的、或只是通用规则/世界观的，都保留
          return true;
        });

        const texts = filtered
          .map((it) => it.content && it.content.trim && it.content.trim())
          .filter((t) => t);
        if (texts.length) {
          blocks.push(texts.join("\n\n"));
        }
      }
    } catch (e) {
      console.warn("[外置手机] 构建手机预设前缀失败：", e);
    }
  }

  // 2. 世界书（短信 & 查手机 都可以共用）
  if (settings.usePhoneWorldbook) {
    try {
      const world = await loadPhoneWorldbookJson();
      const wbText = buildWorldbookTextForPhone(world);
      if (wbText) {
        blocks.push(`【世界观与人物设定（手机可见部分）】\n${wbText}`);
      }
    } catch (e) {
      console.warn("[外置手机] 构建世界书前缀失败：", e);
    }
  }

  if (!blocks.length) return "";
  return `${blocks.join("\n\n")}\n\n`;
}





// 查手机相关
let memoMode = "list"; // list | detail
let memoCurrentCharKey = null;
let lastMemoAllCharsText = "";
let lastMemoAllCharsTime = 0;
const MEMO_CACHE_TTL = 60 * 1000;

const MEMO_CHAR_LIST = [
  { key: "yan", label: "岩白眉" },
  { key: "cai", label: "猜叔" },
  { key: "dantuo", label: "但拓" },
  { key: "zhoubin", label: "州槟" },
];

function getMemoCharDisplayName(key) {
  const f = MEMO_CHAR_LIST.find((x) => x.key === key);
  return f ? f.label : "某人";
}

let phonePanelInitialized = false;

//* ===== 构造发往主对话的 prompt ===== */

async function buildPhonePrompt(text, charName, contactName) {
  const history = getHistory();
  const historyText = history
    .map((m) => {
      const mark = m.role === "char" ? "对方" : "我";
      const revokedMark = m.revoked ? "[已撤回]" : "";
      const t = m.content || m.rawContent || "";
      return `${mark}${revokedMark}：${t}`;
    })
    .join("\n");

  const contactPart = contactName
    ? `你正在扮演【${charName}】，当前在和联系人【${contactName}】通过一个老式手机聊天。\n`
    : "";

  // 手机专用上下文前缀（预设 + 世界书）
  const contextPrefix = await buildPhoneContextPrefix({
    mode: "sms",
    charName,
    contactName,
  });

  // 主体部分：一定以 PHONE_PREFIX 开头
  let metaPrompt = `${PHONE_PREFIX} 以下是一个手机聊天窗口，你作为角色【${charName}】正在通过手机和对方联系。

${contactPart}历史聊天记录如下（手机视角）：
${historyText || "（暂无历史记录）"}

上面的内容是“手机里已经发生的聊天记录”，下面是我刚刚从手机里发出的这条信息（如果有的话）：
${text || "（这次没有发送新内容，只是整理历史）"}

请你根据这些信息，用手机短信的语气继续回复。`;

  // 把手机预设 / 世界书附加在后面，避免挡在前缀前面
  if (contextPrefix) {
    metaPrompt += `

${contextPrefix}`;
  }

  return metaPrompt;
}

function getPhonePanel() {
  return document.getElementById(PHONE_ID);
}

// ========== PC 端拖动手机位置 ==========

function makePhoneDraggable(panel) {
  if (!panel) return;
  // 手机端就不拖了，避免和触摸滚动打架
  if (window.innerWidth <= 768) return;

  let isDown = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  function onMouseDown(e) {
    if (e.button !== 0) return;

    const target = e.target;
    // 在屏幕内部（聊天框、按钮、输入框）点就不要拖动
    if (
      target.closest &&
      target.closest(".ybm-nokia-screen, textarea, button, input")
    ) {
      return;
    }

    isDown = true;
    panel.classList.add("ybm-dragging");

    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;

    // 改成用 left/top 定位，方便拖动
    panel.style.left = `${startLeft}px`;
    panel.style.top = `${startTop}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!isDown) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    panel.style.left = `${startLeft + dx}px`;
    panel.style.top = `${startTop + dy}px`;
  }

  function onMouseUp() {
    if (!isDown) return;
    isDown = false;
    panel.classList.remove("ybm-dragging");
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  panel.addEventListener("mousedown", onMouseDown);
}

/* ===== 聊天 UI ===== */

function clearPhoneChatUI() {
  const list = document.getElementById(CHAT_LIST_ID);
  if (list) list.innerHTML = "";
}

function refreshPendingBubbles() {
  const list = document.getElementById(CHAT_BUFFER_ID);
  if (!list) return;

  list.innerHTML = "";
  const pendings = getPendingMessages();
  pendings.forEach((p) => {
    const item = document.createElement("div");
    item.className = "ybm-chat-bubble ybm-chat-user ybm-chat-pending";
    if (p.revoked) item.classList.add("ybm-chat-revoked-pending");
    item.dataset.pendingId = p.id;

    const textSpan = document.createElement("span");
    textSpan.className = "ybm-chat-text";
    textSpan.textContent = p.text;
    item.appendChild(textSpan);

    const actions = document.createElement("span");
    actions.className = "ybm-chat-pending-actions";

    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "ybm-chat-pending-btn";
    revokeBtn.textContent = p.revoked ? "恢复" : "撤回";
    revokeBtn.addEventListener("click", () => {
      revokePendingById(p.id);
      refreshPendingBubbles();
    });
    actions.appendChild(revokeBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "ybm-chat-pending-btn";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => {
      deletePendingById(p.id);
      refreshPendingBubbles();
    });
    actions.appendChild(delBtn);

    item.appendChild(actions);
    list.appendChild(item);
  });
}

export function restoreHistoryUIFromMetadata() {
  // 先从 chatMetadata 中把各联系人历史读回内存
  loadHistoryFromMetadata();

  // 再根据当前联系人的历史重画 UI
  clearPhoneChatUI();
  const history = getHistory();
  history.forEach((m) => {
    const text = m.revoked
      ? "" // 撤回消息的文本交给 appendBubble 用占位文案
      : m.content || m.rawContent || "";
    appendBubble(m.role, text, {
      revoked: !!m.revoked,
      store: false,
      msgId: m.id,
      rawContent: m.rawContent || m.content || "",
    });
  });
  refreshPendingBubbles();
}


export function appendBubble(who, text, options) {
  options = options || {};
  const list = document.getElementById(CHAT_LIST_ID);
  if (!list) return;
  if (typeof text !== "string") return;

  const store = options.store !== false;
  const isRevoked = !!options.revoked;
  let msgId = options.msgId || null;
  const rawContent =
    typeof options.rawContent === "string"
      ? options.rawContent
      : text;

  const item = document.createElement("div");
  const whoTag = who === "char" ? "char" : "user";
  item.className = "ybm-chat-bubble ybm-chat-" + whoTag;
  if (isRevoked) item.classList.add("ybm-chat-revoked");

  const textSpan = document.createElement("span");
  textSpan.className = "ybm-chat-text";

  const placeholder =
    who === "char" ? "对方撤回了一条消息" : "已撤回一条消息";

  textSpan.textContent =
    isRevoked && !text ? placeholder : text;

  item.appendChild(textSpan);

  // 先挂到列表上
  list.appendChild(item);
  list.scrollTop = list.scrollHeight || 99999;

  // 如果需要存历史，就在这里写入存储，并拿到真正的 msgId
  if (store) {
    if (who === "char") {
      const msg = pushCharMessage(text, { revoked: isRevoked });
      if (msg && msg.id && !msgId) {
        msgId = msg.id;
      }
    } else {
      const msg = pushUserMessage(text, { revoked: isRevoked });
      if (msg && msg.id && !msgId) {
        msgId = msg.id;
      }
    }
    saveHistoryToMetadata();
  }

  // 把 msgId、原文和占位文案挂在 DOM 上，方便“偷看”用
  if (msgId) {
    item.dataset.msgId = msgId;
  }
  item.dataset.rawContent = rawContent || "";
  item.dataset.placeholder = placeholder;
  item.dataset.peek = "0"; // 0 = 显示占位文案，1 = 显示原文

  // 给“撤回气泡”加点击偷看功能
  if (isRevoked) {
    item.addEventListener("click", () => {
      const currentPeek = item.dataset.peek === "1";
      const history = getHistory();
      const id = item.dataset.msgId;
      const msg =
        history && id
          ? history.find((m) => m && m.id === id)
          : null;

      const original =
        (msg && (msg.rawContent || msg.content)) ||
        item.dataset.rawContent ||
        "";

      if (!original) {
        // 没有原文，就什么也不做
        return;
      }

      if (currentPeek) {
        // 当前是“偷看中” → 切回占位文案
        textSpan.textContent = item.dataset.placeholder || placeholder;
        item.dataset.peek = "0";
      } else {
        // 当前是“只看到撤回” → 展示原文
        textSpan.textContent = original;
        item.dataset.peek = "1";
      }
    });
  }
}
// ===== 统一处理角色回复文本：拆行 + 撤回 + 过滤思考过程 =====
function handleCharReplyText(rawText) {
  if (!rawText || typeof rawText !== "string") return;

  // 统一换行
  const lines = rawText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length) return;

  for (const line of lines) {
    // ① 撤回指令：任何一行以 [撤回] 开头都当成命令
    if (/^\[撤回\]/.test(line)) {
      const revokedId = revokeLastCharMessage();
      if (revokedId) {
        // 更新 metadata，并重画手机 UI
        saveHistoryToMetadata();
        restoreHistoryUIFromMetadata();
      }
      // 撤回指令本身不显示成气泡
      continue;
    }

    // ② 过滤明显是“思考过程 / 工具分析”的英文垃圾
    const lower = line.toLowerCase();
    const looksLikeReasoning =
      lower.includes("i've been analyzing") ||
      lower.includes("i have been analyzing") ||
      lower.includes("proposed action") ||
      lower.includes("latest revision") ||
      lower.includes("tool call") ||
      lower.startsWith("analysis:") ||
      lower.startsWith("thought:") ||
      lower.startsWith("internal reflection");

    if (looksLikeReasoning) {
      // 直接丢弃这行，不进手机
      continue;
    }

    // ③ 正常内容 → 作为一条角色气泡
    appendBubble("char", line, { revoked: false });
  }
}

// 把同一条回复按换行拆成多个气泡：每一行 -> 一个 char 气泡
function appendCharReplyAsLines(fullText) {
  if (typeof fullText !== "string") return;

  const raw = fullText.replace(/\r\n/g, "\n");
  const parts = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s);

  // 没有换行，就当普通单条处理
  if (!parts.length) {
    appendBubble("char", fullText, { revoked: false });
    return;
  }

  parts.forEach((line) => {
    appendBubble("char", line, { revoked: false });
  });
}



/* ===== 输入区 ===== */

function initPhoneChatInput() {
  const inputEl = document.getElementById(CHAT_INPUT_ID);
  const sendBtn = document.getElementById(CHAT_SEND_ID);
  const saveBtn = document.getElementById("ybm-chat-save-btn");
  if (!inputEl || !sendBtn) return;

  // 回车：直接把所有暂存 + 当前输入一起发给模型
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      sendBufferedFromPhone();
    }
  });

  // 暂存：在手机里正常显示一条“我发出的短信”，
  // 但只是加到待发送列表里，还不真正发给模型
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const text = inputEl.value.trim();
      if (!text) return;

      // 1）加入 pending 列表：等点“发送”时一起发给模型
      pushPendingChunk(text);

      // 2）在手机对话框里先显示出来，但暂时不写入历史
      appendBubble("user", text, { revoked: false, store: false });

      // 3）清空输入框
      inputEl.value = "";

      // 4）不再使用单独的暂存显示区，所以不用 refreshPendingBubbles()
      // refreshPendingBubbles();
    });
  }

  // 发送：把所有暂存 + 本次输入一起发给模型
  sendBtn.addEventListener("click", () => {
    sendBufferedFromPhone();
  });
}

async function sendBufferedFromPhone() {
  const inputEl = document.getElementById(CHAT_INPUT_ID);
  if (!inputEl) return;

  const extraText = inputEl.value.trim();
  const pendings = getPendingMessages();

  // 没内容不发
  if (!extraText && pendings.length === 0) return;

  // ==== 判断当前是否是 SillyTavern ====
  const hasST = !!(window.SillyTavern && typeof window.SillyTavern.getContext === "function");
  const ctx = hasST ? getContextSafe() : null;

  // ==== 合并待发送文本 ====
  const textPieces = [];
  pendings.forEach((p) => {
    if (!p.revoked) textPieces.push(p.text);
  });
  if (extraText) textPieces.push(extraText);
  const merged = textPieces.join("\n\n");
  inputEl.value = "";

  // ==== 决定角色名（初始） ====
  let charName = "角色";

  if (hasST && ctx && ctx.characterName) {
    charName = ctx.characterName;
  }

   // ==== 决定当前联系人 ====
  initPhoneContactsForUI();
  const contactName = getCurrentContactName();

  // ==== 根据联系人 + 上下文，最终确定本次对话的角色身份 ====
  charName = resolveCharNameForPhone(charName, contactName);

  // ==== 写入手机聊天历史 ====
  pendings.forEach((p) =>
    pushUserMessage(p.text, { revoked: !!p.revoked })
  );
  if (extraText) pushUserMessage(extraText, { revoked: false });
  saveHistoryToMetadata();

  // ==== 构建发给模型的 prompt ====
  const finalPrompt = await buildPhonePrompt(merged, charName, contactName);
  console.log("[外置手机][DEBUG] 发送给模型的完整提示词：\n", finalPrompt);


  // 清空暂存
  consumeAllPending();
  refreshPendingBubbles();
  restoreHistoryUIFromMetadata();


  // ==============================================================
  // 🚀 ① 独立网页模式：直接调用 API
  // ==============================================================
  if (!hasST) {
    const reply = await callToolApi({
      feature: "sms-chat",
      messages: [
        { role: "user", content: finalPrompt },
      ],
      max_tokens: 512,
    });

    if (!reply) {
      appendBubble("char", "（API 调用失败）", { revoked: false });
      return;
    }

    // 统一走“多气泡 + 撤回指令 + 思考过滤”的处理
    handleCharReplyText(reply);
    saveHistoryToMetadata();
    return;
  }



  // ==============================================================
  // 🚀 ② SillyTavern 模式：原逻辑（保留兼容 ST）
  // ==============================================================
  const mainInput = document.getElementById("send_textarea");
  const sendButton = document.getElementById("send_but");

  if (!mainInput || !sendButton) {
    console.warn("[外置手机] 找不到 send_textarea/send_but（当前应为独立模式）");
    return;
  }

  // 写入 ST 输入框
  mainInput.value = finalPrompt;
  mainInput.dispatchEvent(new Event("input", { bubbles: true }));
  sendButton.click();

  // ========== 下面保留轮询 ST 聊天的逻辑 ==========
  let ctxBefore = getContextSafe() || {};
  let chatBefore = Array.isArray(ctxBefore.chat) ? ctxBefore.chat : [];
  const prevLen = chatBefore.length;

  const startTime = Date.now();
  const timeoutMs = 60000;
  const pollInterval = 1000;

  function pollReply() {
    const ctxNow = getContextSafe() || {};
    const chatNow = Array.isArray(ctxNow.chat) ? ctxNow.chat : [];

    if (chatNow.length > prevLen) {
      for (let i = chatNow.length - 1; i >= prevLen; i--) {
        const msg = chatNow[i];
        if (!msg || msg.is_user) continue;
        const text = typeof msg.mes === "string" ? msg.mes : "";
        if (!text) continue;

        // 也统一走“多气泡 + 撤回指令 + 思考过滤”
        handleCharReplyText(text);
        saveHistoryToMetadata();
        return;
      }
    }

    if (Date.now() - startTime > timeoutMs) return;
    setTimeout(pollReply, pollInterval);
  }

  setTimeout(pollReply, pollInterval);
}



/* ===== 联系人逻辑 ===== */

function initPhoneContactsForUI() {
  if (phoneContacts) return phoneContacts;

  const ctx = getContextSafe();
  if (!ctx) {
    console.warn("[外置手机] initPhoneContactsForUI(): 无 context");
    return null;
  }
  if (!ctx.extension_settings) ctx.extension_settings = {};
  const settingsRef =
    ctx.extension_settings[EXT_ID] ||
    (ctx.extension_settings[EXT_ID] = {});

  const saveSettingsDebounced =
    typeof ctx.saveSettingsDebounced === "function"
      ? ctx.saveSettingsDebounced
      : () => {};

  const coreForContacts = {
    getCurrentCharInfo() {
      const c = getContextSafe();
      if (!c) return { charId: null, charName: null };
      return {
        charId: c.characterId || null,
        charName: c.characterName || null,
      };
    },
    logInfo: (...args) => console.log("[外置手机][Contacts]", ...args),
    logWarn: (...args) => console.warn("[外置手机][Contacts]", ...args),
    logError: (...args) => console.error("[外置手机][Contacts]", ...args),
  };

  const storageForContacts = {
    clearHistory: (contactId) => {
      resetHistory(contactId);
      saveHistoryToMetadata();
    },
  };

  try {
    phoneContacts = new YBMPhoneContacts({
      EXT_ID,
      core: coreForContacts,
      settingsRef,
      saveSettingsDebounced,
      storage: storageForContacts,
    });
    if (typeof phoneContacts.ensureDefaultCoreContacts === "function") {
      phoneContacts.ensureDefaultCoreContacts();
    }
  } catch (e) {
    console.error("[外置手机] 初始化联系人失败：", e);
    return null;
  }

  registerContactIdGetter(() => {
    if (!phoneContacts || typeof phoneContacts.getCurrentContact !== "function")
      return null;
    const c = phoneContacts.getCurrentContact();
    return c ? c.id : null;
  });

  return phoneContacts;
}

function renderContactsList() {
  const listEl = document.getElementById("ybm-nokia-contacts-list");
  if (!listEl) return;

  const contactsInstance = initPhoneContactsForUI();
  if (!contactsInstance) {
    listEl.innerHTML = `<div class="ybm-contacts-empty">联系人模块初始化失败。</div>`;
    return;
  }

  const allContacts = contactsInstance.getAllContacts() || [];
  if (!allContacts.length) {
    listEl.innerHTML = `<div class="ybm-contacts-empty">暂无联系人。</div>`;
    return;
  }

  listEl.innerHTML = "";
  allContacts.forEach((c) => {
    const row = document.createElement("div");
    row.className = "ybm-contact-row";
    row.dataset.contactId = c.id;

    // 左侧圆头像
    const avatar = document.createElement("div");
    avatar.className = "ybm-contact-avatar";
    const firstChar =
      (c.name && c.name.trim && c.name.trim()[0]) || "·";
    avatar.textContent = firstChar;

    // 右侧两行文字
    const textWrap = document.createElement("div");
    textWrap.className = "ybm-contact-text";

    const nameDiv = document.createElement("div");
    nameDiv.className = "ybm-contact-name";
    nameDiv.textContent = c.name || "未命名联系人";

    const subDiv = document.createElement("div");
    subDiv.className = "ybm-contact-sub";
    subDiv.textContent = "最近对话";

    textWrap.appendChild(nameDiv);
    textWrap.appendChild(subDiv);

    row.appendChild(avatar);
    row.appendChild(textWrap);

    row.addEventListener("click", () => {
      if (phoneContacts) phoneContacts.setCurrentContactId(c.id);
      renderContactsList();
      switchToChatMode();
    });

    if (phoneContacts.getCurrentContactId() === c.id) {
      row.classList.add("ybm-contact-selected");
    }
    listEl.appendChild(row);
  });
}

function getCurrentContactName() {
  initPhoneContactsForUI();
  if (!phoneContacts) return null;
  const c = phoneContacts.getCurrentContact();
  return c ? c.name || "未命名联系人" : null;
}
// 根据当前 SillyTavern 角色名 + 联系人名，最终决定这次请求的「角色身份」
function resolveCharNameForPhone(baseCharName, contactName) {
  let name = (baseCharName || "").trim();

  // 如果没拿到 ST 的角色名，或者只是一个通用的占位，就优先用联系人名字
  if (!name || name === "角色") {
    name = (contactName || "").trim();
  }

  if (!name) return "角色";

  // 做一下模糊归一，防止有昵称
  if (name.includes("岩白眉") || name.includes("白眉")) {
    return "岩白眉";
  }
  if (name.includes("猜叔") || name.includes("阿猜") || name.includes("猜哥")) {
    return "猜叔";
  }
  if (name.includes("但拓") || name.toLowerCase().includes("dantuo")) {
    return "但拓";
  }
  if (name.includes("州槟") || name.includes("州滨") || name.toLowerCase().includes("zhoubin")) {
    return "州槟";
  }

  // 其他情况就用原来的名字
  return name;
}

/* ===== 查手机：从联系人历史读“贴脸素材” ===== */

function getHistoryTextsForMemoChar(charKey) {
  try {
    const contactsInstance = initPhoneContactsForUI();
    if (!contactsInstance) return getHistoryTextsForContact(null, 40);

    const all = contactsInstance.getAllContacts() || [];
    const nameMap = {
      yan: "岩白眉",
      cai: "猜叔",
      dantuo: "但拓",
      zhoubin: "州槟",
    };
    const target = nameMap[charKey];
    let contact =
      all.find((c) => c && c.name === target) || all[0] || null;

    return getHistoryTextsForContact(contact ? contact.id : null, 40);
  } catch (e) {
    console.error("[外置手机][memo] 读取角色历史失败：", e);
    return [];
  }
}

/* ===== 查手机界面 ===== */

function renderMemoListView() {
  const memoView = document.getElementById("ybm-nokia-memo-view");
  if (!memoView) return;

  memoMode = "list";

  memoView.innerHTML = `
    <div class="ybm-memo-header-row">
      <button type="button" class="ybm-nav-btn ybm-memo-back-btn">&lt; 菜单</button>
      <span class="ybm-memo-title">黑客工具</span>
    </div>
    <div class="ybm-memo-header">选择要偷看的手机</div>
    <div class="ybm-memo-roles-grid">
      ${MEMO_CHAR_LIST.map(
        (c) => `
        <div class="ybm-memo-role-card" data-char="${c.key}">
          <div class="role-name">${c.label}</div>
          <div class="role-sub">点按进入，再按“偷看”破解他的手机</div>
        </div>
      `
      ).join("")}
    </div>
  `;

  const back = memoView.querySelector(".ybm-memo-back-btn");
  if (back) {
    back.addEventListener("click", () => {
      showHomeScreen();
    });
  }

  memoView.querySelectorAll(".ybm-memo-role-card").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.getAttribute("data-char");
      if (!key) return;
      openMemoDetail(key);
    });
  });
}

function openMemoDetail(charKey) {
  memoMode = "detail";
  memoCurrentCharKey = charKey;

  const memoView = document.getElementById("ybm-nokia-memo-view");
  if (!memoView) return;

  const name = getMemoCharDisplayName(charKey);
  memoView.innerHTML = `
    <div class="ybm-memo-header-row">
      <button type="button" class="ybm-nav-btn ybm-memo-back-btn">&lt; 黑客</button>
      <span class="ybm-memo-title">查手机（详情）</span>
    </div>
    <div class="ybm-memo-header">${name}的手机</div>
    <div class="ybm-memo-peek-tip">
      小黑客已经锁定目标，但还没有连线。<br>
      按下面的「偷看」按钮，会调用主对话中的模型，一次性生成四个人当前的手机内容。
    </div>
    <div class="ybm-memo-peek-actions">
      <button type="button" class="ybm-memo-peek-btn">偷看</button>
    </div>
    <div class="ybm-memo-result"></div>
  `;
  updateNokiaHeader();

  const back = memoView.querySelector(".ybm-memo-back-btn");
  if (back) {
    back.addEventListener("click", () => {
      renderMemoListView();
      updateNokiaHeader();
    });
  }

  const btn = memoView.querySelector(".ybm-memo-peek-btn");
  const resultBox = memoView.querySelector(".ybm-memo-result");
  if (btn && resultBox) {
    btn.addEventListener("click", () => {
      ybmFetchMemoDataForChar(charKey, resultBox);
    });
  }
}

async function ybmFetchMemoDataForChar(charKey, resultBox) {
  const name = getMemoCharDisplayName(charKey);
  if (!resultBox) return;

  const now = Date.now();
  if (lastMemoAllCharsText && now - lastMemoAllCharsTime < MEMO_CACHE_TTL) {
    const safe = lastMemoAllCharsText
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    resultBox.innerHTML = `
      <div class="ybm-memo-section-title">入侵结果（共用最近一次的四人手机记录）</div>
      <div class="ybm-memo-raw">${safe}</div>
    `;
    return;
  }

  resultBox.innerHTML = `
    <div class="ybm-memo-section-title">正在入侵</div>
    <div class="ybm-memo-result-text">小黑客正在同时破解 ${name} 等四个人的手机……</div>
  `;

  const ctxBefore = getContextSafe() || {};
  const chatBefore = Array.isArray(ctxBefore.chat) ? ctxBefore.chat : [];
  const prevLen = chatBefore.length;

  const mainInput = document.getElementById("send_textarea");
  const sendButton = document.getElementById("send_but");
  if (!mainInput || !sendButton) {
    console.warn("[外置手机][memo] 找不到 send_textarea/send_but");
    resultBox.innerHTML = `<div class="ybm-memo-result-text">无法向主对话发送偷看请求。</div>`;
    return;
  }

  const historyTexts = getHistoryTextsForMemoChar(charKey) || [];
  const historyPart = historyTexts.join("\n\n");

  const allNames = MEMO_CHAR_LIST.map((c) => c.label).join("、");
  const contextPrefix = await buildPhoneContextPrefix({ mode: "memo" });
  const prompt = `${contextPrefix}${PHONE_PREFIX}【YBM_MEMO_REQUEST】


现在请你暂时跳出和玩家的直接对话，扮演一个旁观记录者，帮我同时整理下面四个人此刻手机里的内容：${allNames}。

要求：
1. 分别以这四个人的第一人称写他们“此刻会出现在手机里的内容”，可以包括：最近来往短信、最近的心情与心事、近期账目/款项往来、随手记下的备忘录。
2. 输出时请按人物分段，使用形如：
【岩白眉】
（这里是他的手机内容，可以是多行）
【猜叔】
（这里是他的手机内容）……
3. 不要解释，也不要和玩家说话，把这一整段当成“偷看到的手机内容记录”。

如果有帮助，你可以参考最近的对话氛围：
${historyPart || "（没有特别的对话记录，就按你对他们的理解来写。）"}
`;

  mainInput.value = prompt;
  mainInput.dispatchEvent(new Event("input", { bubbles: true }));
  sendButton.click();

  const maxWaitMs = 60000;
  const start = Date.now();

  function poll() {
    const ctx = getContextSafe() || {};
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    if (chat.length > prevLen) {
      for (let i = chat.length - 1; i >= prevLen; i--) {
        const m = chat[i];
        if (!m || m.is_user) continue;
        const text = typeof m.mes === "string" ? m.mes : "";
        if (!text) continue;

        lastMemoAllCharsText = text;
        lastMemoAllCharsTime = Date.now();

        const safe = text
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        resultBox.innerHTML = `
          <div class="ybm-memo-section-title">入侵结果（四人手机内容）</div>
          <div class="ybm-memo-raw">${safe}</div>
        `;
        return;
      }
    }

    if (Date.now() - start > maxWaitMs) {
      resultBox.innerHTML = `<div class="ybm-memo-result-text">等待主对话回复超时。</div>`;
      return;
    }
    setTimeout(poll, 1000);
  }

  poll();
}

/* ===== 各个 App 切换 ===== */

function showHomeScreen() {
  currentApp = "home";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "flex";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "none";
  if (placeholderView) placeholderView.style.display = "none";

  updateNokiaHeader();
}

function switchToSmsContacts() {
  currentApp = "sms";
  phoneScreenMode = "contacts";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "flex";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "none";
  if (placeholderView) placeholderView.style.display = "none";

  renderContactsList();
  updateNokiaHeader();
}

function switchToChatMode() {
  currentApp = "sms";
  phoneScreenMode = "chat";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "flex";
  if (memoView) memoView.style.display = "none";
  if (placeholderView) placeholderView.style.display = "none";

  updateNokiaHeader();
  restoreHistoryUIFromMetadata();
  refreshPendingBubbles();
}

function showMemoScreen() {
  currentApp = "memo";
  memoMode = "list";
  memoCurrentCharKey = null;

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "flex";
  if (placeholderView) placeholderView.style.display = "none";

  renderMemoListView();
  updateNokiaHeader();
}

function showForumPlaceholder() {
  currentApp = "forum";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "none";
  if (placeholderView) placeholderView.style.display = "flex";

  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (box) {
    box.innerHTML = `
      <div class="ybm-placeholder-title">论坛（施工中）</div>
      <div class="ybm-placeholder-text">
        以后可以做角色八卦论坛、留言板之类的功能。<br>
        当前版本只是占位。
      </div>
    `;
  }

  updateNokiaHeader();
}

function showBountyPlaceholder() {
  currentApp = "bounty";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById(
    "ybm-nokia-placeholder-view"
  );

  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "none";
  if (placeholderView) placeholderView.style.display = "flex";

  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (box) {
    box.innerHTML = `
      <div class="ybm-placeholder-title">悬赏（施工中）</div>
      <div class="ybm-placeholder-text">
        以后可以做悬赏任务、接活系统、黑市张榜等玩法。<br>
        当前版本只是占位。
      </div>
    `;
  }

  updateNokiaHeader();
}

function showApiSettingsScreen() {
  currentApp = "api";

  const homeView = document.getElementById("ybm-nokia-home-view");
  const contactsView = document.getElementById("ybm-nokia-contacts");
  const chatView = document.getElementById("ybm-nokia-chat-view");
  const memoView = document.getElementById("ybm-nokia-memo-view");
  const placeholderView = document.getElementById("ybm-nokia-placeholder-view");

  // 隐藏其它页面
  if (homeView) homeView.style.display = "none";
  if (contactsView) contactsView.style.display = "none";
  if (chatView) chatView.style.display = "none";
  if (memoView) memoView.style.display = "none";

  // 显示占位页（这里会渲染 API 界面）
  if (placeholderView) {
    placeholderView.style.display = "flex";
    placeholderView.innerHTML = ""; // 清空旧内容
  }

  // 使用 api.js 里提供的渲染函数
  if (typeof renderApiSettingsScreen === "function") {
    renderApiSettingsScreen();
  } else {
    console.error("找不到 renderApiSettingsScreen，请检查 api.js 是否加载成功");
  }

  // 更新诺基亚顶部标题
  if (typeof updateNokiaHeader === "function") {
    updateNokiaHeader();
  }
}



function renderSettingsHome() {
  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (!box) return;

  const { settings, save } = getPhoneExtSettings();

  box.innerHTML = `
    <div class="ybm-placeholder-title">设置</div>

    <div class="ybm-settings-section">
      <div class="ybm-settings-row ybm-settings-nav-row" id="ybm-settings-nav-preset">
        <label class="ybm-settings-row-left">
          <input type="checkbox" id="ybm-phone-setting-use-preset" />
          <span>手机预设（查手机 &amp; 短信）</span>
        </label>
        <span class="ybm-settings-nav-arrow">›</span>
      </div>
      <div class="ybm-settings-hint">
        控制是否给模型发送手机预设，并进入详细预设管理界面。
      </div>
    </div>

    <div class="ybm-settings-section">
      <div class="ybm-settings-row ybm-settings-nav-row" id="ybm-settings-nav-worldbook">
        <label class="ybm-settings-row-left">
          <input type="checkbox" id="ybm-phone-setting-use-worldbook" />
          <span>手机世界书（《边水往事》设定）</span>
        </label>
        <span class="ybm-settings-nav-arrow">›</span>
      </div>
      <div class="ybm-settings-hint">
        控制是否附带世界观设定，并进入世界书说明界面。
      </div>
    </div>
  `;

  // 勾选框：只改状态，不切页面
  const presetCheckbox = box.querySelector("#ybm-phone-setting-use-preset");
  const worldCheckbox = box.querySelector("#ybm-phone-setting-use-worldbook");

  if (presetCheckbox) {
    presetCheckbox.checked = !!settings.usePhonePreset;
    presetCheckbox.addEventListener("change", (e) => {
      settings.usePhonePreset = !!e.target.checked;
      save();
    });
  }

  if (worldCheckbox) {
    worldCheckbox.checked = !!settings.usePhoneWorldbook;
    worldCheckbox.addEventListener("change", (e) => {
      settings.usePhoneWorldbook = !!e.target.checked;
      save();
    });
  }

  // 行点击：进入子页面（注意排除点击 checkbox 本身）
  const presetRow = box.querySelector("#ybm-settings-nav-preset");
  if (presetRow) {
    presetRow.addEventListener("click", (e) => {
      if ((e.target.tagName || "").toLowerCase() === "input") return;
      renderPresetSettings();
    });
  }

  const worldRow = box.querySelector("#ybm-settings-nav-worldbook");
  if (worldRow) {
    worldRow.addEventListener("click", (e) => {
      if ((e.target.tagName || "").toLowerCase() === "input") return;
      renderWorldbookSettings();
    });
  }
}

async function renderPresetSettings() {
  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (!box) return;

  box.innerHTML = `
    <div class="ybm-placeholder-title">
      <button type="button" class="ybm-settings-back" id="ybm-settings-back-from-preset">←</button>
      手机预设管理
    </div>
    <div class="ybm-settings-section">
      <div class="ybm-settings-hint">
        这里可以单独开启 / 关闭每一条预设，并调整顺序或编辑内容。
      </div>
      <div id="ybm-phone-preset-list" class="ybm-preset-list"></div>
    </div>
  `;

  const backBtn = document.getElementById("ybm-settings-back-from-preset");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      renderSettingsHome();
    });
  }

  const listContainer = box.querySelector("#ybm-phone-preset-list");
  if (!listContainer) return;

  // 如果你已经实现了预设初始化和列表渲染，就用那套；
  // 没有的话，就先显示一行提示。
  try {
    if (
      typeof ensurePresetConfigInitialized === "function" &&
      typeof renderPhonePresetList === "function"
    ) {
      const presetCfg = await ensurePresetConfigInitialized();
      const { save } = getPhoneExtSettings();
      renderPhonePresetList(listContainer, presetCfg, save);
    } else {
      listContainer.textContent =
        "预设管理尚未初始化（缺少 ensurePresetConfigInitialized / renderPhonePresetList）。";
    }
  } catch (e) {
    console.warn("[外置手机] 加载手机预设失败：", e);
    listContainer.textContent = "加载预设时出错。";
  }
}

function renderWorldbookSettings() {
  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (!box) return;

  const { settings } = getPhoneExtSettings();

  box.innerHTML = `
    <div class="ybm-placeholder-title">
      <button type="button" class="ybm-settings-back" id="ybm-settings-back-from-world">←</button>
      手机世界书
    </div>
    <div class="ybm-settings-section">
      <div class="ybm-settings-hint">
        世界书内容目前仍在外部 JSON 中配置，这里只做开关和简单说明。后续如果需要，可以扩展为在手机里浏览角色设定。
      </div>
      <div class="ybm-settings-hint">
        当前状态：<b>${settings.usePhoneWorldbook ? "已启用" : "未启用"}</b>（是否启用由首页的勾选框控制）。
      </div>
    </div>
  `;

  const backBtn = document.getElementById("ybm-settings-back-from-world");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      renderSettingsHome();
    });
  }
}


function initPhoneSettingsView() {
  const box = document.getElementById("ybm-nokia-placeholder-box");
  if (!box) return;

  const { settings, save } = getPhoneExtSettings();

  const presetCheckbox = box.querySelector("#ybm-phone-setting-use-preset");
  const worldCheckbox = box.querySelector("#ybm-phone-setting-use-worldbook");

  if (presetCheckbox) {
    presetCheckbox.checked = !!settings.usePhonePreset;
    presetCheckbox.addEventListener("change", () => {
      settings.usePhonePreset = !!presetCheckbox.checked;
      save();
    });
  }

  if (worldCheckbox) {
    worldCheckbox.checked = !!settings.usePhoneWorldbook;
    worldCheckbox.addEventListener("change", () => {
      settings.usePhoneWorldbook = !!worldCheckbox.checked;
      save();
    });
  }
}


/**
 * 在设置界面渲染“手机预设条目列表”
 */
function renderPhonePresetList(container, presetCfg, saveSettings) {
  container.innerHTML = "";

  if (!presetCfg || !Array.isArray(presetCfg.items) || !presetCfg.items.length) {
    const empty = document.createElement("div");
    empty.className = "ybm-preset-empty";
    empty.textContent = "当前没有可用的预设条目。";
    container.appendChild(empty);
    return;
  }

  const items = [...presetCfg.items].sort(
    (a, b) => (a.order || 0) - (b.order || 0)
  );

  items.forEach((item, index) => {
    if (!item) return;

    const row = document.createElement("div");
    row.className = "ybm-preset-row";

    // 名称
    const labelSpan = document.createElement("span");
    labelSpan.className = "ybm-preset-label";
    labelSpan.textContent = item.label || `条目 ${index + 1}`;
    row.appendChild(labelSpan);

    // 开关
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "ybm-preset-toggle";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = item.enabled !== false;
    toggle.addEventListener("change", () => {
      item.enabled = !!toggle.checked;
      saveSettings();
    });
    toggleLabel.appendChild(toggle);
    toggleLabel.appendChild(document.createTextNode(" 启用"));
    row.appendChild(toggleLabel);

    // 上移
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "ybm-preset-btn";
    upBtn.textContent = "↑";
    upBtn.disabled = index === 0;
    upBtn.addEventListener("click", () => {
      movePhonePresetItem(presetCfg.items, item.id, -1);
      saveSettings();
      renderPhonePresetList(container, presetCfg, saveSettings);
    });
    row.appendChild(upBtn);

    // 下移
    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "ybm-preset-btn";
    downBtn.textContent = "↓";
    downBtn.disabled = index === items.length - 1;
    downBtn.addEventListener("click", () => {
      movePhonePresetItem(presetCfg.items, item.id, +1);
      saveSettings();
      renderPhonePresetList(container, presetCfg, saveSettings);
    });
    row.appendChild(downBtn);

    // 简单编辑按钮：弹出一个对话框改文本
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "ybm-preset-btn";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => {
      const newContent = window.prompt(
        `修改预设「${item.label || `条目 ${index + 1}`}」的内容：`,
        item.content || ""
      );
      if (newContent == null) return; // 取消
      item.content = newContent;
      saveSettings();
    });
    row.appendChild(editBtn);

    container.appendChild(row);
  });
}

function movePhonePresetItem(items, id, delta) {
  const index = items.findIndex((it) => it && it.id === id);
  if (index < 0) return;
  const newIndex = index + delta;
  if (newIndex < 0 || newIndex >= items.length) return;

  const [moved] = items.splice(index, 1);
  items.splice(newIndex, 0, moved);

  // 重新整理 order
  items.forEach((it, i) => {
    if (!it) return;
    it.order = i + 1;
  });
}


/* ===== 顶部标题栏文案 ===== */

function updateNokiaHeader() {
  const titleEl = document.getElementById("ybm-nokia-title");
  if (!titleEl) return;
  switch (currentApp) {
    case "sms":
      titleEl.textContent =
        phoneScreenMode === "contacts" ? "联系人" : "短信对话";
      break;
    case "memo":
      titleEl.textContent =
        memoMode === "list" ? "黑客工具" : "查手机（详情）";
      break;
    case "forum":
      titleEl.textContent = "论坛";
      break;
    case "bounty":
      titleEl.textContent = "悬赏";
      break;
    case "api":
      titleEl.textContent = "设置";
      break;
    default:
      titleEl.textContent = "菜单";
  }
}

/* ===== 底部软键行为 ===== */

function handleSoftkeyLeft() {
  // 统一“返回”
  if (currentApp === "home") return;

  if (currentApp === "sms") {
    if (phoneScreenMode === "chat") {
      switchToSmsContacts();
    } else {
      showHomeScreen();
    }
    return;
  }

  if (currentApp === "memo") {
    if (memoMode === "detail") {
      renderMemoListView();
      memoMode = "list";
      memoCurrentCharKey = null;
      updateNokiaHeader();
    } else {
      showHomeScreen();
    }
    return;
  }

  // 其他 app 直接回到菜单
  showHomeScreen();
}

function handleSoftkeyRight() {
  // 统一“确认”
  if (currentApp === "sms" && phoneScreenMode === "chat") {
    // 聊天里右键 = 发送
    sendBufferedFromPhone();
    return;
  }

  if (currentApp === "memo" && memoMode === "detail") {
    // 查手机详情里右键 = 偷看
    const memoView = document.getElementById("ybm-nokia-memo-view");
    if (!memoView) return;
    const peekBtn = memoView.querySelector(".ybm-memo-peek-btn");
    if (peekBtn) peekBtn.click();
  }

  // 其他 app 暂时无特殊行为
}

/* ===== 创建手机 DOM ===== */

export function createPhonePanel() {
  if (phonePanelInitialized) return;

  const container = document.createElement("div");
  container.id = PHONE_ID;
  container.className = "ybm-phone-panel";

  container.innerHTML = `
    <!-- 外框右上角关闭按钮 -->
    <button type="button" id="ybm-phone-close" class="ybm-phone-close-btn">×</button>

    <div class="ybm-nokia-frame">
      <!-- 顶部灰/白帽 -->
      <div class="top-block">
        <div class="top-inner"></div>
      </div>

      <!-- 中段：红条 + 黑框 + 屏幕 -->
      <div class="middle-block">
        <div class="red-strip"></div>

        <div class="screen-frame">
          <div class="screen-inner">
            <div class="screen-inner-content">
              <!-- 屏幕内部：状态栏 + 标题 + 各个视图 -->
              <div class="ybm-nokia-header">
                <div
                  class="ybm-nokia-status-text"
                  id="ybm-nokia-status-text"
                >
                  <span class="ybm-status-operator">MNT-ICE NET</span>
                  <span class="ybm-status-icons">
                    <span class="ybm-signal-bars">▂▃▄▅▆</span>
                    <span class="ybm-battery">79%</span>
                  </span>
                </div>
                <div class="ybm-nokia-title" id="ybm-nokia-title">菜单</div>
              </div>

              <div class="ybm-nokia-screen">
                <!-- 主菜单：只有 icon 网格 -->
                <div id="ybm-nokia-home-view" class="ybm-nokia-home-view">
                  <div class="ybm-nokia-icon-grid">
                    <div class="ybm-home-icon" data-app="sms">
                      <span class="icon-glyph">✉</span>
                      <span class="icon-label">短信</span>
                    </div>
                    <div class="ybm-home-icon" data-app="memo">
                      <span class="icon-glyph">💻</span>
                      <span class="icon-label">黑客</span>
                    </div>
                    <div class="ybm-home-icon" data-app="forum">
                      <span class="icon-glyph">💬</span>
                      <span class="icon-label">论坛</span>
                    </div>
                    <div class="ybm-home-icon" data-app="bounty">
                      <span class="icon-glyph">⭐</span>
                      <span class="icon-label">悬赏</span>
                    </div>
                    <div class="ybm-home-icon" data-app="api">
                      <span class="icon-glyph">⚙</span>
                      <span class="icon-label">设置</span>
                    </div>
                  </div>
                </div>

                <!-- 联系人列表 -->
                <div
                  id="ybm-nokia-contacts"
                  class="ybm-nokia-contacts-view"
                  style="display:none;"
                >
                  <div class="ybm-contacts-header">
                    <button
                      type="button"
                      class="ybm-nav-btn"
                      data-nav="home"
                    >&lt; 菜单</button>
                    <span>联系人</span>
                  </div>
                  <div
                    id="ybm-nokia-contacts-list"
                    class="ybm-contacts-list"
                  ></div>
                </div>

                <!-- 聊天界面 -->
                <div
                  id="ybm-nokia-chat-view"
                  class="ybm-nokia-chat-view"
                  style="display:none;"
                >
                  <div class="ybm-chat-header">
                    <button
                      type="button"
                      class="ybm-nav-btn"
                      data-nav="contacts"
                    >&lt; 联系人</button>
                    <span>短信对话</span>
                  </div>

                  <div class="ybm-chat-body">
                    <div id="${CHAT_LIST_ID}" class="ybm-chat-list"></div>
                    <div id="${CHAT_BUFFER_ID}" class="ybm-chat-buffer"></div>
                  </div>

                  <div class="ybm-chat-input-bar">
                    <textarea
                      id="${CHAT_INPUT_ID}"
                      class="ybm-chat-input"
                      rows="2"
                      placeholder="在这里给对方发消息..."
                    ></textarea>
                    <div class="ybm-chat-btn-group">
                      <button
                        type="button"
                        id="ybm-chat-save-btn"
                        class="ybm-chat-save-btn"
                      >暂存</button>
                      <button
                        type="button"
                        id="${CHAT_SEND_ID}"
                        class="ybm-chat-send-btn"
                      >发送</button>
                    </div>
                  </div>
                </div>

                <!-- 黑客 / 查手机 -->
                <div
                  id="ybm-nokia-memo-view"
                  class="ybm-nokia-memo-view"
                  style="display:none;"
                ></div>

                <!-- 占位页（论坛 / 悬赏 / 设置） -->
                <div
                  id="ybm-nokia-placeholder-view"
                  class="ybm-nokia-placeholder-view"
                  style="display:none;"
                >
                  <div
                    id="ybm-nokia-placeholder-box"
                    class="ybm-nokia-placeholder-box"
                  ></div>
                </div>
              </div>

              <!-- 底部软键 -->
              <div class="ybm-nokia-softkeys">
                <button type="button" id="ybm-softkey-left" class="ybm-softkey">返回</button>
                <button type="button" id="ybm-softkey-right" class="ybm-softkey">确认</button>
              </div>
            </div>
          </div>
        </div>

        <div class="red-strip"></div>
      </div>

      <!-- 底部灰壳 + 按键 -->
      <div class="bottom-block">
        <div class="bottom-inner">
          <!-- 上排两个蓝键 -->
          <div class="key-row-top">
            <div class="key-btn key-btn-blue"></div>
            <div class="key-spacer"></div>
            <div class="key-btn key-btn-blue"></div>
          </div>

          <!-- 中间主键 -->
          <div class="nav-ring">
            <div class="nav-ring-inner"></div>
          </div>

          <!-- 下排左绿右红 -->
          <div class="key-row-bottom">
            <div class="key-btn key-btn-green"></div>
            <div class="key-spacer"></div>
            <div class="key-btn key-btn-red"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(container);
  phonePanelInitialized = true;

  // 关闭按钮
  const closeBtn = container.querySelector("#ybm-phone-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      container.style.display = "none";
    });
  }

  // 启用拖动（PC 端）
  makePhoneDraggable(container);

  // 主菜单图标点击
  container.querySelectorAll(".ybm-home-icon").forEach((icon) => {
    icon.addEventListener("click", () => {
      const app = icon.getAttribute("data-app");
      if (app === "sms") {
        switchToSmsContacts();
      } else if (app === "memo") {
        showMemoScreen();
      } else if (app === "forum") {
        showForumPlaceholder();
      } else if (app === "bounty") {
        showBountyPlaceholder();
      } else if (app === "api") {
        showApiSettingsScreen();
      }
    });
  });

  // 顶部小返回按钮（菜单 / 联系人之间切换）
  container.querySelectorAll(".ybm-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");
      if (nav === "home") {
        showHomeScreen();
      } else if (nav === "contacts") {
        switchToSmsContacts();
      }
    });
  });

  // 底部软键
  const softLeft = container.querySelector("#ybm-softkey-left");
  const softRight = container.querySelector("#ybm-softkey-right");
  if (softLeft) {
    softLeft.addEventListener("click", handleSoftkeyLeft);
  }
  if (softRight) {
    softRight.addEventListener("click", handleSoftkeyRight);
  }

  initPhoneChatInput();
  renderContactsList();
  updateNokiaHeader();
}

/* ===== 浮动按钮与菜单入口 ===== */

export function createPhoneToggleButton() {
  if (document.getElementById(BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.textContent = "外置手机";
  btn.className = "ybm-phone-toggle-btn";

  btn.addEventListener("click", () => {
    let panel = getPhonePanel();
    if (!panel) {
      createPhonePanel();
      panel = getPhonePanel();
    }
    if (!panel) return;
    const visible = panel.style.display !== "none";
    panel.style.display = visible ? "none" : "block";
  });

  document.body.appendChild(btn);
}

function attachYBMPhoneMenuEntry() {
  const menu = document.querySelector("#extensionsMenu");
  if (!menu) return;
  if (document.getElementById("ybm-phone-menu-entry")) return;

  const item = document.createElement("div");
  item.id = "ybm-phone-menu-entry";
  item.className = "list-group-item flex-container flexGap5";
  item.innerHTML = `
    <div class="fa-solid fa-mobile-screen extensionsMenuExtensionButton"></div>
    <span>外置手机</span>
  `;

  item.addEventListener("click", () => {
    let panel = getPhonePanel();
    if (!panel) {
      createPhonePanel();
      panel = getPhonePanel();
    }
    if (!panel) return;
    panel.style.display = "block";
  });

  menu.appendChild(item);
}

/* ===== 自动挂入口（PC + 手机） ===== */

let ybmAutoMountTimer = null;

function ybmEnsurePhoneToggleMounted() {
  const mainInput = document.getElementById("send_textarea");
  if (!mainInput) return;

  if (document.getElementById(BUTTON_ID)) {
    if (ybmAutoMountTimer) {
      clearInterval(ybmAutoMountTimer);
      ybmAutoMountTimer = null;
    }
    attachYBMPhoneMenuEntry();
    return;
  }

  try {
    createPhoneToggleButton();
    attachYBMPhoneMenuEntry();
  } catch (e) {
    console.error("[外置手机] 自动创建手机入口失败：", e);
  } finally {
    if (ybmAutoMountTimer) {
      clearInterval(ybmAutoMountTimer);
      ybmAutoMountTimer = null;
    }
  }
}

if (typeof window !== "undefined") {
  const startAutoMount = () => {
    if (ybmAutoMountTimer) return;
    ybmAutoMountTimer = setInterval(ybmEnsurePhoneToggleMounted, 1000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAutoMount);
  } else {
    startAutoMount();
  }
}

// 基础初始化（保证在某些奇怪场景下也能挂上按钮）
(function initBase() {
  try {
    createPhoneToggleButton();
    attachYBMPhoneMenuEntry();
  } catch (e) {
    console.error("[外置手机] 初始化入口失败：", e);
  }
})();
