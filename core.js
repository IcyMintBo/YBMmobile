// core.js —— 基础工具 & 常量（从老版 index.js 拆出）

const ST_LS_META_KEY = "ybm_phone_meta_standalone_v1";
const ST_LS_EXT_KEY  = "ybm_phone_ext_standalone_v1";

// 安全获取 SillyTavern 上下文 / 或独立模式的伪上下文
export function getContextSafe() {
  // 1) SillyTavern 环境：沿用原逻辑
  if (window.SillyTavern && typeof window.SillyTavern.getContext === "function") {
    try {
      return window.SillyTavern.getContext();
    } catch (e) {
      console.error("[外置手机] 获取 ST context 失败：", e);
      return null;
    }
  }

  // 2) 独立网页环境：构造一个最小可用的伪 context
  if (!window.__YBM_PHONE_STANDALONE_CTX__) {
    const ctx = {
      chat: [],               // 独立模式下用不到，但占个位
      extension_settings: {}, // 存你各种扩展设置（预设开关等）
      chatMetadata: {},       // 存手机聊天历史
      saveMetadata: async () => {
        try {
          localStorage.setItem(
            ST_LS_META_KEY,
            JSON.stringify(ctx.chatMetadata || {})
          );
        } catch (e) {
          console.warn("[外置手机] 保存 metadata 到 localStorage 失败：", e);
        }
      },
      saveSettingsDebounced: () => {
        try {
          localStorage.setItem(
            ST_LS_EXT_KEY,
            JSON.stringify(ctx.extension_settings || {})
          );
        } catch (e) {
          console.warn("[外置手机] 保存设置到 localStorage 失败：", e);
        }
      },
    };


    try {
      const rawExt = localStorage.getItem(ST_LS_EXT_KEY);
      if (rawExt) ctx.extension_settings = JSON.parse(rawExt) || {};
    } catch (e) {
      console.warn("[外置手机] 读取 extension_settings 失败：", e);
    }

    window.__YBM_PHONE_STANDALONE_CTX__ = ctx;
    console.log("[外置手机] 进入独立网页模式");
  }

  return window.__YBM_PHONE_STANDALONE_CTX__;
}

// 每次用 chatMetadata 都要重新取一次
export function getChatMetadataSafe() {
  const ctx = getContextSafe();
  if (!ctx) return {};
  const { chatMetadata, saveMetadata } = ctx;
  return {
    chatMetadata: chatMetadata || {},
    saveMetadata: typeof saveMetadata === "function" ? saveMetadata : async () => {},
  };
}

// 手机在 metadata 里的 key
export const HISTORY_KEY = "ybm_phone_history_v1";

// 手机发送到主对话里的前缀，用来识别“这条是手机发的”
export const PHONE_PREFIX = "【来自外置手机】";

// UI 用到的 DOM id
export const DOM_IDS = {
  PHONE_ID: "ybm-phone-panel",
  BUTTON_ID: "ybm-phone-toggle",
  CHAT_LIST_ID: "ybm-phone-chat-list",
  CHAT_INPUT_ID: "ybm-phone-input",
  CHAT_SEND_ID: "ybm-phone-send",
  CHAT_BUFFER_ID: "ybm-phone-buffer",
};
