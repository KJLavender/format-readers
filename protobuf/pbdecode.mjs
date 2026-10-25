#!/usr/bin/env node
// Prototype: schema-less protobuf / gRPC decoder for HAR captures and raw files.
// Usage:
//   node pbdecode.mjs capture.har [--record N] [--json] [--all]
//   node pbdecode.mjs message.bin [--grpc] [--json] [--protoc] [--schema]
// --schema merges repeated fields into one inferred schema (compact, for unknown messages).
// --protoc prints exactly what `protoc --decode_raw` prints (for comparison).
import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync } from "node:zlib";

const MAX_DEPTH = 100; // protoc's default recursion budget
const WIRE = ["varint", "i64", "len", "sgroup", "egroup", "i32"];
const PROTO_TYPES =
  /^application\/(grpc(-web)?(-text)?(\+proto)?|x-protobuf|protobuf|x-google-protobuf|vnd\.google\.protobuf)\b/i;

// ---------- wire format ----------

class WireError extends Error {}

const readVarint = (buf, pos, end = buf.length) => {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= end) throw new WireError(`truncated varint at ${pos}`);
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result & 0xffffffffffffffffn, pos];
    shift += 7n;
  }
  throw new WireError(`varint longer than 10 bytes at ${pos}`);
};

/** Parse one message body; throws WireError if the bytes are not a valid message. */
const parseMessage = (buf, start, end, depth, endGroup = null) => {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const fieldStart = pos;
    let tag;
    [tag, pos] = readVarint(buf, pos, end);
    // protoc reads tags as uint32 and silently drops higher bits; do the same.
    const oversizedTag = tag > 0xffffffffn;
    tag &= 0xffffffffn;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number === 0 || number > 0x1fffffff) throw new WireError(`invalid field number ${number} at ${fieldStart}`);
    if (wire > 5) throw new WireError(`invalid wire type ${wire} at ${fieldStart}`);
    const field = { offset: fieldStart, number, wire: WIRE[wire], ...(oversizedTag ? { oversizedTag } : {}) };
    if (wire === 0) {
      [field.value, pos] = readVarint(buf, pos, end);
    } else if (wire === 1) {
      if (pos + 8 > end) throw new WireError(`truncated i64 at ${pos}`);
      field.bytes = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > end) throw new WireError(`truncated i32 at ${pos}`);
      field.bytes = buf.subarray(pos, pos + 4);
      pos += 4;
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos, end);
      if (len > BigInt(end - pos)) throw new WireError(`length ${len} past end at ${pos}`);
      field.dataOffset = pos;
      field.bytes = buf.subarray(pos, pos + Number(len));
      pos += Number(len);
      field.interpretation = interpretLen(buf, field.dataOffset, pos, depth);
    } else if (wire === 3) {
      if (depth <= 0) throw new WireError("recursion budget exhausted");
      const group = parseMessage(buf, pos, end, depth - 1, number);
      field.children = group.fields;
      pos = group.pos;
    } else {
      if (endGroup === number) return { fields, pos };
      throw new WireError(`unmatched end group ${number} at ${fieldStart}`);
    }
    fields.push(field);
  }
  if (endGroup !== null) throw new WireError(`missing end group ${endGroup}`);
  return { fields, pos };
};

const isUtf8Text = (bytes) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return /^[\P{Cc}\t\n\r]*$/u.test(text) ? text : null;
  } catch {
    return null;
  }
};

const packedVarints = (bytes) => {
  const values = [];
  let pos = 0;
  try {
    while (pos < bytes.length) {
      let value;
      [value, pos] = readVarint(bytes, pos);
      values.push(value);
    }
  } catch {
    return null;
  }
  return values.length > 1 ? values : null;
};

