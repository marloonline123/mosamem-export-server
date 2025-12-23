import EventEmitter from 'events';

class ProgressEmitter extends EventEmitter { }
export const progressEmitter = new ProgressEmitter();
