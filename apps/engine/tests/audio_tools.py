"""Generate test audio with PyAV (no binary fixtures)."""

from fractions import Fraction
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


def make_offset_aac(path: Path, *, offset: float = 2.0, seconds: float = 1.0, rate: int = 44100) -> Path:
    """An mp4/m4a whose audio starts `offset` seconds into the media timeline."""
    samples = np.sin(2 * np.pi * 440 * np.arange(int(rate * seconds)) / rate)
    tone = (samples * 10000).astype(np.int16)
    with av.open(str(path), "w") as container:
        stream = container.add_stream("aac", rate=rate, layout="mono")
        for i in range(0, len(tone), 1024):
            chunk = np.ascontiguousarray(tone[i : i + 1024]).reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout="mono")
            frame.sample_rate = rate
            frame.pts = int(offset * rate) + i
            frame.time_base = Fraction(1, rate)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return path


def make_stream(
    path: Path, codec: str, *, offset: float, seconds: float = 1.0, late: float | None = None, rate: int = 44100
) -> Path:
    """Mono tone whose timestamps start at `offset` s, optionally followed by one frame at `late` s.

    `path`'s suffix picks the container (`.ts` with `mp2`, `.mka` with `aac`).
    """
    tone = (np.sin(2 * np.pi * 440 * np.arange(int(rate * seconds)) / rate) * 10000).astype(np.int16)
    size = 1152 if codec == "mp2" else 1024

    def frame(chunk: np.ndarray, pts: int) -> av.AudioFrame:
        out = av.AudioFrame.from_ndarray(np.ascontiguousarray(chunk).reshape(1, -1), format="s16", layout="mono")
        out.sample_rate = rate
        out.pts = pts
        out.time_base = Fraction(1, rate)
        return out

    with av.open(str(path), "w") as container:
        stream = container.add_stream(codec, rate=rate, layout="mono")
        for i in range(0, len(tone) - size + 1, size):
            for packet in stream.encode(frame(tone[i : i + size], int(offset * rate) + i)):
                container.mux(packet)
        if late is not None:
            for packet in stream.encode(frame(tone[:size], int(late * rate))):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return path


_LAYOUTS = {1: "mono", 2: "stereo", 3: "2.1", 6: "5.1"}


def tone(seconds: float, rate: int, freq: float = 440.0, amplitude: float = 10000.0) -> np.ndarray:
    return (np.sin(2 * np.pi * freq * np.arange(int(rate * seconds)) / rate) * amplitude).astype(np.int16)


def make_stereo(
    path: Path, left: list[tuple[float, float, int]], right: list[tuple[float, float, int]], *, seconds: float
) -> Path:
    """A 16 kHz stereo WAV, silent (exact zeros) except for `(start s, stop s, value)` spans of constant samples on
    each channel: what one channel says is told apart from the other by its value. See `nonzero_runs`."""
    signal = np.zeros((round(seconds * 16000), 2), dtype=np.int16)
    for channel, spans in enumerate((left, right)):
        for start, stop, value in spans:
            signal[round(start * 16000) : round(stop * 16000), channel] = value
    return make_media(path, "pcm_s16le", rate=16000, channels=2, signal=signal)


def nonzero_runs(samples: np.ndarray, longest: float, stop: object = None) -> list[tuple[int, int]]:
    """A stand-in speech detector (`audio.vad.SpeechDetector`): every run of non-zero samples is one speech segment."""
    on = np.concatenate([[0], (np.asarray(samples) != 0).astype(np.int8), [0]])
    edges = np.flatnonzero(np.diff(on))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2], strict=True)]


def make_media(
    path: Path,
    codec: str,
    *,
    seconds: float = 2.0,
    rate: int = 48000,
    channels: int = 1,
    signal: np.ndarray | None = None,
    video: str | None = None,
    video_seconds: float | None = None,
    audio_offset: float = 0.0,
    video_offset: float = 0.0,
    cover: str | None = None,
    fmt: str | None = None,
) -> Path:
    """A file with one audio stream and optionally a real video stream or cover art; `path`'s suffix (or `fmt`)
    picks the container.

    `signal` is (frames, channels) int16; by default every channel carries the same 440 Hz tone. Audio timestamps
    start at `audio_offset` s, video ones at `video_offset` s; `cover` is the codec of an attached picture.
    """
    layout = _LAYOUTS[channels]
    if signal is None:
        signal = np.repeat(tone(seconds, rate)[:, None], channels, axis=1)
    with av.open(str(path), "w", format=fmt) as container:
        picture = None
        if video is not None:
            picture = container.add_stream(video, rate=10)
            picture.width, picture.height, picture.pix_fmt = 64, 64, "yuv420p"
        art = None
        if cover is not None:
            art = container.add_stream(cover)
            art.width, art.height = 16, 16
            art.pix_fmt = "rgb24" if cover == "png" else "yuvj420p"
            art.disposition = av.stream.Disposition.attached_pic
        # FFmpeg's own Vorbis encoder is marked experimental (there is no libvorbis in PyAV's build).
        options = {"strict": "experimental"} if codec == "vorbis" else {}
        stream = container.add_stream(codec, rate=rate, layout=layout, options=options)
        if art is not None:
            image = av.VideoFrame.from_ndarray(np.full((16, 16, 3), 200, np.uint8), format="rgb24")
            image = image.reformat(format=art.pix_fmt)
            image.pts = 0
            for packet in [*art.encode(image), *art.encode(None)]:
                container.mux(packet)
        if picture is not None:
            for i in range(int((video_seconds or seconds) * 10)):
                frame = av.VideoFrame(64, 64, "yuv420p")
                frame.pts = int(video_offset * 10) + i
                frame.time_base = Fraction(1, 10)
                for packet in picture.encode(frame):
                    container.mux(packet)
            for packet in picture.encode(None):
                container.mux(packet)
        size = stream.codec_context.frame_size or 1024
        for i in range(0, len(signal), size):
            chunk = np.ascontiguousarray(signal[i : i + size]).reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout=layout)
            frame.sample_rate = rate
            frame.pts = int(audio_offset * rate) + i
            frame.time_base = Fraction(1, rate)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    return path
