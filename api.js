// api.js —— 外置手机 API 配置 + 通用调用（兼容多种代理返回）

import { getContextSafe } from "./core.js";

const EXT_ID = "ybm_phone_ext";
const LS_KEY = "ybm_phone_api_cfg_v2";

const DEFAULT_CONFIG = {
  mode: "custom",
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
};

/* ========== 0. 根据 baseUrl 构造授权头 ========== */
function buildAuthHeader(baseUrl, apiKey) {
  if (!apiKey) return {};
  const key = apiKey.trim();
  if (!key) return {};

  const lower = (baseUrl || "").toLowerCase();

  // 针对 tiantianai.pro 做兼容：它在很多示例里是直接 Authorization: sk-xxx
  if (lower.includes("tiantianai.pro")) {
    return { Authorization: key };
  }

  // 其他默认走 OpenAI 规范：Authorization: Bearer xxx
  let auth = key;
  if (!/^bearer\s+/i.test(auth)) {
    auth = `Bearer ${auth}`;
  }
  return { Authorization: auth };
}

/* ========== 1. 获取 / 初始化配置 ========== */
export function getApiConfigContext() {
  const ctx = getContextSafe();
  if (!ctx) {
    if (!window.__YBM_PHONE_API_STORE__) {
      window.__YBM_PHONE_API_STORE__ = { apiConfig: { ...DEFAULT_CONFIG } };
    }
    return {
      ctx: null,
      settingsRef: window.__YBM_PHONE_API_STORE__,
      apiConfig: window.__YBM_PHONE_API_STORE__.apiConfig,
      saveSettingsDebounced: () => {},
    };
  }

  if (!ctx.extension_settings) ctx.extension_settings = {};
  if (!ctx.extension_settings[EXT_ID]) {
    ctx.extension_settings[EXT_ID] = { apiConfig: { ...DEFAULT_CONFIG } };
  } else if (!ctx.extension_settings[EXT_ID].apiConfig) {
    ctx.extension_settings[EXT_ID].apiConfig = { ...DEFAULT_CONFIG };
  }

  const settingsRef = ctx.extension_settings[EXT_ID];
  let apiConfig = settingsRef.apiConfig;

  // localStorage 合并一次
  try {
    const raw = window.localStorage?.getItem(LS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved === "object") {
        apiConfig = settingsRef.apiConfig = {
          ...DEFAULT_CONFIG,
          ...apiConfig,
          ...saved,
        };
      }
    }
  } catch (e) {
    console.warn("[外置手机][API] 读取 localStorage 失败：", e);
  }

  const saveSettingsDebounced =
    typeof ctx.saveSettingsDebounced === "function"
      ? ctx.saveSettingsDebounced
      : () => {};

  return {
    ctx,
    settingsRef,
    apiConfig,
    saveSettingsDebounced,
  };
}

export function getApiConfigSafe() {
  const c = getApiConfigContext();
  return c ? c.apiConfig : null;
}

function persistApiConfig(apiCtx) {
  if (!apiCtx) return;
  try {
    apiCtx.settingsRef.apiConfig = { ...apiCtx.apiConfig };
    apiCtx.saveSettingsDebounced();
  } catch (e) {
    console.warn("[外置手机][API] 保存到 ST 失败：", e);
  }

  try {
    window.localStorage?.setItem(LS_KEY, JSON.stringify(apiCtx.apiConfig));
  } catch (e) {
    console.warn("[外置手机][API] 写入 localStorage 失败：", e);
  }
}

/* ========== 2. 递归 + 遍历抽取文本（尽量不空手而归） ========== */

