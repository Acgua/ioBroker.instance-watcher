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

/**
 * For all imported NPM modules, open console, change dir e.g. to "C:\iobroker\node_modules\ioBroker.instance-watcher\",
 * and execute "npm install <module name>", ex: npm install cron-parser
 */
import * as utils from '@iobroker/adapter-core';
import { parseExpression } from 'cron-parser';
import { scheduleJob } from 'node-schedule'; // https://github.com/node-schedule/node-schedule
import { IInstance, ILog } from './lib/interfaces';
import { asyncInstanceOnOff, dateToLocalIsoString, err2Str, getPreviousCronRun, isEmpty, wait } from './lib/methods';

/**
 * Main Adapter Class
 * @class InstanceWatcher
 * Note: 'export' keyword used for "import { InstanceWatcher } from '../main';" in lib/methods.ts
 */
export class InstanceWatcher extends utils.Adapter {
    // public to have access from ./lib/methods
    public _inst = {
        list: [] as Array<string>, // ['admin.0', 'bring.0', ...]
        objs: {} as { [k: string]: IInstance }, // {"admin.0": {id:.., mode:...}, "bring.0": {id:.., mode:...} }
        enabledNotOperatingList: [] as Array<string>, // List of adapter instances enabled, but not operating, like: ['bring.0', '...']
        enabledNotOperatingLog: [] as Array<ILog>,
    };

    readonly regexValidInstance = /[a-z][a-z0-9\-_]*.[0-9]{1,2}$/; // to check whether an instance like 'sonos.0' is valid.
    readonly queueDelay = 1000; // Delay in ms for recursive update function to avoid multiple calls if several calls come in almost the same time.
    readonly logEnabledNotOperatingMaxLen = 100; // state 'info.enabledNotOperatingLog': max. number of lines

    // Schedules
    public schedules = {} as { [k: string]: any };

    // Defined external methods here to access from lib/methods.ts
    public cronParseExpression = parseExpression;
    public nodeScheduleScheduleJob = scheduleJob;

    // Imported methods from ./lib/methods
    public err2Str = err2Str.bind(this);
    public isEmpty = isEmpty.bind(this);
    public wait = wait.bind(this);
    public getPreviousCronRun = getPreviousCronRun.bind(this);
    public asyncInstanceOnOff = asyncInstanceOnOff.bind(this);
    public dateToLocalIsoString = dateToLocalIsoString.bind(this);

