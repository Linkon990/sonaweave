# ggwave balanced speeds for SonaWeave 0.2.2

This is a local, single-file WASM build of ggwave 0.4.0. Production loads one
factory and creates two receiver instances (marker thresholds 3 and 6).
The npm `ggwave@0.4.0` dependency remains the independent interoperability oracle
in tests. It is not a second production receiver.

| UI speed | Protocol | Data frames/group | First FFT bin | First frequency |
| --- | --- | ---: | ---: | ---: |
| 较慢 (`normal`) | Custom 0 | 5 | 41 | 1921.875 Hz |
| 标准 (`fast`) | Custom 1 | 4 | 45 | 2109.375 Hz |
| 较快 (`fastest`) | Audible Fastest | 3 | 40 | 1875 Hz |

All use the original 48 kHz clock, 1024-sample frame, three bytes/group,
six simultaneous data tones and 16-frame start/end markers. They do not speed up
playback or resample the transmitter. Custom protocol top frequencies are
6375 Hz and 6562.5 Hz; Audible Fastest remains 6328.125 Hz.

The new receiver accepts custom 5/4-frame messages and original Audible
Normal/Fast/Fastest (9/6/3-frame) messages. Ordinary upstream clients do not know
the two custom formats. Use **较快** for sending to an unmodified ggwave/GibberLink
receiver. Original 9/6-frame recordings remain receivable by SonaWeave.

## Receive fixes

`balanced.cpp` registers custom protocols through the upstream C++ API. It
disables all receive protocols first, including mono-tone IDs omitted from the
upstream JavaScript enum. The adapter then enables the five required formats.

`receiver-candidates.patch` changes receive candidate selection only:

1. The upstream variable-length decoder returns the first Reed–Solomon-valid
   candidate. Short packets have only two ECC bytes; an incorrect speed can
   also form a valid codeword. For example, official Fastest `ok` could become
   two NUL bytes when the official three speeds were received together. The
   patch compares all valid candidates by tone concentration in their observed
   symbol bands, preserves the best recovered bytes, and returns that candidate.
2. Candidate scoring has an explicit array bound and tracks groups actually
   read. Whole unread groups cannot pass the completeness check. The original
   140-byte buffer omits its final partially padded group, so fewer than three
   missing bytes remain correctable; that missing group contributes zero score.
3. End markers must use the frequency locked by the start marker. A different
   protocol's marker must not end the current packet.

The custom first bins are 41 and 45. The initially considered 41/42 combination
has a start/end marker alias: a marker shifted by two bins has the inverse
pattern. It can even start a spurious new packet and clear just-decoded data.
41/45 avoids that combination and passes the short-packet regressions.

These are acoustic candidate checks, not a cryptographic checksum. Raw UTF-8 and
the upstream Reed–Solomon wire format are preserved. No payload prefix, trailer,
CRC, or length reduction is introduced.

## Provenance and rebuild

- Upstream: <https://github.com/ggerganov/ggwave>
- Tag: `ggwave-v0.4.0`
- Commit: `e035c75be1916ed8c0d1a38e823981366da3971e`
- Emscripten: **3.1.6**, release build `8791c3e936141cbc2dd72d76290ea9b2726d39f3`
- Compiler flags: `-std=c++11 -O3 --bind -s MODULARIZE=1
  -s ALLOW_MEMORY_GROWTH=1 -s SINGLE_FILE=1 -s EXPORT_NAME=ggwave_factory`
- No `-ffast-math`; upstream FFT, Reed–Solomon and transmitter sources are unchanged.
- Both upstream MIT notices are included in `LICENSE` and the app's public notices.
- JavaScript artifact: 157,219 bytes, including embedded WASM.
- Artifact SHA-256: `9037290e64efbb51b5f11378d7f4885640bcb3e90d2ff7779120bfe8785f3c52`
- Receive patch SHA-256: `35dfadb3db04ed52632ed18a21cf08a4e1e891d48caa6b578c9d68eeb1f94c7c`
- Official Windows toolchain ZIP SHA-256:
  `e7005c0a5439e532cb64f34ba90405792288a1ed8845cdafcedd3de5af6fd3f2`

From this directory, using an installed Emscripten 3.1.6 and existing Node.js:

```powershell
python build.py --emscripten-root D:/AndroidDev/Temp/ggwave-custom-022/emsdk-main/upstream/emscripten --work-dir D:/AndroidDev/Temp/ggwave-custom-022
```

`build.py` downloads only the required exact-commit source files, verifies their
individual SHA-256 values, applies the checked-in patch with exact context
checks, and emits `ggwave.cjs`. The build config, compiler cache and temporary
files stay in the supplied work directory. No global SDK activation is needed.
Vite's bare `ggwave-balanced` alias and dependency prebundling support dev;
`build.commonjsOptions` supports production and the worker bundle.

## Validation on 2026-09-13

For `你好，声织已就绪。` (27 UTF-8 bytes), actual generated PCM lengths are
104448 / 90112 / 75776 samples: **2.176 / 1.877333 / 1.578667 seconds**.
The original durations were 3.370667 / 2.474667 / 1.578667 seconds.
At 140 bytes the new durations are 7.829333 / 6.4 / 4.970667 seconds.

The three preserved Fastest waveforms (5, 27 and 140 bytes) match the independent
npm original **byte for byte**, including the exact floating-point samples.
The adapter's 53 tests cover 44.1/48 kHz input, 128/777-sample chunks, UTF-8/emoji,
140-byte input, legacy formats, short-codeword ambiguity, quiet noise/echo,
borrowed-view ownership and lifecycle behavior. `npm run build` also passes.

Additional prototype matrices passed: 330 short-message/protocol/threshold
cases; 498 cases spanning 1–12-byte varied messages and both sample rates;
288 low-entropy cases with repeated `A`, `0`, spaces and NULs. These are digital
and synthetic-channel checks, not a speaker-to-microphone field guarantee.

Candidate comparison uses more CPU than first-success selection. On the test
Windows desktop at 48 kHz, a complete two-instance decode of the 27-byte new
formats took approximately 19–32 ms; 140-byte new formats took 67–85 ms. An old
140-byte 9-frame recording took about 188 ms (upstream first-success about
22 ms). These measurements include streaming and final packet analysis, are
hardware-dependent, and are not Android battery or real-time performance claims.