/** 优先按 OpenAI / Gemini 规则从当前对象挖一段文本 */
function _extractFromSingle(data) {
  if (!data || typeof data !== "object") return null;

  // 1) 标准 OpenAI：choices[0].message.content
  const choices = Array.isArray(data.choices) ? data.choices : null;
  const c0 = choices && choices.length > 0 ? choices[0] : null;
  if (c0) {
    if (c0.message && c0.message.content != null) {
      const c = c0.message.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        const txt = c
          .map((p) =>
            typeof p === "string"
              ? p
              : p && typeof p.text === "string"
              ? p.text
              : ""
          )
          .join("\n")
          .trim();
        if (txt) return txt;
      }
    }
    if (typeof c0.content === "string") return c0.content;
  }

  // 2) Gemini：candidates[0].content.parts[*].text
  if (Array.isArray(data.candidates) && data.candidates[0]) {
    const cand = data.candidates[0];
    const parts = cand.content?.parts || cand.parts;
    if (Array.isArray(parts)) {
      const txt = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();
      if (txt) return txt;
    }
  }

  // 3) 常见兜底字段
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.result === "string") return data.result;
  if (typeof data.text === "string") return data.text;
  if (typeof data.response === "string") return data.response;

  return null;
}

/**
 * 递归 + 深度优先遍历：
 *  - 先用 _extractFromSingle 按常见结构抽
 *  - 再在 data / data.data / result 等里面一层层找
 *  - 最后退而求其次：找第一个像样的字符串
 */
function extractTextFromResponse(data) {
  if (!data || typeof data !== "object") return null;

  const visited = new Set();
  const preferKeys = ["content", "text", "message", "output", "result", "response"];

  function dfs(node, depth) {
    if (!node || typeof node !== "object") return null;
    if (depth > 6) return null; // 防止太深
    if (visited.has(node)) return null; // 防止循环引用
    visited.add(node);

    // 1) 优先按常见结构试一遍
    const direct = _extractFromSingle(node);
    if (direct && String(direct).trim()) return String(direct);

    // 2) 优先看几类 key
    for (const key of preferKeys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const v = node[key];
        if (typeof v === "string" && v.trim()) return v;
        if (Array.isArray(v)) {
          const txt = v
            .map((p) =>
              typeof p === "string"
                ? p
                : p && typeof p.text === "string"
                ? p.text
                : ""
            )
            .join("\n")
            .trim();
          if (txt) return txt;
        }
      }
    }

    // 3) data / result 优先往里钻
    if (node.data && typeof node.data === "object") {
      const inner = node.data;
      if (Array.isArray(inner)) {
        for (const item of inner) {
          const r = dfs(item, depth + 1);
          if (r) return r;
        }
      } else {
        const r = dfs(inner, depth + 1);
        if (r) return r;
      }
    }
    if (node.result && typeof node.result === "object") {
      const r = dfs(node.result, depth + 1);
      if (r) return r;
    }

    // 4) 通用 DFS：找第一个字符串
    for (const [, v] of Object.entries(node)) {
      if (typeof v === "string" && v.trim()) return v;
      if (Array.isArray(v)) {
        for (const item of v) {
          const r = dfs(item, depth + 1);
          if (r) return r;
        }
      } else if (typeof v === "object") {
        const r = dfs(v, depth + 1);
        if (r) return r;
      }
    }

    return null;
  }

  return dfs(data, 0);
}

/* ========== 3. 通用调用 ========== */
/**
 * opts:
 *  - feature?: string
 *  - messages: {role, content}[]
 *  - max_tokens?: number
 *  - temperature?: number
 *  - top_p?: number
 */
