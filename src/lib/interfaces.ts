export interface IInstance {
    // static information
    id: string; // e.g. 'sonos.0'

    // rather static information
    mode: 'none' | 'daemon' | 'subscribe' | 'schedule' | 'once' | 'extension';
    schedule?: string;

    // dynamic information
    enabled: true | false;
    alive?: true | false;
    connected_with_host?: true | false;
    connected_with_device_service?: true | false;
    isOperating?: true | false;

    // for asyncUpdateQueue()
    _recentChange: number; // last change (Date.now()) of: enabled, alive, connected_with_host, connected_with_device_service
    _noUpdate: true | false; // for recursive function
}
