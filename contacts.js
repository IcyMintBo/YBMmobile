/**
 * contacts.js - YBMPhone.Contacts
 *
 * 职责：
 * - 管理联系人列表（含 charId 绑定）
 * - 在 settingsRef.contacts 中存储
 *   每个联系人：
 *   {
 *     id: "uuid-xxx",
 *     name: "岩白眉",
 *     charId: "char-xxxx",   // SillyTavern 角色 card 的 id（暂时占位）
 *   }
 */

// 简单本地 uuid 生成
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class YBMPhoneContacts {
  /**
   * @param {Object} deps
   * @param {string} deps.EXT_ID
   * @param {import('./core.js').YBMPhoneCore} deps.core
   * @param {Object} deps.settingsRef
   * @param {Function} deps.saveSettingsDebounced
   * @param {import('./storage.js').YBMPhoneStorage} deps.storage
   */
  constructor({ EXT_ID, core, settingsRef, saveSettingsDebounced, storage }) {
    this.EXT_ID = EXT_ID;
    this.core = core;
    this.settingsRef = settingsRef;
    this.saveSettingsDebounced = saveSettingsDebounced;
    this.storage = storage;

    if (!Array.isArray(this.settingsRef.contacts)) {
      this.settingsRef.contacts = [];
    }

    if (!this.settingsRef.currentContactId && this.settingsRef.contacts.length > 0) {
      this.settingsRef.currentContactId = this.settingsRef.contacts[0].id;
    }
  }

  // ========== 基础访问 ==========

  getAllContacts() {
    return this.settingsRef.contacts;
  }

  getCurrentContactId() {
    return this.settingsRef.currentContactId || null;
  }

  getCurrentContact() {
    const id = this.getCurrentContactId();
    if (!id) return null;
    return this.settingsRef.contacts.find((c) => c.id === id) || null;
  }

  setCurrentContactId(id) {
    this.settingsRef.currentContactId = id || null;
    this.saveSettingsDebounced();
  }

  // ========== 预设核心联系人（四个主要人物） ==========

  /**
   * 使用固定 id 新增或更新联系人，用于预设人物（岩白眉 / 猜叔 / 但拓 / 州槟）
   * - 如果 id 已存在，则只做 name/charId 更新，不再重复添加
   */
  addContactFixedId(fixedId, { name, charId = null } = {}) {
    if (!fixedId) return null;

    // 已存在则更新
    const existed = this.settingsRef.contacts.find((c) => c.id === fixedId);
    if (existed) {
      if (typeof name === "string" && name) {
        existed.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(arguments[1] || {}, "charId")) {
        existed.charId = charId || null;
      }
      this.saveSettingsDebounced();
      this.core.logInfo("[Contacts] 更新预设联系人:", existed);
      return existed;
    }

    // 不存在则新增
    const contact = {
      id: fixedId,
      name: name || "未命名联系人",
      charId: charId || null,
    };

    this.settingsRef.contacts.push(contact);

    if (!this.settingsRef.currentContactId) {
      this.settingsRef.currentContactId = fixedId;
    }

    this.saveSettingsDebounced();
    this.core.logInfo("[Contacts] 新增预设联系人:", contact);
    return contact;
  }

  /**
   * 确保四个核心人物联系人已存在：
   * - 岩白眉 (yan_baimei)
   * - 猜叔   (cai_shu)
   * - 但拓   (dan_tuo)
   * - 州槟   (zhou_bin)
   *
   * 不会覆盖你手动添加的其他联系人，
   * 如果这些 id 已经存在，会只更新显示名。
   */
  ensureDefaultCoreContacts() {
    const presets = [
      { id: "yan_baimei", name: "岩白眉" },
      { id: "cai_shu", name: "猜叔" },
      { id: "dan_tuo", name: "但拓" },
      { id: "zhou_bin", name: "州槟" },
    ];

    presets.forEach((preset) => {
      this.addContactFixedId(preset.id, { name: preset.name });
    });

    // 如果仍然没有当前联系人，就用第一个
    if (!this.settingsRef.currentContactId && this.settingsRef.contacts.length > 0) {
      this.settingsRef.currentContactId = this.settingsRef.contacts[0].id;
      this.saveSettingsDebounced();
    }
  }

  // ========== 增删改查 ==========

  addContact({ name, charId = null }) {
    const id = uuidv4();
    const contact = {
      id,
      name: name || "未命名联系人",
      charId: charId || null,
    };

    this.settingsRef.contacts.push(contact);

    if (!this.settingsRef.currentContactId) {
      this.settingsRef.currentContactId = id;
    }

    this.saveSettingsDebounced();
    this.core.logInfo("[Contacts] 新增联系人:", contact);

    return contact;
  }

  removeContact(id) {
    if (!id) return;

    const idx = this.settingsRef.contacts.findIndex((c) => c.id === id);
    if (idx !== -1) {
      const removed = this.settingsRef.contacts.splice(idx, 1)[0];

      if (this.storage && typeof this.storage.clearHistory === "function") {
        this.storage.clearHistory(id);
      }

      if (this.settingsRef.currentContactId === id) {
        if (this.settingsRef.contacts.length > 0) {
          this.settingsRef.currentContactId = this.settingsRef.contacts[0].id;
        } else {
          this.settingsRef.currentContactId = null;
        }
      }

      this.saveSettingsDebounced();
      this.core.logInfo("[Contacts] 删除联系人:", removed);
    }
  }

  updateContact(id, payload) {
    const c = this.settingsRef.contacts.find((c) => c.id === id);
    if (!c) return;

    if (typeof payload.name === "string") {
      c.name = payload.name;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "charId")) {
      c.charId = payload.charId || null;
    }

    this.saveSettingsDebounced();
  }

  findByCharId(charId) {
    if (!charId) return null;
    return this.settingsRef.contacts.find((c) => c.charId === charId) || null;
  }

  /**
   * 确保当前 SillyTavern 角色有对应联系人：
   * - 根据 charId 查找，如果存在则设置为当前联系人
   * - 否则新建一个联系人（名字用 charName）
   */
  ensureContactForCurrentChar() {
    const { charId, charName } = this.core.getCurrentCharInfo();

    if (!charId && !charName) {
      return null;
    }

    let contact = this.findByCharId(charId);
    if (contact) {
      this.setCurrentContactId(contact.id);
      return contact;
    }

    contact = this.addContact({
      name: charName || "角色联系人",
      charId: charId || null,
    });

    this.setCurrentContactId(contact.id);
    return contact;
  }
}