export async function callToolApi(opts) {
  const cfg = getApiConfigSafe();
  if (!cfg) {
    console.warn("[外置手机][API] 未能获取配置");
    return null;
  }

  if (!cfg.baseUrl || !opts || !Array.isArray(opts.messages)) {
    console.warn(
      "[外置手机][API] baseUrl 未配置或 messages 非数组，回退本地模板"
    );
    return null;
  }

  let url = cfg.baseUrl.trim();
  if (!url) {
    console.warn("[外置手机][API] baseUrl 为空");
    return null;
  }

  const model = (cfg.model && cfg.model.trim()) || "gpt-4.1-mini";
  const maxTokens =
    typeof opts.max_tokens === "number" && opts.max_tokens > 0
      ? opts.max_tokens
      : 512;
  const feature = opts.feature || "unknown-tool";

  console.debug("[外置手机][API] 调用 URL:", url);
  console.debug("[外置手机][API] feature:", feature);

  const headers = {
    "Content-Type": "application/json",
    "X-YBM-From": "ybm-external-phone",
    "X-YBM-Phone-Feature": feature,
    ...buildAuthHeader(url, cfg.apiKey),
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: maxTokens,
        temperature:
          typeof opts.temperature === "number" ? opts.temperature : 0.7,
        top_p: typeof opts.top_p === "number" ? opts.top_p : 0.95,
        stream: false,
      }),
    });

    if (!resp.ok) {
      console.warn(
        "[外置手机][API] HTTP error:",
        resp.status,
        resp.statusText
      );
      return null;
    }

    const data = await resp.json();
    const text = extractTextFromResponse(data);

    if (!text) {
      console.warn("[外置手机][API] 返回中没有可用文本，raw data 如下：");
      console.log(data);
      try {
        console.log("[外置手机][API] RAW STRING:", JSON.stringify(data));
      } catch (e) {
        // ignore
      }
      return null;
    }

    const trimmed = String(text).trim();
    console.debug("[外置手机][API] 响应片段:", trimmed.slice(0, 120));

    return trimmed;
  } catch (e) {
    console.error("[外置手机][API] 调用异常：", e);
    return null;
  }
}