/** Decide how to show a length-delimited value; protoc's rule picks "message" first. */
const interpretLen = (buf, start, end, depth) => {
  const bytes = buf.subarray(start, end);
  const alternatives = [];
  const text = bytes.length > 0 ? isUtf8Text(bytes) : null;
  if (text !== null) alternatives.push("string");
  const packed = packedVarints(bytes);
  if (packed !== null) alternatives.push("packed varints");
  if (bytes.length > 0 && depth > 0) {
    try {
      const nested = parseMessage(buf, start, end, depth - 1);
      return { kind: "message", fields: nested.fields, alternatives, text, packed };
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
    }
  }
  return { kind: text !== null ? "string" : "bytes", alternatives: alternatives.filter((a) => a !== "string"), text, packed };
};

// ---------- value rendering ----------

const toSigned64 = (v) => (v >= 1n << 63n ? v - (1n << 64n) : v);
const zigzag = (v) => (v & 1n ? -((v + 1n) >> 1n) : v >> 1n);
const hex = (bytes) => Buffer.from(bytes).toString("hex");

const varintViews = (v) => {
  const views = [];
  const signed = toSigned64(v);
  if (signed < 0n) views.push(`int64 ${signed}`);
  if (v > 0n) views.push(`sint ${zigzag(v)}`);
  if (v === 0n || v === 1n) views.push(`bool ${v === 1n}`);
  return views;
};

const fixedViews = (bytes) => {
  const b = Buffer.from(bytes);
  if (b.length === 8) {
    const d = b.readDoubleLE(0);
    return [`double ${Number.isFinite(d) ? d : String(d)}`, `int64 ${b.readBigInt64LE(0)}`];
  }
  const f = b.readFloatLE(0);
  return [`float ${Number.isFinite(f) ? Math.fround(f) : String(f)}`, `int32 ${b.readInt32LE(0)}`];
};

const cEscape = (bytes) => {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x22) out += '\\"';
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x5c) out += "\\\\";
    else if (byte < 0x20 || byte >= 0x7f) out += "\\" + byte.toString(8).padStart(3, "0");
    else out += String.fromCharCode(byte);
  }
  return out;
};

/** Output identical to `protoc --decode_raw`, which stops nesting messages after 10 levels. */
const renderProtoc = (fields, indent = "", budget = 10) =>
  fields
    .map((f) => {
      if (f.wire === "varint") return `${indent}${f.number}: ${f.value}\n`;
      if (f.wire === "i64") return `${indent}${f.number}: 0x${Buffer.from(f.bytes).readBigUInt64LE(0).toString(16).padStart(16, "0")}\n`;
      if (f.wire === "i32") return `${indent}${f.number}: 0x${Buffer.from(f.bytes).readUInt32LE(0).toString(16).padStart(8, "0")}\n`;
      if (f.wire === "sgroup") return `${indent}${f.number} {\n${renderProtoc(f.children, indent + "  ", budget - 1)}${indent}}\n`;
      if (f.interpretation.kind === "message" && budget > 0)
        return `${indent}${f.number} {\n${renderProtoc(f.interpretation.fields, indent + "  ", budget - 1)}${indent}}\n`;
      return `${indent}${f.number}: "${cEscape(f.bytes)}"\n`;
    })
    .join("");

