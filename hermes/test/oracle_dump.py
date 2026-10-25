"""Dump hermes-dec's parse of an .hbc file as JSON, for comparison with hbc.mjs."""
import json
import logging
import sys

from hermes_dec.parsers.hbc_file_parser import HBCReader

logging.disable(logging.WARNING)

reader = HBCReader()
with open(sys.argv[1], "rb") as f:
    reader.read_whole_file(f)

header = {name: getattr(reader.header, name) for name, *_ in reader.header._fields_}
header["sourceHash"] = bytes(header["sourceHash"]).hex()
for flag in ("staticBuiltins", "cjsModulesStaticallyResolved", "hasAsync"):
    header[flag] = bool(header[flag])
del header["magic"]

print(json.dumps({
    "header": header,
    "strings": [
        {"kind": reader.string_kinds[i].name.lower(), "text": s}
        for i, s in enumerate(reader.strings)
    ],
    "functions": [
        {
            "name": reader.strings[fh.functionName],
            "params": fh.paramCount,
            "bytecode_size": fh.bytecodeSizeInBytes,
            "offset": fh.offset,
        }
        for fh in reader.function_headers
    ],
}, ensure_ascii=False))
