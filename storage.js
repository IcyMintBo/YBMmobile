// storage.js —— 手机聊天历史 & 暂存队列 & metadata 持久化（按联系人分库）

import { getChatMetadataSafe, HISTORY_KEY } from "./core.js";

// ========== 每个联系人的历史 ==========
//
// historiesByContact = {
//   contactKey: [ { id, role, content, rawContent, revoked, time }, ... ]
// }
//
// contactKey 由 UI 通过 registerContactIdGetter 提供，如果拿不到 id，就用 "__default__"

const DEFAULT_CONTACT_KEY = "__default__";

let historiesByContact = {};
let currentContactIdGetter = null; // 由 UI 注册

export function registerContactIdGetter(fn) {
  currentContactIdGetter = typeof fn === "function" ? fn : null;
}

function getActiveContactKey() {
  try {
    const id = currentContactIdGetter ? currentContactIdGetter() : null;
    if (id && typeof id === "string") return id;
  } catch (e) {
    console.warn("[外置手机] getActiveContactKey 出错：", e);
  }
  return DEFAULT_CONTACT_KEY;
}

function ensureHistoryArray(contactKey) {
  const key = contactKey || getActiveContactKey();
  if (!historiesByContact[key]) {
    historiesByContact[key] = [];
  }
  return historiesByContact[key];
}

export const MAX_HISTORY_ITEMS = 200;

// 暂存队列（不按联系人分，刷新就没了）
let pendingUserChunks = [];

// 去重：上一次同步到手机的角色原文（仍然全局即可）
let lastSyncedCharMessage = "";

// ========== 工具函数 ==========

let __idCounter = 0;
function genId() {
  __idCounter += 1;
  return "ybm_" + Date.now().toString(36) + "_" + __idCounter.toString(36);
}

export function cleanText(rawText) {
  if (!rawText) return "";
  let text = String(rawText);
  text = text.replace(/^[\s\n]+|[\s\n]+$/g, "");
  text = text.replace(/\r\n/g, "\n");
  return text;
}

// 给“手机界面显示”的文本过滤掉只给系统看的占位符
function stripHiddenForPhoneDisplay(text) {
  if (!text) return "";
  let t = String(text);

  // 状态栏占位符
  t = t.replace(/<StatusPlaceHolderImpl\s*\/>/gi, "");

  // 如有别的“系统指令”也可以在这里补充
  // t = t.replace(/【手机操作：撤回上一条】/g, "");

  t = t.replace(/\n{2,}/g, "\n").trim();
  return t;
}

// ========== 历史数组基础操作（针对当前联系人） ==========

// 清空某个联系人的历史；不传则清当前
export function resetHistory(contactIdOptional) {
  const key =
    typeof contactIdOptional === "string" && contactIdOptional
      ? contactIdOptional
      : getActiveContactKey();
  historiesByContact[key] = [];
}

// 只返回“当前联系人”的历史数组
export function getHistory() {
  return ensureHistoryArray(getActiveContactKey());
}

// 内部通用：向当前联系人的历史里压入一条消息
function pushHistoryItem(role, text, extra) {
  const history = ensureHistoryArray(getActiveContactKey());
  const content = cleanText(text);
  const explicitRevoked = !!(extra && extra.revoked);

  // 撤回的历史可以 content 为空，只要有 rawContent
  if (!content && !explicitRevoked) return null;

  const msg = {
    id: genId(),
    role: role === "char" ? "char" : "user",
    content: content,
    rawContent: content,
    revoked: explicitRevoked,
    time: Date.now(),
  };

  if (msg.revoked) {
    msg.content = "";
  }

  history.push(msg);
  if (history.length > MAX_HISTORY_ITEMS) {
    history.splice(0, history.length - MAX_HISTORY_ITEMS);
  }
  return msg;
}

// ========== 用户消息 & AI 消息 ==========

export function pushUserMessage(text, extra) {
  return pushHistoryItem("user", text, extra);
}

// AI 自动撤回配置
const AUTO_REVOKE_PROB = 0; // 关闭随机自动撤回，由 [撤回] 指令控制
const AUTO_REVOKE_MIN_LEN = 12;

export function pushCharMessage(text, extra) {
  const history = ensureHistoryArray(getActiveContactKey());
  const raw = cleanText(text);
  if (!raw) return null;

  let revokedFlag = !!(extra && extra.revoked);

  // 自动撤回逻辑
  if (!revokedFlag) {
    const allowAuto =
      !extra || typeof extra.allowAutoRevoke === "undefined"
        ? true
        : !extra.allowAutoRevoke
        ? false
        : true;

    if (allowAuto) {
      if (typeof window !== "undefined" && window.FORCE_NEXT_CHAR_REVOKE) {
        revokedFlag = true;
        window.FORCE_NEXT_CHAR_REVOKE = false;
      } else if (
        raw.length >= AUTO_REVOKE_MIN_LEN &&
        Math.random() < AUTO_REVOKE_PROB
      ) {
        revokedFlag = true;
      }
    }
  }

  const visible = stripHiddenForPhoneDisplay(raw);

  const msg = {
    id: genId(),
    role: "char",
    content: revokedFlag ? "" : visible,
    rawContent: raw,
    revoked: revokedFlag,
    time: Date.now(),
  };

  history.push(msg);
  if (history.length > MAX_HISTORY_ITEMS) {
    history.splice(0, history.length - MAX_HISTORY_ITEMS);
  }

  return msg;
}

