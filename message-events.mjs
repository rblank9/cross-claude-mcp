import { EventEmitter } from "events";
export const messageEvents = new EventEmitter();
messageEvents.setMaxListeners(0);
