// node:fs and node:path are only used to record and replay model calls, which the browser demo never does.
export const existsSync = () => false;
export const mkdirSync = () => undefined;
export const readFileSync = () => "";
export const writeFileSync = () => undefined;
export const join = (...p: string[]) => p.join("/");
