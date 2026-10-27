# 🔍 format-readers: small readers for formats that hide what an app does

**English** | [繁體中文](README.zh-TW.md)

Three small, read-only command-line readers for formats you keep running into when you look inside apps:

| Reader | Reads | Checked against |
|---|---|---|
| [`protobuf/pbdecode.mjs`](protobuf/pbdecode.mjs) | Protobuf messages without a schema, gRPC / gRPC-web / grpc-web-text frames, HAR captures | Google's `protoc --decode_raw` |
| [`pyinstaller/pyinst.mjs`](pyinstaller/pyinst.mjs) | PyInstaller executables (CArchive + PYZ), turns the app back into runnable `.pyc` files | `pyinstxtractor`, and running the result |
| [`hermes/hbc.mjs`](hermes/hbc.mjs) | Hermes bytecode (React Native `index.android.bundle`), versions 76–99 | `hermes-dec` |

- 📦 Plain Node.js, no dependencies at runtime. No Python needed, even to unpack a PyInstaller app built with a Python version you don't have.
- 🧪 Every reader is tested against an established tool on real compiler/packager output, in CI on every push.
- 🔒 Read-only: nothing is executed, and extraction only writes inside the folder you name.

[![CI](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml/badge.svg)](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml)

---

## 🚀 Quick start

Needs Node.js 20 or later.

```bash
git clone https://github.com/KJLavender/format-readers
cd format-readers

node protobuf/pbdecode.mjs capture.har --schema      # protobuf/gRPC bodies in a HAR, as an inferred schema
node pyinstaller/pyinst.mjs app.exe                  # what's inside a PyInstaller executable
node pyinstaller/pyinst.mjs app.exe --extract out/   # unpack it; out/app.pyc runs with the matching Python
node hermes/hbc.mjs index.android.bundle             # version, integrity, named functions, URLs and keys
```

Every reader also takes `--json`.

---

## 🧩 The readers

### 1. protobuf: decode protobuf without the `.proto`

```bash
node protobuf/pbdecode.mjs capture.har               # every protobuf/gRPC body in the capture, annotated
node protobuf/pbdecode.mjs capture.har --schema      # one inferred schema per body (much shorter)
node protobuf/pbdecode.mjs message.bin --protoc      # exactly what protoc --decode_raw prints
```

- Byte offsets for every field. Anything ambiguous (a length-delimited field can be a string, bytes, a nested message or packed numbers) is marked as inferred, with the other readings listed.
- gRPC framing: data vs trailer frames, `grpc-status`, `application/grpc-web-text` (including several base64 chunks), gzip/deflate frames.
- `--schema` merges repeated fields into one tree with counts, value ranges and examples. When a few short strings happen to also parse as messages, a majority vote reads them as text.

What it can't do: tell you field *names*. Those only exist in the schema, which usually ships somewhere in the client.

### 2. pyinstaller: unpack a PyInstaller executable

```bash
node pyinstaller/pyinst.mjs app.exe            # Python version, onefile/onedir, entry point, app modules
node pyinstaller/pyinst.mjs app.exe --extract out/
```

- Finds the archive even when a code signature follows it.
- Reads the module table with a small built-in `marshal` reader, so it works without the matching Python installed.
- Rebuilds `.pyc` headers, so the extracted entry point runs: `PYTHONPATH=out/PYZ python out/app.pyc`.
- Lists only app and third-party modules (anything outside the stdlib), which is usually the interesting part.

Turning `.pyc` back into source is out of scope; use a decompiler such as pycdc.

### 3. hermes: read a React Native bundle

```bash
node hermes/hbc.mjs index.android.bundle             # summary
node hermes/hbc.mjs index.android.bundle --strings   # every string with its kind
```

- Header, SHA-1 integrity footer, function table (including the "large" headers used when a function or its name index doesn't fit) and string table (Latin-1, UTF-16, long strings).
- Picks out URLs, key-like strings and API paths, and lists named functions first.

No disassembly or decompilation; hermes-dec and hbctool do that.

---

## 🧪 How it's tested

| Reader | Test | Result |
|---|---|---|
| protobuf | 300 generated messages, 500 with random bytes changed, 300 random byte strings vs `protoc --decode_raw` | byte-for-byte identical output, including the valid/invalid verdict |
| protobuf | gRPC-web, grpc-web-text, gzip frame and raw `x-protobuf` bodies in a HAR | all decoded, trailers included |
| pyinstaller | Sample app built with PyInstaller (onefile and onedir), Python 3.11 and 3.13 | every extracted file byte-identical to pyinstxtractor; the extracted `app.pyc` prints the same output as the executable |
| hermes | Same program compiled by hermesc 0.8.0, 0.11.0, the one bundled with React Native 0.76, and two 1.0.0 builds (bytecode v83, v84, v96, v98, v99) | header, strings and functions identical to hermes-dec |
| hermes | Stress file: 802 functions, 3,204 strings, one 197 KB function | identical, overflowed headers exercised on every version |

Run them yourself (the PyInstaller and Hermes tests need a Python with `pyinstaller` / `hermes-dec`):

```bash
npm ci
npm run test:protobuf
PYTHON=python3 npm run test:pyinstaller
PYTHON=python3 npm run test:hermes
```

The v96 compiler only ships inside the `react-native` package. To include it, unpack `react-native@0.76.x` and set `HERMESC_RN_DIR` to its `package/` folder (CI does this).

Outside the automated tests, the readers were also run on files from real installed software: 93 protobuf files from a Chrome profile (identical to protoc), a signed Python 3.14 PyInstaller app (all 151 modules unpacked, which pyinstxtractor skips without Python 3.14), and the BlueWallet 8.0.2 Android bundle (40,594 functions and 109,320 strings, read in 0.16 s).

## 🐛 Things the comparisons turned up

- In my own decoder: varints could be read past the end of a nested message; protoc silently truncates tags wider than 32 bits; protoc stops printing nested messages after 10 levels. All three now match protoc.
- In hermes-dec: a string holding just U+FEFF comes back empty, because Python's `utf-16` codec treats it as a byte-order mark. The Hermes test keeps a case for it.

---

## 📚 Background

These started as prototypes while I was exploring [REA](https://github.com/morluto/rea), an MCP server for reverse engineering. Some of it went upstream:

- [morluto/rea#5029](https://github.com/morluto/rea/pull/5029): source selections from a JSON file (merged, in REA 6.8.0)
- [morluto/rea#4986](https://github.com/morluto/rea/issues/4986): protobuf/gRPC body decoding (implemented in REA 6.8.0)
- [morluto/rea#7038](https://github.com/morluto/rea/issues/7038): Hermes bytecode support (proposed)

## ⚖️ Use responsibly

These readers are for understanding software you own or are allowed to examine: debugging, interoperability, security research, learning. They don't decrypt anything or get around protections. Check the license of whatever you look at.

## 📄 License

[MIT](LICENSE)