// 根据 id 删除当前联系人的一条历史
export function deleteMessageById(id) {
  if (!id) return;
  const history = ensureHistoryArray(getActiveContactKey());
  const idx = history.findIndex((m) => m.id === id);
  if (idx !== -1) {
    history.splice(idx, 1);
  }
}

// 撤回当前联系人的一条历史
export function revokeMessageById(id) {
  if (!id) return;
  const history = ensureHistoryArray(getActiveContactKey());
  const msg = history.find((m) => m.id === id);
  if (!msg) return;
  msg.revoked = true;
  msg.content = "";
}
// 撤回当前联系人最后一条“角色消息”
export function revokeLastCharMessage() {
  const history = ensureHistoryArray(getActiveContactKey());
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === "char" && !m.revoked) {
      m.revoked = true;
      // 不动 rawContent，只把展示用内容清空
      m.content = "";
      return m.id;
    }
  }
  return null;
}

// ========== metadata 持久化（所有联系人一起存） ==========

function normalizeHistoryArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      return {
        id: item.id || genId(),
        role: item.role === "char" ? "char" : "user",
        content: typeof item.content === "string" ? item.content : "",
        rawContent: typeof item.rawContent === "string" ? item.rawContent : "",
        revoked: !!item.revoked,
        time: typeof item.time === "number" ? item.time : Date.now(),
      };
    })
    .filter(Boolean);
}

export async function saveHistoryToMetadata() {
  const { chatMetadata, saveMetadata } = getChatMetadataSafe();
  if (!chatMetadata || !saveMetadata) return;

  const out = {};

  Object.keys(historiesByContact).forEach((key) => {
    const srcArr = historiesByContact[key] || [];
    let arr = normalizeHistoryArray(srcArr);
    if (arr.length > MAX_HISTORY_ITEMS) {
      arr = arr.slice(arr.length - MAX_HISTORY_ITEMS);
    }
    out[key] = arr;
  });

  chatMetadata[HISTORY_KEY] = out;

  try {
    await saveMetadata();
  } catch (e) {
    console.error("[外置手机] 保存手机历史到 chatMetadata 失败：", e);
  }
}

export function loadHistoryFromMetadata() {
  const { chatMetadata } = getChatMetadataSafe();

  if (!chatMetadata) {
    historiesByContact = {};
    return getHistory();
  }

  const raw = chatMetadata[HISTORY_KEY];

  if (Array.isArray(raw)) {
    // 旧版本：只有一份数组 → 归到默认联系人下
    historiesByContact = {
      [DEFAULT_CONTACT_KEY]: normalizeHistoryArray(raw),
    };
  } else if (raw && typeof raw === "object") {
    // 新版本：按 key 存对象
    const obj = {};
    Object.keys(raw).forEach((key) => {
      obj[key] = normalizeHistoryArray(raw[key]);
      if (obj[key].length > MAX_HISTORY_ITEMS) {
        obj[key] = obj[key].slice(obj[key].length - MAX_HISTORY_ITEMS);
      }
    });
    historiesByContact = obj;
  } else {
    historiesByContact = {};
  }

  // 返回当前联系人的一份
  return getHistory();
}

// ========== 暂存队列（全局） ==========

export function pushPendingChunk(text) {
  const content = cleanText(text);
  if (!content) return null;

  const pending = {
    id: genId(),
    text: content,
    revoked: false,
  };
  pendingUserChunks.push(pending);
  return pending;
}

export function getPendingMessages() {
  return pendingUserChunks;
}

export function revokePendingById(id) {
  if (!id) return;
  const p = pendingUserChunks.find((m) => m.id === id);
  if (!p) return;
  p.revoked = true;
}

export function deletePendingById(id) {
  if (!id) return;
  const idx = pendingUserChunks.findIndex((m) => m.id === id);
  if (idx !== -1) {
    pendingUserChunks.splice(idx, 1);
  }
}

export function consumeAllPending() {
  const chunks = pendingUserChunks.map((p) => ({
    id: p.id,
    text: p.text,
    revoked: !!p.revoked,
  }));
  pendingUserChunks = [];
  return chunks;
}

export function clearPending() {
  pendingUserChunks = [];
}

// ========== 查手机：获取某联系人的用户文本（最近 limit 条）==========

export function getHistoryTextsForContact(contactId, limit = 30) {
  try {
    const key =
      typeof contactId === "string" && contactId
        ? contactId
        : getActiveContactKey();

    const history = historiesByContact[key] || [];
    if (!Array.isArray(history)) return [];

    // 只要用户发出的内容
    const userMsgs = history.filter(
      (m) => m && m.role === "user" && typeof m.rawContent === "string"
    );

    const texts = userMsgs.map((m) => m.rawContent.trim()).filter(Boolean);

    if (limit > 0 && texts.length > limit) {
      return texts.slice(texts.length - limit);
    }

    return texts;
  } catch (e) {
    console.error("[外置手机][storage] getHistoryTextsForContact 错误：", e);
    return [];
  }
}

// ========== “上次同步的角色消息” ==========

export function getLastSyncedCharMessage() {
  return lastSyncedCharMessage;
}

export function setLastSyncedCharMessage(text) {
  lastSyncedCharMessage = cleanText(text || "");
}
