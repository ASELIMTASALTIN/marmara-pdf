// Prints the metadata of a GGUF model file (architecture, context length, chat template…).
// Usage: node scripts/gguf-info.mjs <model.gguf> [--template]
import { openSync, readSync } from "node:fs";
const file = process.argv[2];
const fd = openSync(file, "r");
const buf = Buffer.alloc(64 * 1024 * 1024);
const n = readSync(fd, buf, 0, buf.length, 0);
let o = 0;
const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
const u64 = () => { const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; };
const str = () => { const l = u64(); const s = buf.toString("utf8", o, o + l); o += l; return s; };
const read = (t) => {
  switch (t) {
    case 0: return buf.readUInt8(o++); case 1: return buf.readInt8(o++);
    case 2: { const v = buf.readUInt16LE(o); o += 2; return v; } case 3: { const v = buf.readInt16LE(o); o += 2; return v; }
    case 4: return u32(); case 5: { const v = buf.readInt32LE(o); o += 4; return v; }
    case 6: { const v = buf.readFloatLE(o); o += 4; return v; } case 7: return buf.readUInt8(o++) !== 0;
    case 8: return str();
    case 9: { const et = u32(); const len = u64(); const arr = []; for (let i = 0; i < len; i++) arr.push(read(et)); return arr; }
    case 10: return u64(); case 11: { const v = Number(buf.readBigInt64LE(o)); o += 8; return v; }
    case 12: { const v = buf.readDoubleLE(o); o += 8; return v; }
    default: throw new Error("type " + t);
  }
};
if (buf.toString("ascii", 0, 4) !== "GGUF") throw new Error("not GGUF");
o = 4; const version = u32(); const tensors = u64(); const kvs = u64();
const meta = {};
for (let i = 0; i < kvs && o < n; i++) { const k = str(); const t = u32(); meta[k] = read(t); }
const show = {};
for (const [k, v] of Object.entries(meta)) {
  if (Array.isArray(v)) show[k] = `[array ${v.length}]`;
  else if (k === "tokenizer.chat_template" && !process.argv.includes("--template")) show[k] = `${String(v).length} chars`;
  else show[k] = v;
}
console.log(JSON.stringify({ version, tensors, ...show }, null, 1));
if (process.argv.includes("--template")) console.log("\n----- chat template -----\n" + meta["tokenizer.chat_template"]);
