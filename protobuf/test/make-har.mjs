import protobuf from "protobufjs";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
const root = protobuf.parse(`syntax="proto3";
message User { int64 id = 1; string name = 2; repeated string roles = 3; Address addr = 4; bool active = 5; double balance = 6; }
message Address { string city = 1; int32 zip = 2; }
message ListUsersResponse { repeated User users = 1; string next_page_token = 2; }`).root;
const T = root.lookupType("ListUsersResponse");
const payload = Buffer.from(T.encode(T.fromObject({ users: [
  { id: 1001, name: "王小明", roles: ["admin", "dev"], addr: { city: "Taipei", zip: 100 }, active: true, balance: 1234.5 },
  { id: 1002, name: "Alice", roles: ["viewer"], addr: { city: "Tainan", zip: 700 }, balance: -20.25 } ],
  nextPageToken: "page-2" })).finish());
const frame = (flags, body) => Buffer.concat([Buffer.from([flags, ...[24, 16, 8, 0].map((s) => (body.length >>> s) & 255)]), body]);
const trailer = frame(0x80, Buffer.from("grpc-status:0\r\ngrpc-message:OK\r\n"));
const grpcWeb = Buffer.concat([frame(0, payload), trailer]);
const textChunks = frame(0, payload).toString("base64") + trailer.toString("base64"); // two independently padded chunks
const gz = Buffer.concat([frame(1, gzipSync(payload)), trailer]);
const entry = (url, mime, body, enc = "base64", extraHeaders = []) => ({ startedDateTime: "2026-10-19T10:00:00.000Z", time: 5,
  request: { method: "POST", url, httpVersion: "HTTP/1.1", cookies: [], headers: [{ name: "content-type", value: mime }], queryString: [], headersSize: -1, bodySize: 0 },
  response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", cookies: [], headers: [{ name: "content-type", value: mime }, ...extraHeaders],
    content: { size: body.length, mimeType: mime, text: enc === "base64" ? body.toString("base64") : body.toString(), ...(enc === "base64" ? { encoding: "base64" } : {}) },
    redirectURL: "", headersSize: -1, bodySize: body.length }, cache: {}, timings: { send: 0, wait: 5, receive: 0 } });
writeFileSync("grpc-cases.har", JSON.stringify({ log: { version: "1.2", creator: { name: "handmade", version: "1" }, entries: [
  entry("https://api.example.test/users.v1.Users/List", "application/grpc-web+proto", grpcWeb),
  entry("https://api.example.test/users.v1.Users/List", "application/grpc-web-text", Buffer.from(textChunks), "text"),
  entry("https://api.example.test/users.v1.Users/List", "application/grpc-web+proto", gz, "base64", [{ name: "grpc-encoding", value: "gzip" }]),
  entry("https://api.example.test/v1/users", "application/x-protobuf", payload),
  entry("https://api.example.test/health", "application/json", Buffer.from('{"ok":true}'), "text") ] } }));
console.log("payload", payload.length, "bytes; text body has", (textChunks.match(/=/g) || []).length, "padding chars in the middle/end");
