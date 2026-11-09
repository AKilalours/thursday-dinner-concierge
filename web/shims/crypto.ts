// Browser stand-ins for the two node:crypto calls the agent uses.
export const randomUUID = () => globalThis.crypto.randomUUID();
export function createHash(_alg: string) {
  let data = "";
  const h = {
    update(s: string) { data += s; return h; },
    digest(_enc: string) {
      // Two FNV-1a passes give a stable 32-hex-char key: enough for idempotency keys in a demo.
      let a = 0x811c9dc5, b = 0x01000193 ^ data.length;
      for (let i = 0; i < data.length; i++) { a = Math.imul(a ^ data.charCodeAt(i), 16777619); b = Math.imul(b ^ data.charCodeAt(i), 2246822519); }
      const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
      return hex(a) + hex(b) + hex(a ^ b) + hex(Math.imul(a, b));
    },
  };
  return h;
}
