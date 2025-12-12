// events.js —— 监听 ST 事件，同步角色回复 & 切换聊天时恢复历史

import { getContextSafe, PHONE_PREFIX } from "./core.js";
import {
  clearPending,
  getLastSyncedCharMessage,
  setLastSyncedCharMessage,
} from "./storage.js";
import {
  appendBubble,
  restoreHistoryUIFromMetadata,
  createPhoneToggleButton,
  createPhonePanel,
} from "./ui.js";

/**
 * 监听角色回复，把“由手机发起的对话”的回复同步到手机并写入手机历史
 *
 * 逻辑与老版 index.js 的 PhoneEvents 一致：
 * - 事件：CHARACTER_MESSAGE_RENDERED（角色消息渲染完）
 * - 判断上一条消息是否由手机发出的（mes 以 PHONE_PREFIX 开头）
 * - 避免重复同步（使用 lastSyncedCharMessage 去重）
 * - 把角色回复 appendBubble('char', replyText) → 写入手机 UI + 历史 + metadata
 */
function setupReplyListener() {
  const ctx = getContextSafe();
  if (!ctx) return;

  const { eventSource, event_types } = ctx;
  if (!eventSource || !event_types) return;

  if (!event_types.CHARACTER_MESSAGE_RENDERED) {
    console.warn("[外置手机] event_types.CHARACTER_MESSAGE_RENDERED 不存在");
    return;
  }

  // 每次有“角色消息渲染完成”时触发
  eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    try {
      const ctx2 = getContextSafe() || {};
      const chat = ctx2.chat;
      if (!Array.isArray(chat) || chat.length < 2) return;

      const last = chat[chat.length - 1]; // 当前这条（一般是模型回复）
      const prev = chat[chat.length - 2]; // 上一条（一般是用户）

      if (!last || !prev) return;

      // 只关心：上一条是“用户消息”
      if (!prev.is_user) return;
      if (typeof prev.mes !== "string") return;

      // 并且上一条消息是“从手机发出去的”（带 PHONE_PREFIX）
      if (!prev.mes.includes(PHONE_PREFIX)) return;

      // 拿到这次模型的回复文本
      const rawReply = typeof last.mes === "string" ? last.mes : "";
      if (!rawReply) return;

      // 简单去重：防止同一条回复被多次同步
      const lastSynced = getLastSyncedCharMessage();
      if (rawReply === lastSynced) return;
      setLastSyncedCharMessage(rawReply);

      // 检测是否是“撤回指令”
      const trimmed = rawReply.trim();
      const lines = trimmed
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const isRevokeCommand =
        lines.length === 1 && /^\[撤回\]/.test(lines[0]);

      if (isRevokeCommand) {
        // 撤回当前联系人最后一条角色消息
        const revokedId = revokeLastCharMessage();
        if (revokedId) {
          // 更新 metadata，并重画手机 UI
          saveHistoryToMetadata();
          restoreHistoryUIFromMetadata();
        }
        // 撤回指令本身不显示在手机对话框里
        return;
      }

      // 正常回复：写入手机 UI + 历史 + chatMetadata
      appendBubble("char", rawReply, { revoked: false });
    } catch (e) {
      console.error("[外置手机] 同步角色回复失败：", e);
    }
  });

  console.log("[外置手机] 已注册 CHARACTER_MESSAGE_RENDERED 监听");
}


/**
 * 聊天切换 / 载入其他存档时：
 * - 清除暂存缓冲区
 * - 清空去重用的 lastSyncedCharMessage
 * - 延迟一点点时间，按当前聊天恢复手机历史
 *
 * 对应老版里的 CHAT_CHANGED 逻辑：
 *   pendingUserChunks = [];
 *   lastSyncedCharMessage = '';
 *   setTimeout(() => restoreHistoryUIFromMetadata(), 200);
 */
function setupChatResetListener() {
  const ctx = getContextSafe();
  if (!ctx) return;

  const { eventSource, event_types } = ctx;
  if (!eventSource || !event_types) return;

  if (!event_types.CHAT_CHANGED) {
    console.warn("[外置手机] event_types.CHAT_CHANGED 不存在");
    return;
  }

  eventSource.on(event_types.CHAT_CHANGED, () => {
    try {
      // 清空暂存 + 去重用缓存
      clearPending();
      setLastSyncedCharMessage("");

      // 稍微等一下再从 metadata 恢复
      setTimeout(() => {
        restoreHistoryUIFromMetadata();
      }, 200);
    } catch (e) {
      console.error("[外置手机] 切换聊天后恢复手机历史失败：", e);
    }
  });
}

/**
 * APP 准备好时初始化手机：
 * - 创建右下角按钮
 * - 创建手机面板
 * - 从 chatMetadata 中恢复手机聊天记录
 * - 绑定角色回复监听 & 聊天切换监听
 */
function onAppReady() {
  console.log("[外置手机] APP_READY：初始化外置手机");

  // 创建按钮 + 面板
  createPhoneToggleButton();
  createPhonePanel();

  // 恢复历史记录到 UI（内部会调用 loadHistoryFromMetadata）
  restoreHistoryUIFromMetadata();

  // 绑定事件
  setupReplyListener();
  setupChatResetListener();
}

// 防止重复初始化
let YBM_PHONE_INIT_DONE = false;
// 用于在拿不到 eventSource/APP_READY 时做最多 N 次重试
let YBM_PHONE_RETRY_COUNT = 0;

/**
 * 入口：在 ST 提供的 APP_READY 事件触发后，调用 onAppReady。
 *
 * 默认逻辑：等待 eventSource + APP_READY。
 * 降级逻辑（给手机端 / 特殊客户端用）：
 *   如果多次重试都拿不到 eventSource 或 APP_READY，
 *   但能拿到 SillyTavern 上下文，就直接做一次初始化，只是不再绑定事件。
 */
export function initWhenReady() {
  if (YBM_PHONE_INIT_DONE) return;

  const ctx = getContextSafe();
  const eventSource = ctx && ctx.eventSource;
  const event_types = ctx && ctx.event_types;

  // context 还没挂好 → 继续等
  if (!ctx) {
    setTimeout(initWhenReady, 500);
    return;
  }

  // 正常桌面端：有 eventSource + APP_READY，走原来的事件模式
  if (eventSource && event_types && event_types.APP_READY) {
    eventSource.on(event_types.APP_READY, () => {
      if (YBM_PHONE_INIT_DONE) return;
      YBM_PHONE_INIT_DONE = true;
      onAppReady();
    });

    console.log("[外置手机] 事件系统初始化完成，等待 APP_READY");
    return;
  }

  // 走到这里说明拿不到 eventSource 或 APP_READY —— 很可能是手机端 / 特殊前端
  YBM_PHONE_RETRY_COUNT += 1;

  if (YBM_PHONE_RETRY_COUNT < 10) {
    console.warn(
      "[外置手机] 未找到 eventSource/APP_READY，第",
      YBM_PHONE_RETRY_COUNT,
      "次重试中..."
    );
    setTimeout(initWhenReady, 500);
    return;
  }

  // 多次重试仍然拿不到 eventSource，就直接降级初始化一次：
  console.warn("[外置手机] 使用降级模式初始化外置手机（无 APP_READY 事件）");
  YBM_PHONE_INIT_DONE = true;
  try {
    onAppReady();
  } catch (e) {
    console.error("[外置手机] 降级初始化失败：", e);
  }
}
