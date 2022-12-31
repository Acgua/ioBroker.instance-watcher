var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var methods_exports = {};
__export(methods_exports, {
  asyncInstanceOnOff: () => asyncInstanceOnOff,
  err2Str: () => err2Str,
  getPreviousCronRun: () => getPreviousCronRun,
  isEmpty: () => isEmpty,
  wait: () => wait
});
module.exports = __toCommonJS(methods_exports);
/**
 * Methods and Tools
 * @desc    Methods and Tools
 * @author  Acgua <https://github.com/Acgua/ioBroker.instance-watcher>
 * @license Apache License 2.0
 *
 * ----------------------------------------------------------------------------------------
 * How to implement this file in main.ts (see also https://stackoverflow.com/a/58459668)
 * ----------------------------------------------------------------------------------------
 *  1. Add "this: InstanceWatcher" as first function parameter if you need access to "this"
 *       -> no need to provide this parameter when calling the method, though!
 *  1. Add line like "import { err2Str, isEmpty } from './lib/methods';"
 *  2. Add keyword "export" before "class InstanceWatcher extends utils.Adapter"
 *  3. class InstanceWatcher: for each method, add line like: "public isEmpty = isEmpty.bind(this);"
 *           Note: use "private isEmpty..." and not "public", if you do not need to access method from this file
 */
async function asyncInstanceOnOff(id, flag) {
  try {
    if (this._inst.objs[id].mode === "daemon") {
      await this.setForeignStateAsync(`system.adapter.${id}.alive`, { val: flag, ack: false });
      this.log.debug(`Adapter instance ${id} (${this._inst.objs[id].mode}) ${flag ? " turned on." : " turned off."}`);
      return true;
    } else if (this._inst.objs[id].mode === "schedule") {
      if (flag === false || this._inst.objs[id].enabled) {
        await this.setForeignStateAsync(`system.adapter.${id}.alive`, { val: false, ack: false });
        this.log.debug(`Adapter instance ${id} (${this._inst.objs[id].mode}) turned off.`);
      }
      if (flag) {
        if (this._inst.objs[id].enabled)
          await this.wait(3e3);
        await this.setForeignStateAsync(`system.adapter.${id}.alive`, { val: true, ack: false });
        this.log.debug(`Adapter instance ${id} (${this._inst.objs[id].mode}) turned on.`);
      }
      return true;
    } else {
      this.log.warn(`Running mode '${this._inst.objs[id].mode}' of adapter '${id}' is not yet supported!`);
      return false;
    }
  } catch (e) {
    this.log.error(this.err2Str(e));
    return false;
  }
}
function err2Str(error) {
  if (error instanceof Error) {
    if (error.stack)
      return error.stack;
    if (error.message)
      return error.message;
    return JSON.stringify(error);
  } else {
    if (typeof error === "string")
      return error;
    return JSON.stringify(error);
  }
}
function isEmpty(toCheck) {
  if (toCheck === null || typeof toCheck === "undefined")
    return true;
  if (typeof toCheck === "function")
    return false;
  let x = JSON.stringify(toCheck);
  x = x.replace(/\s+/g, "");
  x = x.replace(/"+/g, "");
  x = x.replace(/'+/g, "");
  x = x.replace(/\[+/g, "");
  x = x.replace(/\]+/g, "");
  x = x.replace(/\{+/g, "");
  x = x.replace(/\}+/g, "");
  return x === "" ? true : false;
}
async function wait(ms) {
  try {
    await new Promise((w) => setTimeout(w, ms));
  } catch (e) {
    this.log.error(this.err2Str(e));
    return;
  }
}
function getPreviousCronRun(expression) {
  try {
    const interval = this.cronParseExpression(expression);
    const previous = interval.prev();
    return Math.floor(Date.now() - previous.getTime());
  } catch (e) {
    this.log.error(this.err2Str(e));
    return -1;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  asyncInstanceOnOff,
  err2Str,
  getPreviousCronRun,
  isEmpty,
  wait
});
//# sourceMappingURL=methods.js.map
