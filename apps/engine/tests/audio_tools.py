"""Generate test audio with PyAV (no binary fixtures)."""

from pathlib import Path

import av
import numpy as np


def make_tone(
    path: Path, *, seconds: float = 2.0, rate: int = 44100, channels: int = 2, codec: str = "pcm_s16le"
) -> Path:
    """A 440 Hz sine tone; `path`'s suffix picks the container."""
    layout = "stereo" if channels == 2 else "mono"
    t = np.arange(int(rate * seconds)) / rate
    tone = (np.sin(2 * np.pi * 440 * t) * 10000).astype(np.int16)
    interleaved = np.ascontiguousarray(np.repeat(tone[None, :], channels, axis=0).T).reshape(1, -1)
    with av.open(str(path), "w") as container:
        stream = container.add_stream(codec, rate=rate, layout=layout)
        frame = av.AudioFrame.from_ndarray(interleaved, format="s16", layout=layout)
        frame.sample_rate = rate
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return path