/* ========== 4. API 设置界面 ========== */
export function renderApiSettingsScreen() {
  const container = document.getElementById("ybm-nokia-placeholder-view");
  if (!container) return;

  const apiCtx = getApiConfigContext();
  const apiCfg = apiCtx.apiConfig;

  container.innerHTML = `
    <div class="ybm-api-settings">
      <div class="ybm-api-section">
        <div class="ybm-api-section-title">自定义 API 配置</div>

        <div class="ybm-api-field">
          <label>配置名称</label>
          <input id="ybm-api-name" placeholder="例如：本地代理">
        </div>

        <div class="ybm-api-field">
          <label>API 端点</label>
          <input id="ybm-api-base" placeholder="例如：https://你的域名/v1/chat/completions">
        </div>

        <div class="ybm-api-field">
          <label>API 密钥</label>
          <div class="ybm-api-field-inline">
            <input id="ybm-api-key" type="password" placeholder="sk-...（可留空）">
            <button id="ybm-api-key-toggle">👁</button>
          </div>
        </div>

        <div class="ybm-api-field">
          <label>模型</label>
          <div class="ybm-api-field-inline">
            <select id="ybm-api-model-select">
              <option value="">（不指定）</option>
              <option value="gpt-4.1-mini">gpt-4.1-mini</option>
              <option value="gpt-4.1">gpt-4.1</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
              <option value="deepseek-chat">deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
              <option value="__manual__">手动输入...</option>
            </select>
            <button id="ybm-api-model-refresh">刷新</button>
          </div>
          <div id="ybm-api-model-manual" style="display:none;">
            <input id="ybm-api-model-input" placeholder="自定义模型名">
          </div>
        </div>

        <div class="ybm-api-actions">
          <button id="ybm-api-test">测试</button>
          <span id="ybm-api-test-status"></span>
        </div>
      </div>

      <div class="ybm-api-section">
        <p>提示：查手机等功能会优先使用这里配置的自定义 API。</p>
        <p>为稳定起见，请直接填写完整的 chat 接口（例如：<code>/v1/chat/completions</code>）。</p>
      </div>
    </div>
  `;

  const $ = (sel) => container.querySelector(sel);

  const nameInput = $("#ybm-api-name");
  const baseInput = $("#ybm-api-base");
  const keyInput = $("#ybm-api-key");
  const keyToggle = $("#ybm-api-key-toggle");
  const modelSelect = $("#ybm-api-model-select");
  const modelManualWrap = $("#ybm-api-model-manual");
  const modelInput = $("#ybm-api-model-input");
  const refreshBtn = $("#ybm-api-model-refresh");
  const testBtn = $("#ybm-api-test");
  const statusEl = $("#ybm-api-test-status");

  nameInput.value = apiCfg.name || "";
  baseInput.value = apiCfg.baseUrl || "";
  keyInput.value = apiCfg.apiKey || "";

  nameInput.oninput = () => {
    apiCfg.name = nameInput.value.trim();
    persistApiConfig(apiCtx);
  };
  baseInput.oninput = () => {
    apiCfg.baseUrl = baseInput.value.trim();
    persistApiConfig(apiCtx);
  };
  keyInput.oninput = () => {
    apiCfg.apiKey = keyInput.value.trim();
    persistApiConfig(apiCtx);
  };
  keyToggle.onclick = () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  };

  // 模型初始化
  if (apiCfg.model) {
    let matched = false;
    for (const opt of modelSelect.options) {
      if (opt.value === apiCfg.model) {
        modelSelect.value = apiCfg.model;
        matched = true;
        break;
      }
    }
    if (!matched) {
      modelSelect.value = "__manual__";
      modelManualWrap.style.display = "block";
      modelInput.value = apiCfg.model;
    } else {
      modelInput.value = apiCfg.model;
      modelManualWrap.style.display = "none";
    }
  }

  modelSelect.onchange = () => {
    if (modelSelect.value === "__manual__") {
      modelManualWrap.style.display = "block";
    } else {
      modelManualWrap.style.display = "none";
      apiCfg.model = modelSelect.value || "";
      modelInput.value = apiCfg.model;
      persistApiConfig(apiCtx);
    }
  };

  modelInput.oninput = () => {
    apiCfg.model = modelInput.value.trim();
    persistApiConfig(apiCtx);
  };

  // 刷新模型列表
  refreshBtn.onclick = async () => {
    const cfg = getApiConfigSafe();
    if (!cfg || !cfg.baseUrl) {
      statusEl.textContent = "请先填写 API 端点";
      return;
    }

    let url = cfg.baseUrl.trim();
    if (url.includes("/chat/completions")) {
      url = url.replace("/chat/completions", "/models");
    } else if (url.endsWith("/v1")) {
      url = url + "/models";
    } else if (!url.endsWith("/models")) {
      url = url.replace(/\/$/, "") + "/models";
    }

    statusEl.textContent = "刷新中…";

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: buildAuthHeader(url, cfg.apiKey),
      });

      if (!resp.ok) {
        statusEl.textContent = `刷新失败：HTTP ${resp.status}`;
        return;
      }

      const data = await resp.json();
      const models = Array.isArray(data.data)
        ? data.data.map((m) => m.id).filter(Boolean)
        : [];

      if (!models.length) {
        statusEl.textContent = "未获取到模型列表";
        return;
      }

      modelSelect.innerHTML = "";
      const addOpt = (v, t) => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = t;
        modelSelect.appendChild(opt);
      };

      addOpt("", "（不指定）");
      models.forEach((id) => addOpt(id, id));
      addOpt("__manual__", "手动输入...");

      statusEl.textContent = `刷新成功：${models.length} 个模型`;
    } catch (e) {
      console.error("[外置手机][API] 刷新模型异常：", e);
      statusEl.textContent = "刷新失败：异常";
    }
  };

  // 测试按钮
  testBtn.onclick = async () => {
    statusEl.textContent = "测试中…";
    const text = await callToolApi({
      feature: "test",
      messages: [
        { role: "system", content: "你是一个测试助手。" },
        {
          role: "user",
          content: '这是来自外置手机的测试请求，请只回复“OK”。',
        },
      ],
      max_tokens: 8,
    });

    if (!text) {
      statusEl.textContent = "测试失败：无响应或解析失败";
    } else {
      statusEl.textContent = `测试成功：${text.slice(0, 20)}`;
    }
  };
}
