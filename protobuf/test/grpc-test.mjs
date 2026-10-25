// Decode the gRPC / gRPC-web / grpc-web-text / gzip / x-protobuf cases in grpc-cases.har
// (built by make-har.mjs) and check the facts we know are inside.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const decode = (...args) => execFileSync(process.execPath, [join(here, "..", "pbdecode.mjs"), join(here, "grpc-cases.har"), ...args]).toString();

const text = decode();
const records = text.split(/^record /m).slice(1);
assert.equal(records.length, 4, "four protobuf bodies; the JSON entry is skipped");

const expectInBody = (body, label) => {
  for (const needle of ['"王小明"', '"Alice"', '"admin"', '"Taipei"', '"Tainan"', "double 1234.5", "double -20.25", '"page-2"'])
    assert.ok(body.includes(needle), `${label}: missing ${needle}`);
};
const [grpcWeb, grpcWebText, gzip, raw] = records;
for (const [label, body] of [["grpc-web", grpcWeb], ["grpc-web-text", grpcWebText], ["gzip", gzip]]) {
  expectInBody(body, label);
  assert.match(body, /frame 1 @\d+: trailer/, `${label}: trailer frame`);
  assert.ok(body.includes("grpc-status:0"), `${label}: grpc-status`);
}
assert.match(gzip, /compressed \(gzip/, "gzip frame is decompressed");
expectInBody(raw, "x-protobuf");

const schema = decode("--record", "0", "--schema");
assert.match(schema, /1\s+repeated message\s+seen 2×/, "schema: repeated users");
assert.match(schema, /3\s+repeated string\s+seen 3×/, "schema: repeated roles");

console.log("grpc-cases.har: 4 bodies decoded (grpc-web, grpc-web-text, gzip, x-protobuf), schema view OK");