/** Annotated output: byte offsets plus alternative readings, marked as inferred. */
const renderAnnotated = (fields, base, indent = "") =>
  fields
    .map((f) => {
      const at = `@${base + f.offset}`.padEnd(7);
      const head = `${indent}${at} ${f.number}`;
      if (f.wire === "varint") {
        const views = varintViews(f.value);
        return `${head}: ${f.value}${views.length ? `   (or ${views.join(", ")})` : ""}\n`;
      }
      if (f.wire === "i64" || f.wire === "i32")
        return `${head}: 0x${hex(Buffer.from(f.bytes).reverse())} [${f.wire}]   (or ${fixedViews(f.bytes).join(", ")})\n`;
      if (f.wire === "sgroup") return `${head} [group] {\n${renderAnnotated(f.children, base, indent + "  ")}${indent}}\n`;
      const it = f.interpretation;
      const others = [];
      if (it.kind === "message" && it.text !== null) others.push(`string ${JSON.stringify(it.text.slice(0, 60))}`);
      // Printable text almost always also parses as packed varints; only mention packed when it isn't text.
      if (it.packed && it.text !== null) {
      } else if (it.packed && it.kind !== "message") others.push(`packed [${it.packed.slice(0, 8).join(", ")}${it.packed.length > 8 ? ", ..." : ""}]`);
      else if (it.packed && it.kind === "message") others.push("packed varints");
      const alt = others.length ? `   (inferred; could also be ${others.join(" / ")})` : "";
      const len = `[len ${f.bytes.length}]`;
      if (it.kind === "message")
        return `${head} ${len} message${alt} {\n${renderAnnotated(it.fields, base, indent + "  ")}${indent}}\n`;
      if (it.kind === "string") return `${head} ${len}: ${JSON.stringify(it.text)}${alt}\n`;
      return `${head} ${len}: bytes ${hex(f.bytes.subarray(0, 48))}${f.bytes.length > 48 ? "..." : ""}${alt}\n`;
    })
    .join("");

const toJson = (fields, base) =>
  fields.map((f) => {
    const out = { offset: base + f.offset, field: f.number, wire_type: f.wire };
    if (f.wire === "varint") Object.assign(out, { value: f.value.toString(), alternatives: varintViews(f.value) });
    else if (f.wire === "i64" || f.wire === "i32") Object.assign(out, { hex: hex(f.bytes), alternatives: fixedViews(f.bytes) });
    else if (f.wire === "sgroup") out.fields = toJson(f.children, base);
    else {
      const it = f.interpretation;
      Object.assign(out, { length: f.bytes.length, data_offset: base + f.dataOffset, interpretation: it.kind, certainty: "inferred" });
      if (it.kind === "message") out.fields = toJson(it.fields, base);
      if (it.text !== null) out.as_string = it.text;
      if (it.packed) out.as_packed_varints = it.packed.map(String);
      if (it.kind === "bytes") out.hex = hex(f.bytes);
    }
    return out;
  });

// ---------- schema inference ----------

/** Merge every occurrence of each field path into one inferred schema node. */
const inferSchema = (fields, node = new Map()) => {
  const perMessage = new Map();
  for (const f of fields) perMessage.set(f.number, (perMessage.get(f.number) ?? 0) + 1);
  for (const f of fields) {
    let entry = node.get(f.number);
    if (!entry) node.set(f.number, (entry = { count: 0, repeated: false, kinds: new Map(), examples: new Set(), min: null, max: null, children: new Map(), textLike: [], textLikeChildren: new Map() }));
    entry.count++;
    if (perMessage.get(f.number) > 1) entry.repeated = true;
    let kind = f.wire;
    if (f.wire === "varint") {
      kind = "varint";
      entry.min = entry.min === null || f.value < entry.min ? f.value : entry.min;
      entry.max = entry.max === null || f.value > entry.max ? f.value : entry.max;
    } else if (f.wire === "i32" || f.wire === "i64") {
      if (entry.examples.size < 4) entry.examples.add(fixedViews(f.bytes)[0]);
    } else if (f.wire === "sgroup") {
      kind = "group";
      inferSchema(f.children, entry.children);
    } else {
      const it = f.interpretation;
      kind = it.kind;
      // Messages whose bytes are also printable text are kept apart until the field's majority decides.
      if (it.kind === "message" && it.text !== null) {
        entry.textLike.push(it.text);
        inferSchema(it.fields, entry.textLikeChildren);
      } else if (it.kind === "message") inferSchema(it.fields, entry.children);
      else if (it.kind === "string" && entry.examples.size < 6) entry.examples.add(JSON.stringify(it.text.length > 40 ? it.text.slice(0, 40) + "…" : it.text));
      else if (it.kind === "bytes" && entry.examples.size < 2) entry.examples.add(`<${f.bytes.length} bytes>`);
    }
    entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
  }
  return node;
};

