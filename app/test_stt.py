# Run: python app/test_stt.py
import stt

FPS = stt.AudioStream.FPS

def audio(seconds):
    return b"\0\0" * int(seconds * FPS)

def check_forced_cutoff():
    seg = stt.AudioSegmenter.__new__(stt.AudioSegmenter)  # Skip loading Silero.
    seg.min_silence_duration_ms = 100
    seg.max_speech_duration_s = 10

    # Short speech with no pause yet: wait.
    seg.segmentAudio = lambda a: [{"start": 0, "end": 8 * FPS}]
    assert seg.getStableCutoff(audio(8)) == (None, True)

    # Long speech with no pause: Silero split it at 9 s, so cut there.
    seg.segmentAudio = lambda a: [{"start": 0, "end": 9 * FPS},
                                  {"start": 9 * FPS, "end": 12 * FPS}]
    assert seg.getStableCutoff(audio(12)) == (9 * FPS, True)

    # Long speech with no split: cut everything, not just the leading silence.
    seg.segmentAudio = lambda a: [{"start": 1 * FPS, "end": 11 * FPS}]
    assert seg.getStableCutoff(audio(11)) == (11 * FPS, True)

    # A real pause still wins over the forced cut.
    seg.segmentAudio = lambda a: [{"start": 0, "end": 5 * FPS}]
    assert seg.getStableCutoff(audio(12))[0] == 12 * FPS - 800

def check_first_turn():
    assert stt.first_turn("- Danke. - Danke.") == "Danke."
    assert stt.first_turn("- Ja.") == "Ja."
    # Dashes inside a normal sentence stay.
    assert stt.first_turn("Paris - London") == "Paris - London"

if __name__ == "__main__":
    check_forced_cutoff()
    check_first_turn()
    print("ok")
