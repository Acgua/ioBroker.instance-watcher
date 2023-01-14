// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            // option1: boolean;
            // option2: string;
            blacklist: string;
            maxlog_summary: number;
            maxlog_inst: number;
            queue_delay: number;
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