const renderSchema = (node, indent = "") =>
  [...node.entries()]
    .sort(([a], [b]) => a - b)
    .map(([number, e]) => {
      const strings = e.kinds.get("string") ?? 0;
      const messages = e.kinds.get("message") ?? 0;
      let note = "";
      if (e.textLike.length && strings > messages && e.textLike.length === messages) {
        // Majority vote: these values parse as messages only by accident.
        e.kinds.delete("message");
        e.kinds.set("string", strings + messages);
        note = `  (inferred: ${messages} short values that also parse as messages read as text, e.g. ${e.textLike.slice(0, 4).map((t) => JSON.stringify(t)).join(", ")})`;
      } else {
        for (const [k, v] of e.textLikeChildren) if (!e.children.has(k)) e.children.set(k, v);
      }
      const kinds = [...e.kinds.entries()].map(([k, n]) => (e.kinds.size > 1 ? `${k}×${n}` : k)).join(" | ");
      const label = `${indent}${number}`.padEnd(14) + `${(e.repeated ? "repeated " : "") + kinds}`.padEnd(26) + `seen ${e.count}×`.padEnd(11);
      let detail = "";
      if (e.min !== null) detail = e.min === e.max ? `= ${e.min}` : `range ${e.min}..${e.max}`;
      if (e.examples.size) detail += (detail ? "  " : "") + "e.g. " + [...e.examples].join(", ");
      return `${label} ${detail}${note}
` + (e.children.size ? renderSchema(e.children, indent + "  ") : "");
    })
    .join("");

// ---------- gRPC framing ----------

/** Decode grpc-web-text: base64 that may be several independently padded chunks. */
const decodeGrpcWebText = (text) => {
  const clean = text.replace(/\s+/g, "");
  const parts = clean.match(/[^=]+={0,2}/g) ?? [];
  return Buffer.concat(parts.map((p) => Buffer.from(p, "base64")));
};

const splitGrpcFrames = (body, encoding) => {
  const frames = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 5 > body.length) return { frames, error: `truncated frame header at ${pos}` };
    const flags = body[pos];
    const length = body.readUInt32BE(pos + 1);
    if (pos + 5 + length > body.length) return { frames, error: `frame at ${pos} claims ${length} bytes, ${body.length - pos - 5} present` };
    const payload = body.subarray(pos + 5, pos + 5 + length);
    const frame = { offset: pos, flags, length, trailer: (flags & 0x80) !== 0, compressed: (flags & 0x01) !== 0, payloadOffset: pos + 5, payload };
    if (frame.compressed) {
      try {
        frame.payload = encoding === "deflate" ? inflateSync(payload) : gunzipSync(payload);
        frame.decompressed = encoding ?? "gzip";
        frame.payloadOffset = null; // offsets now refer to decompressed bytes
      } catch {
        frame.decompressError = `could not decompress (grpc-encoding: ${encoding ?? "unknown"})`;
      }
    }
    frames.push(frame);
    pos += 5 + length;
  }
  return { frames, error: null };
};

// ---------- inputs ----------

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name)?.value;

const bodyBytes = (text, encoding, mimeType) => {
  if (text == null) return null;
  if (/grpc-web-text/i.test(mimeType)) return decodeGrpcWebText(encoding === "base64" ? Buffer.from(text, "base64").toString("latin1") : text);
  return encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text, "latin1");
};

const decodeBody = (bytes, mimeType, grpcEncoding) => {
  const isGrpc = /grpc/i.test(mimeType);
  if (!isGrpc) return { kind: "protobuf", ...decodeMessage(bytes, 0) };
  const { frames, error } = splitGrpcFrames(bytes, grpcEncoding);
  return {
    kind: "grpc",
    frameError: error,
    frames: frames.map((frame) => {
      if (frame.trailer) return { ...frame, trailers: frame.payload.toString("latin1").trim().split(/\r?\n/) };
      if (frame.decompressError) return frame;
      return { ...frame, ...decodeMessage(frame.payload, frame.payloadOffset ?? 0) };
    }),
  };
};

