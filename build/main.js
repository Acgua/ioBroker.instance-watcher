var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  InstanceWatcher: () => InstanceWatcher
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_cron_parser = require("cron-parser");
var import_node_schedule = require("node-schedule");
var import_methods = require("./lib/methods");
/**
 * -------------------------------------------------------------------
 *
 *  ioBroker Instance Watcher Adapter
 *
 * @github  https://github.com/Acgua/ioBroker.instance-watcher
 * @forum   https://forum.iobroker.net/topic/XXXXX/
 * @author  Acgua <https://github.com/Acgua/ioBroker.instance-watcher>
 * @created Adapter Creator v2.1.1, on 27 August 2022
 * @license Apache License 2.0
 *
 * -------------------------------------------------------------------
 */
class InstanceWatcher extends utils.Adapter {
  constructor(options = {}) {
    super({ ...options, name: "instance-watcher" });
    this._inst = {
      list: [],
      objs: {},
      enoList: [],
      enoSummaryLog: void 0
    };
    this.regexValidInstance = /[a-z][a-z0-9\-_]*.[0-9]{1,2}$/;
    this.schedules = {};
    this.cronParseExpression = import_cron_parser.parseExpression;
    this.nodeScheduleScheduleJob = import_node_schedule.scheduleJob;
    this.err2Str = import_methods.err2Str.bind(this);
    this.isEmpty = import_methods.isEmpty.bind(this);
    this.wait = import_methods.wait.bind(this);
    this.getPreviousCronRun = import_methods.getPreviousCronRun.bind(this);
    this.asyncInstanceOnOff = import_methods.asyncInstanceOnOff.bind(this);
    this.dateToLocalIsoString = import_methods.dateToLocalIsoString.bind(this);
    this.on("ready", this._asyncOnReady.bind(this));
    this.on("stateChange", this._asyncOnStateChange.bind(this));
    this.on("objectChange", this._asyncOnObjectChange.bind(this));
    this.on("unload", this._onUnload.bind(this));
  }
  async _asyncOnReady() {
    try {
      if (!this.config.maxlog_summary || this.config.maxlog_summary < 1) {
        this.log.debug(`maxlog_summary in config is deactivated, so do not log in summary state`);
        this.config.maxlog_summary = 0;
      }
      if (!this.config.maxlog_inst || this.config.maxlog_inst < 1) {
        this.log.debug(`maxlog_inst in config is deactivated, so do not log in instance states`);
        this.config.maxlog_inst = 0;
      }
      if (!this.config.queue_delay || this.config.queue_delay < 1) {
        this.config.queue_delay = 0;
      }
      this._inst.objs = await this.asyncGetAllInstancesObjects();
      if (this.isEmpty(this._inst.objs))
        throw "Failed to get ioBroker adapter instances information.";
      this._inst.list = Object.keys(this._inst.objs).sort();
      if (!await this.createObjectsAsync())
        throw "Failed to create objects with createObjectsAsync()";
      if (this.config.maxlog_summary) {
        const logObj = await this.getStateAsync("summary.enoSummaryLog");
        if (logObj && logObj.val && typeof logObj.val === "string" && logObj.val.length > 20) {
          this._inst.enoSummaryLog = JSON.parse(logObj.val);
        }
      }
      if (this.config.maxlog_inst) {
        for (const id of this._inst.list) {
          const logObj = await this.getStateAsync(`instances.${id}.enoLog`);
          if (logObj && logObj.val && typeof logObj.val === "string" && logObj.val.length > 20) {
            this._inst.enoSummaryLog = JSON.parse(logObj.val);
          }
        }
      }
      for (const id of this._inst.list) {
        await this._asyncUpdateInstanceInfo(id);
      }
      await this.updateOperatingStates("all");
      for (const id of this._inst.list) {
        await this.setStateAsync(`instances.${id}.mode`, { val: this._inst.objs[id].mode, ack: true });
      }
      for (const id of this._inst.list) {
        await this.subscribeForeignObjectsAsync(`system.adapter.${id}`);
        await this.subscribeForeignStatesAsync(`system.adapter.${id}.alive`);
        if (this._inst.objs[id].mode === "daemon") {
          await this.subscribeForeignStatesAsync(`system.adapter.${id}.connected`);
          if (this._inst.objs[id].connected_with_device_service !== void 0) {
            await this.subscribeForeignStatesAsync(`${id}.info.connection`);
          }
        }
        await this.subscribeStatesAsync(`instances.${id}.enabled`);
        await this.subscribeStatesAsync(`instances.${id}.on`);
        await this.subscribeStatesAsync(`instances.${id}.off`);
      }
      await this.scheduleScheduleInstancesUpdate();
      this.log.debug(`${this._inst.list.length} instances initialized: ${JSON.stringify(this._inst.list)}`);
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async asyncUpdateQueue(id) {
    try {
      if (this._inst.objs[id]._noUpdate === true)
        return;
      if (this._inst.objs[id]._recentChange >= Date.now() - this.config.queue_delay) {
        this._inst.objs[id]._noUpdate = true;
        this._inst.objs[id]._recentChange = Date.now();
        await this.wait(this.config.queue_delay + 10);
        this._inst.objs[id]._noUpdate = false;
        this.asyncUpdateQueue(id);
      } else {
        this._inst.objs[id]._recentChange = Date.now();
        this._inst.objs[id]._noUpdate = false;
        this.log.debug(`asyncUpdateQueue(${id}): Queue completed and update started.`);
        await this._asyncUpdateInstanceInfo(id);
        await this.updateOperatingStates(id);
      }
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async scheduleScheduleInstancesUpdate() {
    try {
      for (const id of this._inst.list) {
        if (this._inst.objs[id].mode !== "schedule")
          continue;
        const rule = this._inst.objs[id].schedule;
        if (!rule || rule.length < 2) {
          this.log.error(`No schedule defined for schedule adapter instance ${id}`);
          continue;
        }
        this.schedules[id] = this.nodeScheduleScheduleJob(rule, async () => {
          await this.wait(30 * 1e3);
          await this.asyncUpdateQueue(id);
          this.log.debug(`${id}: ScheduleJob() executed (+30sec) per schedule '${rule}' of this schedule instance.`);
        });
      }
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async _asyncUpdateInstanceInfo(id) {
    try {
      if (!this._inst.objs[id])
        throw `Instance ${id} not available in instanceObjects`;
      let isOperating = false;
      const obj = await this.getForeignObjectAsync(`system.adapter.${id}`);
      if (!obj || !obj.common || typeof obj.common.enabled !== "boolean" || obj.common.enabled === void 0)
        throw `Could not get common.enabled of object 'system.adapter.${id}'.`;
      this._inst.objs[id].enabled = obj.common.enabled;
      if (!this._inst.objs[id].enabled) {
        isOperating = false;
      } else {
        if (this._inst.objs[id].mode === "daemon") {
          const obj2 = await this.getForeignStateAsync(`system.adapter.${id}.alive`);
          if (!obj2 || obj2.val === null || typeof obj2.val !== "boolean" || obj2.val === void 0)
            throw `Could not get state value of 'system.adapter.${id}.alive'.`;
          this._inst.objs[id].alive = obj2.val;
          isOperating = obj2.val;
          if (isOperating) {
            const obj3 = await this.getForeignStateAsync(`system.adapter.${id}.connected`);
            if (!obj3 || obj3.val === null || typeof obj3.val !== "boolean" || obj3.val === void 0)
              throw `Could not get state value of 'system.adapter.${id}.connected'.`;
            this._inst.objs[id].connected_with_host = obj3.val;
            isOperating = obj3.val;
            if (isOperating) {
              if (await this.getForeignObjectAsync(`${id}.info.connection`)) {
                const obj4 = await this.getForeignStateAsync(`${id}.info.connection`);
                if (!obj4 || obj4.val === null || typeof obj4.val !== "boolean" || obj4.val === void 0)
                  throw `Could not get state value of '${id}.info.connection'.`;
                this._inst.objs[id].connected_with_device_service = obj4.val;
                isOperating = obj4.val;
              }
            }
          }
        } else if (this._inst.objs[id].mode === "schedule") {
          const objIsAlive = await this.getForeignStateAsync(`system.adapter.${id}.alive`);
          if (!objIsAlive || typeof objIsAlive.ts !== "number")
            throw `Could not get timestamp of state 'system.adapter.${id}.alive'.`;
          const lastUpdateSecsAgo = Math.floor((Date.now() - objIsAlive.ts) / 1e3);
          const sched = this._inst.objs[id].schedule;
          if (sched === void 0 || sched.length < 1)
            throw `Could not get schedule of schedule adapter instance '${id}`;
          const previousCronRun = this.getPreviousCronRun(sched);
          if (previousCronRun === -1)
            throw `Could not get previous Cron run of schedule adapter instance '${id} for schedule '${sched}'`;
          const lastCronRunSecs = Math.floor(previousCronRun / 1e3);
          const diff = lastCronRunSecs - lastUpdateSecsAgo;
          isOperating = diff > -300 ? true : false;
        }
      }
      if (this._inst.objs[id].enabled && !isOperating) {
        if (this.config.maxlog_summary)
          this._inst.enoSummaryLog = this.getUpdateLog(id, this._inst.enoSummaryLog, "not operating", this.config.maxlog_summary);
        if (this.config.maxlog_inst)
          this._inst.objs[id].enoLog = this.getUpdateLog(id, this._inst.objs[id].enoLog, "not operating", this.config.maxlog_inst);
        if (!this._inst.enoList.includes(id)) {
          this._inst.enoList.push(id);
          this._inst.enoList.sort();
        }
      } else {
        const status = this._inst.objs[id].enabled ? "operating" : "turned off";
        if (this.config.maxlog_summary)
          this._inst.enoSummaryLog = this.getUpdateLog(id, this._inst.enoSummaryLog, status, this.config.maxlog_summary);
        if (this.config.maxlog_inst)
          this._inst.objs[id].enoLog = this.getUpdateLog(id, this._inst.objs[id].enoLog, status, this.config.maxlog_inst);
        this._inst.enoList = this._inst.enoList.filter((e) => e !== id);
        this._inst.enoList.sort();
      }
      this._inst.objs[id].isOperating = isOperating;
      return isOperating;
    } catch (e) {
      this.log.error(this.err2Str(e));
      return false;
    }
  }
  getUpdateLog(id, currentLog, status, max) {
    try {
      let prevStatus = "";
      if (currentLog && currentLog.length > 0) {
        for (const line of currentLog) {
          if (line.instance == id) {
            prevStatus = line.status;
            break;
          }
        }
      }
      let addToLog = false;
      if (prevStatus === "" && status === "not operating")
        addToLog = true;
      if (prevStatus !== "" && prevStatus !== status)
        addToLog = true;
      if (!addToLog)
        return currentLog;
      const logEntry = {
        date: this.dateToLocalIsoString(new Date()),
        instance: id,
        status,
        timestamp: Date.now()
      };
      if (!currentLog || currentLog.length === 0)
        return [logEntry];
      if (currentLog.length >= max)
        currentLog.length = max - 1;
      return [logEntry].concat(currentLog);
    } catch (e) {
      this.log.error(this.err2Str(e));
      return currentLog;
    }
  }
  async asyncGetAllInstancesObjects() {
    try {
      const objViewSystemInst = await this.getObjectViewAsync("system", "instance", null);
      if (!objViewSystemInst.rows)
        throw `Error: object.rows of returned object is not defined.`;
      const blacklist = [];
      const invalidBl = [];
      if (this.config.blacklist) {
        let x = this.config.blacklist;
        this.log.debug(`Blacklist: From user configuration: ${x}`);
        x = x.toLowerCase();
        x = x.replace(/;+/g, ",");
        x = x.replace(/[^0-9a-z-._,]/g, "");
        x = x.replace(/,+/g, ",");
        x = x.replace(/(^,)|(,$)/g, "");
        this.log.debug(`Blacklist: Cleaned: ${x}`);
        const xArray = x.split(",");
        for (const itm of xArray) {
          if (itm === "")
            continue;
          if (this.regexValidInstance.test(itm)) {
            blacklist.push(itm);
          } else {
            invalidBl.push(itm);
          }
        }
      }
      if (invalidBl.length > 0)
        this.log.warn(`Blacklist: ${invalidBl.length} invalid ${invalidBl.length > 1 ? "entries" : "entry"} in your settings, which will be ignored: ${invalidBl.join(",")}`);
      const returnObj = {};
      for (const row of objViewSystemInst.rows) {
        const instId = row.id.slice(15);
        if (!this.regexValidInstance.test(instId))
          throw `Instance "${instId}" is not valid! - source id: "${row.id}"`;
        if (!row.value || !row.value.common)
          throw `row.value of instance ${instId} is not defined.`;
        if (instId === this.namespace)
          continue;
        if (!["daemon", "schedule"].includes(row.value.common.mode))
          continue;
        if (blacklist.includes(instId)) {
          this.log.debug(`Blacklist: Instance ${instId} successfully ignored per blacklist settings.`);
          continue;
        }
        returnObj[instId] = {
          id: instId,
          mode: row.value.common.mode,
          enabled: row.value.common.enabled,
          schedule: row.value.common.mode === "schedule" && row.value.common.schedule ? row.value.common.schedule : void 0,
          _recentChange: Date.now(),
          _noUpdate: false
        };
      }
      if (this.isEmpty(returnObj))
        throw "Error getting instance objects: No adapter instance found within ioBroker!";
      return returnObj;
    } catch (e) {
      this.log.error(this.err2Str(e));
      return {};
    }
  }
  async updateOperatingStates(what) {
    try {
      await this.setStateChangedAsync("summary.enoCount", { val: this._inst.enoList.length, ack: true });
      await this.setStateChangedAsync("summary.enoList", { val: JSON.stringify(this._inst.enoList), ack: true });
      if (this.config.maxlog_summary)
        await this.setStateChangedAsync("summary.enoSummaryLog", { val: JSON.stringify(this._inst.enoSummaryLog), ack: true });
      await this.setStateAsync("info.updatedDate", { val: Date.now(), ack: true });
      let list = [];
      if (what === "all") {
        list = this._inst.list;
      } else if (this._inst.list.includes(what)) {
        list.push(what);
      } else {
        throw `Given parameter '${what}' is not valid!`;
      }
      for (const id of list) {
        await this.setStateAsync(`instances.${id}.isOperating`, { val: this._inst.objs[id].isOperating, ack: true });
        await this.setStateAsync(`instances.${id}.enabled`, { val: this._inst.objs[id].enabled, ack: true });
        if (this.config.maxlog_inst)
          await this.setStateChangedAsync(`instances.${id}.enoLog`, { val: JSON.stringify(this._inst.objs[id].enoLog), ack: true });
        if (this._inst.objs[id].enabled) {
          await this.setStateAsync(`instances.${id}.on`, { val: true, ack: true });
          await this.setStateAsync(`instances.${id}.off`, { val: false, ack: true });
        } else {
          await this.setStateAsync(`instances.${id}.on`, { val: false, ack: true });
          await this.setStateAsync(`instances.${id}.off`, { val: true, ack: true });
        }
      }
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async _asyncOnObjectChange(objId, obj) {
    try {
      if (!obj)
        return;
      const idParts = objId.split(".");
      const id = idParts[2] + "." + idParts[3];
      if (!this._inst.list.includes(id))
        throw `Determined instance id '${id}' not valid!`;
      const new_enabled = obj.common.enabled;
      const new_schedule = obj.common.schedule;
      if (new_enabled === void 0)
        throw `Unable to get common.enabled of object ${objId}`;
      if (new_enabled !== this._inst.objs[id].enabled) {
        await this.asyncUpdateQueue(id);
      }
      if (this._inst.objs[id].mode === "schedule" && new_schedule !== void 0 && new_schedule.length > 0) {
        if (this._inst.objs[id].schedule !== new_schedule) {
          this._inst.objs[id].schedule = new_schedule;
          await this.setStateAsync(`instances.${id}.schedule`, { val: new_schedule, ack: true });
        }
      }
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async _asyncOnStateChange(stateId, stateObj) {
    try {
      if (!stateObj)
        return;
      const stateIdElements = stateId.split(".");
      if (stateObj.ack === false && stateId.startsWith(this.namespace) && (stateId.endsWith(".on") || stateId.endsWith(".off") || stateId.endsWith(".enabled"))) {
        this.log.debug(`${stateId} set to '${stateObj.val}' (ack:false) by user.`);
        const idParts = stateId.split(".");
        const id = idParts[3] + "." + idParts[4];
        if (!this._inst.list.includes(id))
          throw `Determined instance id '${id}' not valid!`;
        let flag = void 0;
        if (stateId.endsWith(".on") && stateObj.val)
          flag = true;
        if (stateId.endsWith(".on") && !stateObj.val)
          flag = false;
        if (stateId.endsWith(".off") && stateObj.val)
          flag = false;
        if (stateId.endsWith(".off") && !stateObj.val)
          flag = true;
        if (stateId.endsWith(".enabled"))
          flag = stateObj.val;
        if (flag === true || flag === false)
          await this.asyncInstanceOnOff(id, flag);
      }
      if (stateId.endsWith(".alive") && stateObj.ack === true) {
        const id = stateIdElements[2] + "." + stateIdElements[3];
        const oldValue = this._inst.objs[id].alive;
        if (oldValue === stateObj.val)
          return;
        await this.asyncUpdateQueue(id);
      }
      if (stateId.endsWith(".connected") && stateObj.ack === true) {
        const id = stateIdElements[2] + "." + stateIdElements[3];
        const oldValue = this._inst.objs[id].connected_with_host;
        if (oldValue === stateObj.val)
          return;
        await this.asyncUpdateQueue(id);
      }
      if (stateId.endsWith(".info.connection") && stateObj.ack === true) {
        const id = stateIdElements[0] + "." + stateIdElements[1];
        const oldValue = this._inst.objs[id].connected_with_device_service;
        if (oldValue === stateObj.val)
          return;
        await this.asyncUpdateQueue(id);
      }
    } catch (e) {
      this.log.error(this.err2Str(e));
      return;
    }
  }
  async createObjectsAsync() {
    try {
      await this.setObjectNotExistsAsync("instances", { type: "channel", common: { name: "ioBroker adapter instances" }, native: {} });
      await this.setObjectNotExistsAsync("summary", { type: "channel", common: { name: "Summary of all adapter instances" }, native: {} });
      await this.setObjectNotExistsAsync("summary.enoCount", { type: "state", common: { name: "Counter: Enabled but not operating instances", type: "number", role: "info", read: true, write: false, def: 0 }, native: {} });
      await this.setObjectNotExistsAsync("summary.enoList", { type: "state", common: { name: "List: Enabled but not operating instances", type: "array", role: "info", read: true, write: false, def: "[]" }, native: {} });
      if (this.config.maxlog_summary)
        await this.setObjectNotExistsAsync("summary.enoSummaryLog", { type: "state", common: { name: "Log of enabled but not operating instances", type: "string", role: "json", read: true, write: false, def: "[]" }, native: {} });
      await this.setObjectNotExistsAsync("info.updatedDate", { type: "state", common: { name: "Last update", type: "number", role: "date", read: true, write: false, def: 0 }, native: {} });
      for (const id of this._inst.list) {
        const path = "instances." + id;
        await this.setObjectNotExistsAsync(path, { type: "device", common: { name: "Instance " + id }, native: {} });
        await this.setObjectNotExistsAsync(path + ".mode", { type: "state", common: { name: "Running mode (none, daemon, subscribe, schedule, once, extension)", type: "string", role: "info", read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync(path + ".isOperating", { type: "state", common: { name: "Successfully operating", type: "boolean", role: "info", read: true, write: false }, native: {} });
        await this.setObjectNotExistsAsync(path + ".on", { type: "state", common: { name: "Switch instance on (or restart, if running).", type: "boolean", role: "button", read: true, write: true }, native: {} });
        await this.setObjectNotExistsAsync(path + ".off", { type: "state", common: { name: "Switch instance off.", type: "boolean", role: "button", read: true, write: true }, native: {} });
        await this.setObjectNotExistsAsync(path + ".enabled", { type: "state", common: { name: "Enable status of instance. You can switch instance on/off with this state", type: "boolean", role: "switch", read: true, write: true }, native: {} });
        if (this.config.maxlog_inst)
          await this.setObjectNotExistsAsync(path + ".enoLog", { type: "state", common: { name: "Enabled but not operating log", type: "string", role: "json", read: true, write: false, def: "[]" }, native: {} });
      }
      if (!this.config.maxlog_summary) {
        if (await this.getObjectAsync("summary.enoSummaryLog")) {
          await this.delObjectAsync("summary.enoSummaryLog", { recursive: false });
          this.log.info(`Object summary.enoSummaryLog deleted, as log in config was deactivated.`);
        }
      }
      if (!this.config.maxlog_inst) {
        let counter = 0;
        for (const id of this._inst.list) {
          const fullObjId = "instances." + id + ".enoLog";
          if (await this.getObjectAsync(fullObjId)) {
            counter++;
            await this.delObjectAsync(fullObjId, { recursive: false });
            this.log.debug(`Object ${fullObjId} deleted, as log in config was deactivated.`);
          }
        }
        if (counter > 0)
          this.log.info(`${counter} instances objects .enoLog deleted, as log in config was deactivated.`);
      }
      const paths = Object.keys(await this.getAdapterObjectsAsync());
      const allIds = [];
      for (const path of paths) {
        const pathSplit = path.split(".");
        if (pathSplit[2] === "instances" && pathSplit[3]) {
          const id = pathSplit[3] + "." + pathSplit[4];
          if (!allIds.includes(id))
            allIds.push(id);
        }
      }
      for (const id of allIds) {
        if (!this._inst.list.includes(id)) {
          await this.delObjectAsync("instances." + id, { recursive: true });
          this.log.info(`Cleanup: Deleted no longer available instance states of '${id}'.`);
        }
      }
      return true;
    } catch (e) {
      this.log.error(this.err2Str(e));
      return false;
    }
  }
  _onUnload(callback) {
    try {
      let scheduleCounter = 0;
      for (const scheduleName in this.schedules) {
        if (this.schedules[scheduleName]) {
          this.log.debug("Cancelling schedule for " + scheduleName);
          this.schedules[scheduleName].cancel();
          scheduleCounter++;
        }
      }
      this.log.info(`(${scheduleCounter}) schedules cleared...`);
      callback();
    } catch (e) {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new InstanceWatcher(options);
} else {
  (() => new InstanceWatcher())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  InstanceWatcher
});
//# sourceMappingURL=main.js.map
