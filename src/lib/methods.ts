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
import { InstanceWatcher } from '../main';
// import { IInstance } from './interfaces';

/**
 * Turn adapter instance on/off
 * TO DO: Unbedingt noch ausführlich testen!
 * @param id - Instance Id, e.g. 'sonos.0'
 * @param flag - true to turn on or restart (if running), false to turn off
 * @returns true if successful, false if not.
 */
export async function asyncInstanceOnOff(this: InstanceWatcher, id: string, flag: true | false): Promise<true | false> {
    try {
        await this.extendForeignObjectAsync(`system.adapter.${id}`, { common: { enabled: flag } });
        this.log.debug(`Adapter instance ${id} (${this._inst.objs[id].mode}) ${flag ? ' turned on.' : ' turned off.'}`);
        return true;
    } catch (e) {
        this.log.error(this.err2Str(e));
        return false;
    }
}

/**
 * Convert error to string
 * @param {*} error - any kind of thrown error
 * @returns string
 */
export function err2Str(error: any): string {
    if (error instanceof Error) {
        if (error.stack) return error.stack;
        if (error.message) return error.message;
        return JSON.stringify(error);
    } else {
        if (typeof error === 'string') return error;
        return JSON.stringify(error);
    }
}

/**
 * Convert date/time to a local ISO string
 * Required as toISOString() uses UTC +0 (Zulu) as time zone.
 * https://stackoverflow.com/questions/10830357/
 * @param   date    Date object
 * @returns string like "2015-01-26T06:40:36.181"
 */
export function dateToLocalIsoString(date: Date): string {
    const timezoneOffset = date.getTimezoneOffset() * 60000; //offset in milliseconds
    return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, -1);
}

/**
 * Checks if an operand (variable, constant, object, ...) is considered as empty.
 * - empty:     undefined; null; string|array|object, stringified and only with white space(s), and/or `><[]{}`
 * - NOT empty: not matching anything above; any function; boolean false; number -1
 * inspired by helper.js from SmartControl adapter
 */
export function isEmpty(toCheck: any): true | false {
    if (toCheck === null || typeof toCheck === 'undefined') return true;
    if (typeof toCheck === 'function') return false;
    let x = JSON.stringify(toCheck);
    x = x.replace(/\s+/g, ''); // white space(s)
    x = x.replace(/"+/g, ''); // "
    x = x.replace(/'+/g, ''); // '
    x = x.replace(/\[+/g, ''); // [
    x = x.replace(/\]+/g, ''); // ]
    x = x.replace(/\{+/g, ''); // {
    x = x.replace(/\}+/g, ''); // }
    return x === '' ? true : false;
}

/**
 * async wait/pause
 * Actually not needed since a single line, but for the sake of using wait more easily
 * @param {number} ms - number of milliseconds to wait
 */
export async function wait(this: InstanceWatcher, ms: number): Promise<void> {
    try {
        await new Promise((w) => setTimeout(w, ms));
    } catch (e) {
        this.log.error(this.err2Str(e));
        return;
    }
}

/**
 * Get previous run of cron job schedule
 * Requires cron-parser
 * Inspired by https://stackoverflow.com/questions/68134104/
 * @param  expression
 * @return milliseconds to previous run (calculated)
 */
export function getPreviousCronRun(this: InstanceWatcher, expression: string): number {
    try {
        const interval = this.cronParseExpression(expression);
        const previous = interval.prev();
        return Math.floor(Date.now() - previous.getTime()); // in ms
    } catch (e) {
        this.log.error(this.err2Str(e));
        return -1;
    }
}
