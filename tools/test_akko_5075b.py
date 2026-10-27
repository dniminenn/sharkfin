"""Hardware-backed defaults for the USB 3151:4015 Akko 5075B Plus."""
import json
from pathlib import Path
import unittest

from extract_vendor_data import load_extras

DATA = Path(__file__).resolve().parents[1] / "app/src-tauri/data"


class Akko5075BDefaults(unittest.TestCase):
    def test_hardware_defaults_and_regeneration_agree(self):
        devices = json.loads((DATA / "devices.json").read_text())
        board = next(d for d in devices if d["id"] == 1042)
        self.assertEqual(board["family"], "yc500")
        self.assertEqual((board["vendorId"], board["productId"]), (0x3151, 0x4015))
        self.assertIs(board["ledFlagsSwapped"], True)
        self.assertIs(board["features"]["sideLight"], True)
        self.assertTrue(board["sideLightLayout"])
        self.assertEqual(board["keyLayout"], "Unknown")
        _, overrides = load_extras(DATA / "devices.extra.json")
        override = overrides[1042]
        for field, value in override.items():
            self.assertEqual(board[field], value, field)


if __name__ == "__main__":
    unittest.main()
