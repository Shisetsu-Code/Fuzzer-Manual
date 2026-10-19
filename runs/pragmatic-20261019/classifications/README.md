# First five visual DEMO classifications

Batch `base-0001.json` contains manual assistant visual analysis of five base screenshots. It is NOT a record of executed clicks, purchases, confirmation dialogs, or explored purchase variants.

- 3 Buzzing Wilds: BUY FREE SPINS $200 — click target classified as `buy`.
- 3 Dancing Monkeys: BUY FREE SPINS $180 — click target classified as `buy`.
- 3 Genie Wishes: no buy visible in BASE screenshot.
- 3 Kingdoms Battle of Red Cliffs: no buy visible in BASE screenshot.
- 3 Magic Eggs: four-option BUY RESPINS MENU, marked `navigate`, plus optional Ante Bet toggle $3.20, marked `other`.

All click coordinates are normalized to the cropped 1025x576 demo screenshot. The `machineReadableMarks` property is shaped for the fuzzer's mark importer/GUI. Before applying a mark, verify screenshot SHA and game slug/symbol; actions marked `buy` may be irreversible even in demos. Descendant screenshots must be captured and reviewed separately before claiming all purchases discovered.

Future snapshot uploads are expected to update image files but not delete this `classifications/` directory. If source SHA changes, revalidate the annotations against the new image.
