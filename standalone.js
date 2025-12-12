// mobile/standalone.js —— 独立网页入口

import { createPhonePanel } from "./ui.js";

function openPhoneAndShowApi() {
  // 创建手机面板（如果还没创建的话）
  createPhonePanel();
  const panel = document.getElementById("ybm-phone-panel");
  if (!panel) return;

  panel.style.display = "block";

  // 自动点进“设置（API）”图标
  const apiIcon = panel.querySelector('.ybm-home-icon[data-app="api"]');
  if (apiIcon) {
    apiIcon.click();
  }

  // 可选：隐藏首页介绍
  const appRoot = document.getElementById("app");
  if (appRoot) appRoot.style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("open-phone");
  if (btn) {
    btn.addEventListener("click", () => {
      openPhoneAndShowApi();
    });
  } else {
    // 没按钮就直接打开
    openPhoneAndShowApi();
  }
});
