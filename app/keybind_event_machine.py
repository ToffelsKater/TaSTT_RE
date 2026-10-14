import keyboard
import queue
import time

class KeybindEventMachine:
    def __init__(self, keybind: str):
        self.keybind = keybind
        # The keyboard hook runs on its own thread. SimpleQueue is thread-safe.
        self.events = queue.SimpleQueue()
        keyboard.add_hotkey(keybind, self.onPress)

    def onPress(self) -> None:
        self.events.put(time.time())

    # Returns the timestamp when the keybind was pressed, or 0 if no keypresses
    # are queued.
    def getNextPressTime(self) -> int:
        try:
            return self.events.get_nowait()
        except queue.Empty:
            return 0