    /**
     * Constructor
     */
    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'instance-watcher' });
        this.on('ready', this._asyncOnReady.bind(this));
        this.on('stateChange', this._asyncOnStateChange.bind(this));
        this.on('objectChange', this._asyncOnObjectChange.bind(this));
        this.on('unload', this._onUnload.bind(this));
    }

    /**
     * _asyncOnReady
     * Called once ioBroker databases are connected and adapter received configuration.
     */
    private async _asyncOnReady(): Promise<void> {
        try {
            // Get info of all ioBroker adapter instances
            this._inst.objs = await this.asyncGetAllInstancesObjects();
            if (this.isEmpty(this._inst.objs)) throw 'Failed to get ioBroker adapter instances information.';
            this._inst.list = Object.keys(this._inst.objs).sort();

            // Create objects/states, if not existing
            if (!(await this.createObjectsAsync())) throw 'Failed to create objects with createObjectsAsync()';

            // Get initial isOperating and enabled status in _inst.objs
            for (const id of this._inst.list) {
                await this._asyncUpdateInstanceInfo(id);
            }

            // Get initial log from state
            const logObj = await this.getStateAsync('info.enabledNotOperatingLog');
            if (logObj && logObj.val && typeof logObj.val === 'string' && logObj.val.length > 20) {
                this._inst.enabledNotOperatingLog = JSON.parse(logObj.val);
            } else {
                this._inst.enabledNotOperatingLog = [];
            }

            // Update States
            await this.updateOperatingStates('all');
            for (const id of this._inst.list) {
                await this.setStateAsync(`instances.${id}.mode`, { val: this._inst.objs[id].mode, ack: true });
            }

            // Subscribe to state and object changes
            for (const id of this._inst.list) {
                // Subscribe to object
                await this.subscribeForeignObjectsAsync(`system.adapter.${id}`);
                // Subscribe to foreign states to update on every change
                await this.subscribeForeignStatesAsync(`system.adapter.${id}.alive`);
                if (this._inst.objs[id].mode === 'daemon') {
                    await this.subscribeForeignStatesAsync(`system.adapter.${id}.connected`);
                    if (this._inst.objs[id].connected_with_device_service !== undefined) {
                        await this.subscribeForeignStatesAsync(`${id}.info.connection`);
                    }
                }
                // Subscribe to this adapter states in instances, '.enabled', '.on', '.off'
                await this.subscribeStatesAsync(`instances.${id}.enabled`);
                await this.subscribeStatesAsync(`instances.${id}.on`);
                await this.subscribeStatesAsync(`instances.${id}.off`);
            }

            // Schedule update of schedule instances
            await this.scheduleScheduleInstancesUpdate();

            // Final message
            this.log.debug(`${this._inst.list.length} instances initialized: ${JSON.stringify(this._inst.list)}`);
        } catch (e) {
            this.log.error(this.err2Str(e));
            return;
        }
    }

    /**
     * Update instance info.
     * We use a recursive function to avoid multiple calls.
     * If called in less than this.queueDelay ms, we wait this.queueDelay +10ms and call function again
     * @param id - instance id, e.g. 'sonos.0'
     */
    private async asyncUpdateQueue(id: string): Promise<void> {
        try {
            if (this._inst.objs[id]._noUpdate === true) return;
            if (this._inst.objs[id]._recentChange >= Date.now() - this.queueDelay) {
                // Most recent change was less than this.queueDelay ms ago
                this._inst.objs[id]._noUpdate = true;
                this._inst.objs[id]._recentChange = Date.now();
                await this.wait(this.queueDelay + 10); // wait, + 10ms buffer
                this._inst.objs[id]._noUpdate = false;
                this.asyncUpdateQueue(id); // call function recursively again
            } else {
                // Most recent change was more than this.queueDelay ms ago
                this._inst.objs[id]._recentChange = Date.now();
                this._inst.objs[id]._noUpdate = false;
                // Finally: execute
                this.log.debug(`asyncUpdateQueue(${id}): Queue completed and update started.`);
                await this._asyncUpdateInstanceInfo(id);
                await this.updateOperatingStates(id);
            }
        } catch (e) {
            this.log.error(this.err2Str(e));
            return;
        }
    }

    /**
     * Schedule the update of schedule instances
     * TODO: Testen!
     * After each due schedule of schedule instances, we check if the instance was actually running.
     */
    private async scheduleScheduleInstancesUpdate(): Promise<void> {
        try {
            for (const id of this._inst.list) {
                if (this._inst.objs[id].mode !== 'schedule') continue;
                const rule = this._inst.objs[id].schedule as string;
                if (!rule || rule.length < 2) {
                    this.log.error(`No schedule defined for schedule adapter instance ${id}`);
                    continue;
                }
                this.schedules[id] = this.nodeScheduleScheduleJob(rule, async () => {
                    // Now, the schedule adapter instance is supposed to run.
                    await this.wait(30 * 1000); // Delay of 30 seconds.
                    await this.asyncUpdateQueue(id);
                    this.log.debug(`${id}: ScheduleJob() executed (+30sec) per schedule '${rule}' of this schedule instance.`);
                });
            }
        } catch (e) {
            this.log.error(this.err2Str(e));
            return;
        }
    }

    /**
     * Update instance information
     * @param id - e.g. 'sonos.0'
     * @returns true if operating, false if not
     */
    private async _asyncUpdateInstanceInfo(id: string): Promise<true | false | undefined> {
        try {
            if (!this._inst.objs[id]) throw `Instance ${id} not available in instanceObjects`;

            let isOperating = undefined as true | false | undefined;

            // Status .enabled
            const obj = await this.getForeignObjectAsync(`system.adapter.${id}`);
            if (!obj || !obj.common || typeof obj.common.enabled !== 'boolean' || obj.common.enabled === undefined) throw `Could not get common.enabled of object 'system.adapter.${id}'.`;
            this._inst.objs[id].enabled = obj.common.enabled;
            isOperating = obj.common.enabled;

            /**
             * Daemon Adapter Instances
             */
            if (this._inst.objs[id].mode === 'daemon') {
                if (isOperating) {
                    // Status .alive
                    const obj = await this.getForeignStateAsync(`system.adapter.${id}.alive`);
                    if (!obj || obj.val === null || typeof obj.val !== 'boolean' || obj.val === undefined) throw `Could not get state value of 'system.adapter.${id}.alive'.`;
                    this._inst.objs[id].alive = obj.val;
                    isOperating = obj.val;
                    if (isOperating) {
                        // Status .connected - connected_with_host
                        const obj = await this.getForeignStateAsync(`system.adapter.${id}.connected`);
                        if (!obj || obj.val === null || typeof obj.val !== 'boolean' || obj.val === undefined) throw `Could not get state value of 'system.adapter.${id}.connected'.`;
                        this._inst.objs[id].connected_with_host = obj.val;
                        isOperating = obj.val;
                        if (isOperating) {
                            // Status <name>.<instance>.info.connection - connected_with_device_service
                            // Note: only certain adapters have this state
                            if (await this.getForeignObjectAsync(`${id}.info.connection`)) {
                                // Status info.connection exists
                                // TODO: Hier noch den Workaround ggf. einbauen!
                                const obj = await this.getForeignStateAsync(`${id}.info.connection`);
                                if (!obj || obj.val === null || typeof obj.val !== 'boolean' || obj.val === undefined) throw `Could not get state value of '${id}.info.connection'.`;
                                this._inst.objs[id].connected_with_device_service = obj.val;
                                isOperating = obj.val;
                            }
                        }
                    }
                }
            } else if (this._inst.objs[id].mode === 'schedule') {
                if (isOperating) {
                    const objIsAlive = await this.getForeignStateAsync(`system.adapter.${id}.alive`); // we check the timestamp, which reflects last update
                    if (!objIsAlive || typeof objIsAlive.ts !== 'number') throw `Could not get timestamp of state 'system.adapter.${id}.alive'.`;
                    const lastUpdateSecsAgo = Math.floor((Date.now() - objIsAlive.ts) / 1000); // Last update of state in seconds
                    const sched = this._inst.objs[id].schedule;
                    if (sched === undefined || sched.length < 1) throw `Could not get schedule of schedule adapter instance '${id}`;
                    const previousCronRun = this.getPreviousCronRun(sched);
                    if (previousCronRun === -1) throw `Could not get previous Cron run of schedule adapter instance '${id} for schedule '${sched}'`;
                    const lastCronRunSecs = Math.floor(previousCronRun / 1000); // if executed at 10:05, "*/15 * * * *" would return 5minutes in ms
                    const diff = lastCronRunSecs - lastUpdateSecsAgo;
                    isOperating = diff > -300 ? true : false; // We allow 300 seconds (5 minutes) difference
                }
            } else {
                this.log.info(`Instance ${id}: isOperating status for mode '${this._inst.objs[id].mode}' is not yet supported.`);
                isOperating = false;
            }

            // Finally
            if (this._inst.objs[id].enabled && !isOperating) {
                // add to enabled but not operating log
                this.addLogLineToEnabledNotOperating(id, 'not operating');
                // add to enabled but not operating Instances
                if (!this._inst.enabledNotOperatingList.includes(id)) {
                    this._inst.enabledNotOperatingList.push(id);
                    this._inst.enabledNotOperatingList.sort();
                }
            } else {
                // add to enabled but not operating log
                this.addLogLineToEnabledNotOperating(id, this._inst.objs[id].enabled ? 'operating' : 'turned off');
                // remove from enabledNotOperatingInstances (which only lists enabled adapter instances)
                this._inst.enabledNotOperatingList = this._inst.enabledNotOperatingList.filter((e) => e !== id); // Removes "id", if existing
                this._inst.enabledNotOperatingList.sort();
            }
            this._inst.objs[id].isOperating = isOperating;

            return isOperating;
        } catch (e) {
            this.log.error(this.err2Str(e));
            return undefined;
        }
    }

    /**
     * Add log line to enabled but not operating log
     * @param id    instance id like sonos.0
     * @param what  status
     */
    private async addLogLineToEnabledNotOperating(id: string, what: 'operating' | 'not operating' | 'turned off'): Promise<void> {
        try {
            // check if we already have an entry
            let previousStatus = '';
            for (const line of this._inst.enabledNotOperatingLog) {
                if (line.instance == id) {
                    previousStatus = line.status;
                    break;
                }
            }
            // Add only under certain conditions
            let addToLog = false;
            if (previousStatus === '' && what === 'not operating') addToLog = true; // no previous log, just add non-operating.
            if (previousStatus !== '' && previousStatus !== what) addToLog = true; // new status came in; don't ad
            if (addToLog) {
                const logLine: ILog = {
                    date: this.dateToLocalIsoString(new Date()),
                    instance: id,
                    status: what,
                    timestamp: Date.now(),
                };
                // set new array length to remove any exceeding items
                if (this._inst.enabledNotOperatingLog.length >= this.logEnabledNotOperatingMaxLen) {
                    this._inst.enabledNotOperatingLog.length = this.logEnabledNotOperatingMaxLen - 1;
                }
                // finally add to log
                this._inst.enabledNotOperatingLog = [logLine].concat(this._inst.enabledNotOperatingLog); // add as first element to array
            }
        } catch (e) {
            this.log.error(this.err2Str(e));
            return;
        }
    }

    /**
     * Get info of all ioBroker adapter instances
     * @returns object with all instance info, like: { "admin.0": {id:.., mode:...}, "bring.0": {id:.., mode:...} }
     */
    private async asyncGetAllInstancesObjects(): Promise<{ [k: string]: IInstance }> {
        try {
            // We use getObjectViewAsync() per https://discord.com/channels/743167951875604501/994567327590912010/1011370171564302337
            // which returns {"rows": [{"id": "system.adapter.admin.0", "value": ...}, {"id": "system.adapter.bring.0", "value": ...}
            const objViewSystemInst = await this.getObjectViewAsync('system', 'instance', null);
            if (!objViewSystemInst.rows) throw `Error: object.rows of returned object is not defined.`;

            // Handle blacklist from adapter options
            const blacklist = [];
            const invalidBl = [];
            if (this.config.blacklist) {
                let x = this.config.blacklist;
                this.log.debug(`Blacklist: From user configuration: ${x}`);
                x = x.toLowerCase();
                x = x.replace(/;+/g, ','); // ';' or ';;;' -> ','
                x = x.replace(/[^0-9a-z-._,]/g, ''); // remove all forbidden chars
                x = x.replace(/,+/g, ','); // ',,,,' -> ','
                this.log.debug(`Blacklist: Cleaned: ${x}`);
                const xArray = x.split(',');
                for (const itm of xArray) {
                    if (this.regexValidInstance.test(itm)) {
                        blacklist.push(itm);
                    } else {
                        invalidBl.push(itm);
                    }
                }
            }
            if (invalidBl.length > 0) this.log.warn(`Blacklist: ${invalidBl.length} invalid ${invalidBl.length > 1 ? 'entries' : 'entry'} in your settings, which will be ignored: ${invalidBl.join(',')}`);

            const returnObj: { [k: string]: IInstance } = {};
            for (const row of objViewSystemInst.rows) {
                // Get instance id like 'sonos.0'
                const instId = row.id.slice(15); // remove 'system.adapter.' to get 'sonos.0'
                if (!this.regexValidInstance.test(instId)) throw `Instance "${instId}" is not valid! - source id: "${row.id}"`;
                if (!row.value || !row.value.common) throw `row.value of instance ${instId} is not defined.`;
                if (instId === this.namespace) continue; // do not include instance-watcher.x as it would not make sense
                if (!['daemon', 'schedule'].includes(row.value.common.mode)) continue; // We only cover daemon and schedule instances
                if (blacklist.includes(instId)) {
                    this.log.debug(`Blacklist: Instance ${instId} successfully ignored per blacklist settings.`);
                    continue;
                }

                // Get objects
                returnObj[instId] = {
                    id: instId, // 'sonos.0',
                    mode: row.value.common.mode, // daemon, schedule, etc.
                    enabled: row.value.common.enabled, // if instance is enabled in ioBroker admin
                    // @ts-expect-error - Property "schedule" for type "InstanceCommon" is actually existing if mode=schedule. – ts(2339)
                    schedule: row.value.common.mode === 'schedule' && row.value.common.schedule ? row.value.common.schedule : undefined,
                    _recentChange: Date.now(),
                    _noUpdate: false,
                };
            }
            if (this.isEmpty(returnObj)) throw 'Error getting instance objects: No adapter instance found within ioBroker!';
            return returnObj;
        } catch (e) {
            this.log.error(this.err2Str(e));
            return {};
        }
    }

    /**
     * Updating states
     * @param what - 'all': update all; '<instance id>' like 'sonos.0': Update specific instance only
     */
    private async updateOperatingStates(what: string): Promise<void> {
        try {
            await this.setStateAsync('info.enabledNotOperatingCount', { val: this._inst.enabledNotOperatingList.length, ack: true });
            await this.setStateAsync('info.enabledNotOperatingList', { val: JSON.stringify(this._inst.enabledNotOperatingList), ack: true });
            await this.setStateAsync('info.enabledNotOperatingLog', { val: JSON.stringify(this._inst.enabledNotOperatingLog), ack: true });
            await this.setStateAsync('info.updatedDate', { val: Date.now(), ack: true });

            let list: Array<string> = [];
            if (what === 'all') {
                list = this._inst.list;
            } else if (this._inst.list.includes(what)) {
                list.push(what); // e.g. 'sonos.0'
            } else {
                throw `Given parameter '${what}' is not valid!`;
            }

            for (const id of list) {
                await this.setStateAsync(`instances.${id}.isOperating`, { val: this._inst.objs[id].isOperating, ack: true });
                await this.setStateAsync(`instances.${id}.enabled`, { val: this._inst.objs[id].enabled, ack: true });
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

    /**
     * Called once a subscribed object changes. Initialized by Class constructor.
     * At this time, we only handle 'system.adapter.*.0' objects
     * TODO: We may also want to handle a change of the mode. This is very unlikely, though.
     *       We could also handle a deletion/removal of an adapter instance here: if !obj, then object was deleted.
     *  @param objId - e.g. 'system.adapter.sonos.0'
     *  @param obj - updated object
     */
    private async _asyncOnObjectChange(objId: string, obj: ioBroker.Object | null | undefined): Promise<void> {
        try {
            if (!obj) return;

            const idParts = objId.split('.');
            const id = idParts[2] + '.' + idParts[3]; // e.g. 'sonos.0'
            if (!this._inst.list.includes(id)) throw `Determined instance id '${id}' not valid!`;
            const new_enabled = obj.common.enabled;
            const new_schedule = obj.common.schedule;

            // Update enabled and isOperating etc.
            if (new_enabled === undefined) throw `Unable to get common.enabled of object ${objId}`;
            if (new_enabled !== this._inst.objs[id].enabled) {
                // Update variables, and states
                await this.asyncUpdateQueue(id);
            }

            // Update schedule, if changed
            if (this._inst.objs[id].mode === 'schedule' && new_schedule !== undefined && new_schedule.length > 0) {
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

    /**
     * Called once a subscribed state changes. Initialized by Class constructor.
     *  @param stateId - e.g. "instance-watcher.0.instances.sonos.0.on"
     *  @param stateObj - e.g. { val: true, ack: false, ts: 123456789, q: 0, lc: 123456789 }
     */
    private async _asyncOnStateChange(stateId: string, stateObj: ioBroker.State | null | undefined): Promise<void> {
        try {
            if (!stateObj) return;
            const stateIdElements = stateId.split('.');

            /**
             * .on / .off / .enabled
             */
            if (stateObj.ack === false && stateId.startsWith(this.namespace) && (stateId.endsWith('.on') || stateId.endsWith('.off') || stateId.endsWith('.enabled'))) {
                this.log.debug(`${stateId} set to '${stateObj.val}' (ack:false) by user.`);
                const idParts = stateId.split('.');
                const id = idParts[3] + '.' + idParts[4]; // e.g. 'sonos.0'
                if (!this._inst.list.includes(id)) throw `Determined instance id '${id}' not valid!`;

                let flag = undefined;
                if (stateId.endsWith('.on') && stateObj.val) flag = true;
                if (stateId.endsWith('.on') && !stateObj.val) flag = false;
                if (stateId.endsWith('.off') && stateObj.val) flag = false;
                if (stateId.endsWith('.off') && !stateObj.val) flag = true;
                if (stateId.endsWith('.enabled')) flag = stateObj.val;

                if (flag === true || flag === false) await this.asyncInstanceOnOff(id, flag);
            }

            /**
             * system.adapter.<adapter-name>.<instance>.alive
             */
            if (stateId.endsWith('.alive') && stateObj.ack === true) {
                const id = stateIdElements[2] + '.' + stateIdElements[3]; // 'sonos.0'
                const oldValue = this._inst.objs[id].alive;
                if (oldValue === stateObj.val) return; // No change!
                await this.asyncUpdateQueue(id); // Update info and states
            }

            /**
             * system.adapter.<adapter-name>.<instance>.connected
             */
            if (stateId.endsWith('.connected') && stateObj.ack === true) {
                const id = stateIdElements[2] + '.' + stateIdElements[3]; // 'sonos.0'
                const oldValue = this._inst.objs[id].connected_with_host;
                if (oldValue === stateObj.val) return; // No change!
                await this.asyncUpdateQueue(id); // Update info and states
            }

            /**
             * <adapter-name>.<instance>.info.connection
             */
            if (stateId.endsWith('.info.connection') && stateObj.ack === true) {
                const id = stateIdElements[0] + '.' + stateIdElements[1]; // 'sonos.0'
                const oldValue = this._inst.objs[id].connected_with_device_service;
                if (oldValue === stateObj.val) return; // No change!
                await this.asyncUpdateQueue(id); // Update info and states
            }
        } catch (e) {
            this.log.error(this.err2Str(e));
            return;
        }
    }

    /**
     * Create objects
     * @returns true if successful, false if not
     */
    private async createObjectsAsync(this: InstanceWatcher): Promise<true | false> {
        try {
            // Creating main channel and state objects
            await this.setObjectNotExistsAsync('instances', { type: 'channel', common: { name: 'ioBroker adapter instances' }, native: {} });
            await this.setObjectNotExistsAsync('info', { type: 'channel', common: { name: 'All adapter instances' }, native: {} });
            await this.setObjectNotExistsAsync('info.enabledNotOperatingCount', { type: 'state', common: { name: 'Counter: Enabled but not functioning instances', type: 'number', role: 'info', read: true, write: false, def: 0 }, native: {} });
            await this.setObjectNotExistsAsync('info.enabledNotOperatingList', { type: 'state', common: { name: 'List: Enabled but not functioning instances', type: 'array', role: 'info', read: true, write: false, def: '[]' }, native: {} });
            await this.setObjectNotExistsAsync('info.enabledNotOperatingLog', { type: 'state', common: { name: 'Log of enabled but not functioning instances', type: 'string', role: 'json', read: true, write: false, def: '[]' }, native: {} });
            await this.setObjectNotExistsAsync('info.updatedDate', { type: 'state', common: { name: 'Last update', type: 'number', role: 'date', read: true, write: false, def: 0 }, native: {} });

            // Create adapter instance device and state objects
            for (const id of this._inst.list) {
                const path = 'instances.' + id;
                await this.setObjectNotExistsAsync(path, { type: 'device', common: { name: 'Instance ' + id }, native: {} });
                await this.setObjectNotExistsAsync(path + '.mode', { type: 'state', common: { name: 'Running mode (none, daemon, subscribe, schedule, once, extension)', type: 'string', role: 'info', read: true, write: false }, native: {} });
                await this.setObjectNotExistsAsync(path + '.isOperating', { type: 'state', common: { name: 'Successfully operating', type: 'boolean', role: 'info', read: true, write: false }, native: {} });
                await this.setObjectNotExistsAsync(path + '.on', { type: 'state', common: { name: 'Switch instance on (or restart, if running).', type: 'boolean', role: 'button', read: true, write: true }, native: {} });
                await this.setObjectNotExistsAsync(path + '.off', { type: 'state', common: { name: 'Switch instance off.', type: 'boolean', role: 'button', read: true, write: true }, native: {} });
                await this.setObjectNotExistsAsync(path + '.enabled', { type: 'state', common: { name: 'Enable status of instance. You can switch instance on/off with this state', type: 'boolean', role: 'switch', read: true, write: true }, native: {} });
            }

            /**
             * Cleanup: Delete objects no longer required, e.g., if user has uninstalled an adapter instance
             */
            // Get string array of all adapter objects: ['instance-watcher.0.info', 'instance-watcher.0.Instances.admin_0', ...];
            const paths = Object.keys(await this.getAdapterObjectsAsync());

            // Get all instance ids of 'instance-watcher.0.instances...', like ['admin.0', 'bring.0', ...]
            const allIds: Array<string> = [];
            for (const path of paths) {
                const pathSplit = path.split('.');
                if (pathSplit[2] === 'instances' && pathSplit[3]) {
                    const id = pathSplit[3] + '.' + pathSplit[4]; // e.g. 'sonos.0'
                    if (!allIds.includes(id)) allIds.push(id);
                }
            }
            // Delete instance objects if adapter instance is no longer available/installed
            for (const id of allIds) {
                if (!this._inst.list.includes(id)) {
                    await this.delObjectAsync('instances.' + id, { recursive: true });
                    this.log.info(`Cleanup: Deleted no longer available instance states of '${id}'.`);
                }
            }
            return true;
        } catch (e) {
            this.log.error(this.err2Str(e));
            return false;
        }
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private _onUnload(callback: () => void): void {
        try {
            // Here you must clear all timeouts or intervals that may still be active
            // clearTimeout(timeout1);
            // clearInterval(interval1);

            /**
             * Clear all Schedules
             */
            let scheduleCounter = 0;
            for (const scheduleName in this.schedules) {
                if (this.schedules[scheduleName]) {
                    this.log.debug('Cancelling schedule for ' + scheduleName);
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
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new InstanceWatcher(options);
} else {
    // otherwise start the instance directly
    (() => new InstanceWatcher())();
}
