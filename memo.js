// memo.js —— 查手机预设（不再直接调外部 API）
//
// 当前版本的“偷看手机”逻辑：
// - ui.js 在玩家点击「偷看」时，直接往酒馆主对话里发送一条带有 PHONE_PREFIX 的请求；
// - 由当前角色使用主模型，一次性写出四个人的手机内容；
// - ui.js 轮询主对话，把这段回复偷出来显示在手机界面中。
// 本文件只提供一些角色相关的配置和（可选的）prompt 帮助函数，
// 方便你以后在“设置”模块里做更细的预设与格式控制。

// ===================== 角色基础配置 =====================

export const MEMO_CHAR_CONFIG = {
  yan: {
    key: "yan",
    name: "岩白眉",
    smsPartners: ["金厅经理阿明", "世纪酒店财务", "达班猜叔的联系"],
    moneyTags: ["筹码回笼", "借调备用金", "房账结算", "押金返还"],
    memoTags: ["账目提醒", "待处理事项", "对某人的观察"],
  },
  cai: {
    key: "cai",
    name: "猜叔",
    smsPartners: ["山上伙头", "司机老宋", "边水下游联系人"],
    moneyTags: ["生活物资", "押车费用", "辛苦费"],
    memoTags: ["补货清单", "注意路线", "照顾兄弟"],
  },
  dantuo: {
    key: "dantuo",
    name: "但拓",
    smsPartners: ["边水兄弟", "陈会长手下", "山下诊所"],
    moneyTags: ["护送费", "兄弟医药费", "欠条"],
    memoTags: ["路线记号", "危险路段", "兄弟状况"],
  },
  zhoubin: {
    key: "zhoubin",
    name: "州槟",
    smsPartners: ["伐木场账房", "手下老五", "木材买家"],
    moneyTags: ["雇佣费", "工资", "补贴"],
    memoTags: ["伐木计划", "天气与地形", "人员安排"],
  },
};

// ===================== 可选：统一构造“四人手机内容”提示词 =====================
//
// 目前 ui.js 里是直接内联 prompt 的，如果你以后想把 prompt 挪出来统一管理，
// 可以改成在 ui.js 里调用 buildAllCharsMemoPrompt(snippets) 来生成文本。

export function buildAllCharsMemoPrompt(snippets) {
  const ctxText = Array.isArray(snippets) ? snippets.join("\n\n") : (snippets || "");
  return `
你现在在偷偷整理四个人此刻手机里的内容：岩白眉、猜叔、但拓、州槟。
请你分别用他们的第一人称写出：
- 最近来往短信
- 最近的心情与心事
- 近期账目/款项往来
- 随手记下的备忘录

输出格式示例（务必按这种结构分段）：
【岩白眉】
（这里是他的手机内容，可以是多行）
【猜叔】
（这里是他的手机内容）
【但拓】
……
【州槟】
……

如果有帮助，你可以参考最近的对话氛围（可能为空）：
${ctxText}
`.trim();
}
