"""Make src/aftertalk/assets/test-2s.wav: about two seconds of one spoken English sentence, 16 kHz mono s16.

The sentence is macOS text-to-speech output (`say`), so run this on a Mac:
    say -r 120 -o /tmp/test-audio.aiff "Testing one two three."
    uv run --project apps/engine python apps/engine/scripts/make_test_audio.py /tmp/test-audio.aiff

Replace the committed file with a recording we own before a public release.
"""

import sys
from pathlib import Path

import av

OUT = Path(__file__).resolve().parent.parent / "src" / "aftertalk" / "assets" / "test-2s.wav"
RATE = 16000


def convert(source: Path, target: Path) -> float:
    samples = 0
    with av.open(str(source)) as inp, av.open(str(target), "w", format="wav") as out:
        stream = out.add_stream("pcm_s16le", rate=RATE, layout="mono")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
        for frame in inp.decode(inp.streams.audio[0]):
            for resampled in resampler.resample(frame):
                samples += resampled.samples
                for packet in stream.encode(resampled):
                    out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    return samples / RATE


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    print(f"wrote {OUT} ({convert(Path(sys.argv[1]), OUT):.2f} s)")
