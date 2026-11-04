# format-readers

**English** | [繁體中文](README.zh-TW.md)

Three small command-line tools that open file formats apps use internally, so you can see what an app sends over the network or ships inside its files. They only read. They never run the file you give them.

| Tool | What it reads | Compared against |
|---|---|---|
| [`protobuf/pbdecode.mjs`](protobuf/pbdecode.mjs) | Protobuf messages (a compact binary format) without the schema file, gRPC and gRPC-web frames, and HAR files (saved browser traffic) | `protoc --decode_raw` |
| [`pyinstaller/pyinst.mjs`](pyinstaller/pyinst.mjs) | Executables made by PyInstaller, which bundles a Python app into one program. It turns them back into runnable `.pyc` files | `pyinstxtractor`, and running the result |
| [`hermes/hbc.mjs`](hermes/hbc.mjs) | Hermes bytecode, the compiled form of React Native apps (`index.android.bundle`), versions 76 to 99 | `hermes-dec` |

They are plain Node.js with no runtime dependencies. You do not need Python, even to unpack an app built with a Python version you don't have. Extraction only writes inside the folder you name.

[![CI](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml/badge.svg)](https://github.com/KJLavender/format-readers/actions/workflows/ci.yml)

## Run it

You need Node.js 20 or later.

```bash
git clone https://github.com/KJLavender/format-readers
cd format-readers

node protobuf/pbdecode.mjs capture.har --schema      # protobuf/gRPC bodies in a HAR, as a guessed schema
node pyinstaller/pyinst.mjs app.exe                  # what is inside a PyInstaller executable
node pyinstaller/pyinst.mjs app.exe --extract out/   # unpack it; out/app.pyc runs with the matching Python
node hermes/hbc.mjs index.android.bundle             # version, integrity check, named functions, URLs and keys
```

All three accept `--json` for machine-readable output.

## protobuf

Protobuf messages are just numbered fields. The field names live in a `.proto` schema file, which you often don't have. This tool decodes the message anyway.

```bash
node protobuf/pbdecode.mjs capture.har               # every protobuf/gRPC body in the capture, field by field
node protobuf/pbdecode.mjs capture.har --schema      # one guessed schema per body (much shorter)
node protobuf/pbdecode.mjs message.bin --protoc      # same text that protoc --decode_raw prints
```

- It shows the byte offset of every field.
- Some fields are ambiguous. A length-prefixed field can be a string, raw bytes, a nested message or packed numbers. The tool marks these as guesses and lists the other readings.
- For gRPC it separates data frames from trailer frames, shows `grpc-status`, and handles `application/grpc-web-text` (including several base64 chunks) and gzip/deflate frames.
- `--schema` merges repeated fields into one tree with counts, value ranges and examples.

It cannot recover field names, because only the schema has them.

The tool also accepts `--record N`, `--all` and `--grpc`. Run it without arguments to see the usage line.

## pyinstaller

```bash
node pyinstaller/pyinst.mjs app.exe                  # Python version, onefile or onedir, entry point, app modules
node pyinstaller/pyinst.mjs app.exe --extract out/
```

- It finds the archive even when a code signature follows it.
- It reads the module table with its own small `marshal` reader (marshal is Python's serialization format), so the matching Python does not need to be installed.
- It rebuilds the `.pyc` headers, so the extracted entry point runs: `PYTHONPATH=out/PYZ python out/app.pyc`.
- It lists only the app's own modules and third-party packages, not the standard library.

It does not turn `.pyc` back into source code. Use a decompiler such as pycdc for that.

## hermes

```bash
node hermes/hbc.mjs index.android.bundle             # summary
node hermes/hbc.mjs index.android.bundle --strings   # every string and its kind
```

- It reads the header, the SHA-1 checksum at the end, the function table and the string table (Latin-1, UTF-16 and long strings).
- It picks out URLs, strings that look like keys, and API paths. Named functions come first.

It does not disassemble or decompile. hermes-dec and hbctool do that.

## Tests

Each tool is tested against the reference tool on files made by the real compiler or packager. CI runs all of this on every push.

| Tool | Test | Result |
|---|---|---|
| protobuf | 300 generated messages, 500 with random bytes changed, 300 random byte strings, compared with `protoc --decode_raw` | Output is identical, including whether the input is valid |
| protobuf | gRPC-web, grpc-web-text, gzip frame and raw `x-protobuf` bodies in a HAR | All decoded, trailers included |
| pyinstaller | Sample app built with PyInstaller (onefile and onedir), Python 3.11 and 3.13 | Every extracted file is byte-identical to pyinstxtractor; the extracted `app.pyc` prints the same output as the executable |
| hermes | Same program compiled by hermesc 0.8.0, 0.11.0, the one in React Native 0.76, and two 1.0.0 builds (bytecode v83, v84, v96, v98, v99) | Header, strings and functions match hermes-dec |
| hermes | Stress file with 802 functions, 3,204 strings and one 197 KB function | Identical on every version |

To run them yourself:

```bash
npm ci
npm run test:protobuf
PYTHON=python3 npm run test:pyinstaller
PYTHON=python3 npm run test:hermes
```

The PyInstaller test needs a Python with `pyinstaller` installed. To also compare against pyinstxtractor, put `pyinstxtractor.py` in `pyinstaller/test/` (CI downloads it); without it that comparison is skipped. The Hermes test needs a Python with `hermes-dec` installed.

The v96 compiler only ships inside the `react-native` package. To include it, unpack `react-native@0.76.x` and set `HERMESC_RN_DIR` to its `package/` folder. CI does this.

The tools were also run on real software: 93 protobuf files from a Chrome profile (identical to protoc), a signed Python 3.14 PyInstaller app (all 151 modules unpacked; pyinstxtractor skips it without Python 3.14), and the BlueWallet 8.0.2 Android bundle (40,594 functions and 109,320 strings, read in 0.16 s).

### Bugs the comparisons found

- In this project's protobuf decoder: varints could be read past the end of a nested message. protoc silently cuts off tags wider than 32 bits. protoc stops printing nested messages after 10 levels. The decoder now matches protoc on all three.
- In hermes-dec: a string that is only U+FEFF comes back empty, because Python's `utf-16` codec treats it as a byte-order mark. The Hermes test keeps a case for it.

## Background

These started as prototypes while exploring [REA](https://github.com/morluto/rea), an MCP server for reverse engineering. Some of the work went upstream:

- [morluto/rea#5029](https://github.com/morluto/rea/pull/5029): source selections from a JSON file (merged, in REA 6.8.0)
- [morluto/rea#4986](https://github.com/morluto/rea/issues/4986): protobuf/gRPC body decoding (implemented in REA 6.8.0)
- [morluto/rea#7038](https://github.com/morluto/rea/issues/7038): Hermes bytecode support (proposed)

## Use

Use these tools on software you own or are allowed to examine: debugging, interoperability, security research, learning. They do not decrypt anything or get around protections. Check the license of whatever you look at.

## License

[MIT](LICENSE)