const decodeMessage = (bytes, base) => {
  try {
    return { base, fields: parseMessage(bytes, 0, bytes.length, MAX_DEPTH).fields };
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    return { base, error: `not a valid protobuf message: ${error.message}` };
  }
};

// ---------- printing ----------

const printDecoded = (d, json) => {
  const printMessage = (m, indent) => {
    if (m.error) return console.log(`${indent}${m.error}`);
    if (json) return console.log(JSON.stringify(toJson(m.fields, m.base ?? 0), null, 2));
    if (flag("schema")) return process.stdout.write(renderSchema(inferSchema(m.fields), indent));
    process.stdout.write(renderAnnotated(m.fields, m.base ?? 0, indent));
  };
  if (d.kind === "protobuf") return printMessage(d, "  ");
  for (const [i, f] of d.frames.entries()) {
    const flags = [f.trailer ? "trailer" : "data", f.compressed ? `compressed${f.decompressed ? ` (${f.decompressed}, offsets are in decompressed bytes)` : ""}` : "uncompressed"];
    console.log(`  frame ${i} @${f.offset}: ${flags.join(", ")}, ${f.length} bytes`);
    if (f.trailer) f.trailers.forEach((t) => console.log(`    ${t}`));
    else if (f.decompressError) console.log(`    ${f.decompressError}`);
    else printMessage(f, "    ");
  }
  if (d.frameError) console.log(`  framing problem: ${d.frameError}`);
};

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);
const recordArg = args.indexOf("--record");
const onlyRecord = recordArg >= 0 ? Number(args[recordArg + 1]) : null;
if (!file) {
  console.error("usage: node pbdecode.mjs <capture.har | message.bin> [--record N] [--all] [--grpc] [--json] [--protoc] [--schema]");
  process.exit(2);
}

const raw = readFileSync(file);
let har = null;
try {
  const parsed = JSON.parse(raw.toString("utf8"));
  if (parsed?.log?.entries) har = parsed;
} catch {}

if (!har) {
  const decoded = decodeBody(raw, flag("grpc") ? "application/grpc" : "application/x-protobuf");
  if (flag("protoc")) {
    if (decoded.error) {
      console.error("Failed to parse input.");
      process.exit(1);
    }
    process.stdout.write(renderProtoc(decoded.fields));
  } else printDecoded(decoded, flag("json"));
} else {
  let shown = 0;
  har.log.entries.forEach((entry, index) => {
    if (onlyRecord !== null && index !== onlyRecord) return;
    const sides = [
      ["request", entry.request.postData?.text, entry.request.postData?.encoding, entry.request.postData?.mimeType ?? header(entry.request.headers, "content-type"), header(entry.request.headers, "grpc-encoding")],
      ["response", entry.response.content?.text, entry.response.content?.encoding, entry.response.content?.mimeType ?? header(entry.response.headers, "content-type"), header(entry.response.headers, "grpc-encoding")],
    ];
    for (const [side, text, encoding, mime = "", grpcEncoding] of sides) {
      if (!flag("all") && !PROTO_TYPES.test(mime)) continue;
      const bytes = bodyBytes(text, encoding, mime);
      if (!bytes || bytes.length === 0) continue;
      shown++;
      console.log(`record ${index} ${side}: ${entry.request.method} ${entry.request.url}`);
      console.log(`  content-type ${mime}, ${bytes.length} bytes`);
      printDecoded(decodeBody(bytes, mime, grpcEncoding), flag("json"));
    }
  });
  if (shown === 0) console.log("no protobuf or gRPC bodies found (use --all to try every body)");
}
