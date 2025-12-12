// index.js —— 外置手机入口（只负责事件监听，不画 UI）
//
// 职责：
// 1）等 SillyTavern 的 context / eventSource 可用后，自动注册监听
// 2）监听角色回复，把“从手机发出去的消息”的模型回复，同步进手机气泡 + 历史
// 3）监听聊天切换事件，重置手机状态 & 恢复对应聊天的手机历史
//
// 注意：UI 的挂载（右下角按钮、面板、滚动条等）全部在 ui.js 里做，这里不再重复创建。

import { getContextSafe, PHONE_PREFIX } from "./core.js";
import {
  clearPending,
  getLastSyncedCharMessage,
  setLastSyncedCharMessage,
  revokeLastCharMessage,
  saveHistoryToMetadata,
} from "./storage.js";
import {
  appendBubble,
  restoreHistoryUIFromMetadata,
  createPhoneToggleButton,
  createPhonePanel,
} from "./ui.js";

// 用来区分“查手机偷看”的那种请求，避免被当成普通手机对话
const MEMO_REQUEST_MARKER = "【YBM_MEMO_REQUEST】";

// 防止重复注册
let replyListenerRegistered = false;
let chatResetListenerRegistered = false;
let initTimer = null;
let initedOnce = false;

/* ========== 监听角色回复，同步到手机 ========== */

function setupReplyListener(ctx) {
  if (replyListenerRegistered) return;
  if (!ctx) ctx = getContextSafe();
  if (!ctx) return;

  const { eventSource, event_types } = ctx;
  if (!eventSource || !event_types) return;

  if (!event_types.CHARACTER_MESSAGE_RENDERED) {
    console.warn("[外置手机] event_types.CHARACTER_MESSAGE_RENDERED 不存在，无法同步回复到手机");
    return;
  }

  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    try {
      const ctx2 = getContextSafe() || {};
      const chat = Array.isArray(ctx2.chat) ? ctx2.chat : [];
      if (chat.length < 2) return;

      const last = chat[chat.length - 1]; // 通常是模型回复
      const prev = chat[chat.length - 2]; // 通常是用户消息

      if (!last || !prev) return;
      if (!prev.is_user) return;
      if (typeof prev.mes !== "string") return;

      const prevText = prev.mes;

      // 1）必须是从“手机”发出去的：带 PHONE_PREFIX
      if (!prevText.includes(PHONE_PREFIX)) return;

      // 2）但不能是“查手机偷看”的那类请求（带 MEMO 标记）
      if (prevText.includes(MEMO_REQUEST_MARKER)) {
        // 这是黑客查手机的 prompt，不要作为对话气泡
        return;
      }

      // 现在可以认为：这是用户在手机里发出的正常短信
      const replyText = typeof last.mes === "string" ? last.mes : "";
      if (!replyText) return;

      // 简单去重：防止同一条回复被多次同步
      const lastSynced = getLastSyncedCharMessage();
      if (replyText === lastSynced) return;
      setLastSyncedCharMessage(replyText);

      // 写入手机 UI + 历史 + chatMetadata
      appendBubble("char", replyText, { revoked: false });
    } catch (e) {
      console.error("[外置手机] 同步角色回复失败：", e);
    }
  });

  replyListenerRegistered = true;
  console.log("[外置手机] 已注册 CHARACTER_MESSAGE_RENDERED 监听");
}

/* ========== 聊天切换时，重置手机状态 ========== */

function setupChatResetListener(ctx) {
  if (chatResetListenerRegistered) return;
  if (!ctx) ctx = getContextSafe();
  if (!ctx) return;

  const { eventSource, event_types } = ctx;
  if (!eventSource || !event_types) return;

  if (!event_types.CHAT_CHANGED) {
    console.warn("[外置手机] event_types.CHAT_CHANGED 不存在，切换聊天时无法自动恢复手机历史");
    return;
  }

  eventSource.on(event_types.CHAT_CHANGED, () => {
    try {
      // 清空暂存队列
      clearPending();
      // 清空“上一次同步过的角色回复”
      setLastSyncedCharMessage("");

      // 等主对话把 chatMetadata 换好，再恢复手机历史
      setTimeout(() => {
        restoreHistoryUIFromMetadata();
      }, 200);
    } catch (e) {
      console.error("[外置手机] 切换聊天后恢复手机历史失败：", e);
    }
  });

  chatResetListenerRegistered = true;
  console.log("[外置手机] 已注册 CHAT_CHANGED 监听");
}

/* ========== 自动初始化：轮询等 SillyT 就绪 ========== */

function tryInitOnce() {
  if (initedOnce) return true;

  const ctx = getContextSafe();
  if (!ctx) {
    // 还拿不到 context，再等等
    return false;
  }

  const { eventSource, event_types } = ctx;
  if (!eventSource || !event_types) {
    console.warn("[外置手机] eventSource/event_types 暂不可用，稍后重试");
    return false;
  }

  // 注册两个监听
  setupReplyListener(ctx);
  setupChatResetListener(ctx);

  initedOnce = true;
  console.log("[外置手机] 已完成事件监听初始化");
  return true;
}

function startAutoInit() {
  if (initTimer) return;

  // 先尝试一次
  if (tryInitOnce()) return;

  // 如果第一次不成功，就开始轮询
  initTimer = setInterval(() => {
    if (tryInitOnce()) {
      clearInterval(initTimer);
      initTimer = null;
    }
  }, 1000);
}

/* ========== 入口：DOM 就绪后启动自动初始化 ========== */

if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAutoInit);
  } else {
    startAutoInit();
  }
}
