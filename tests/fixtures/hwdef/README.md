# Parser fixtures

Copied **verbatim** (unmodified) from a local ArduPilot checkout
(`~/ardupilot`) so `tests/test_parser.py` never depends on that checkout
existing. Only `hwdef.dat` / `hwdef.inc` files are copied — bootloader
(`hwdef-bl.dat`), `defaults.parm`, images and READMEs are left out because
`parse_board()` never reads them.

| Directory | Source | Parser path it exercises |
|---|---|---|
| `MatekF405/` | `AP_HAL_ChibiOS/hwdef/MatekF405` | Plain, single-file autopilot: MCU/flash, one SPI IMU, one I2C baro, `SERIAL_ORDER`, SPI/I2C bus lists. Used for the golden snapshot. Its `hwdef.dat` references `include ../include/minimize_fpv_osd.inc`, which is **not** copied (it only carries firmware-size `define`s, nothing `parse_board()` reads) — `_expand_includes()` resolves a missing include to `""`, so this is also a quiet check that a dangling include doesn't blow up the parser. |
| `MatekH743/` + `MatekH743-bdshot/` | `AP_HAL_ChibiOS/hwdef/{MatekH743,MatekH743-bdshot}` | The bdshot fold (`merge_bdshot_targets`): `MatekH743-bdshot/hwdef.dat` does `include ../MatekH743/hwdef.dat` then `undef`s and redeclares pins to add `BIDIR` dshot — this is the exact pin-remap case called out in `_apply_pin_undefs()`'s docstring ("MatekH743-bdshot reported 25 PWM outputs instead of 12"). Both directories must stay siblings for the relative `include` to resolve. |
| `Pixhawk6X/` | `AP_HAL_ChibiOS/hwdef/Pixhawk6X` | `BOARD_MATCH(...)`-gated IMUs (multiple hardware revisions sharing one hwdef — `FMUV6_BOARD_HOLYBRO_6X`, `..._CUAV_6X`, `..._HOLYBRO_6X_REV6`, `..._HOLYBRO_6X_45686`), **and** an IOMCU (`IOMCU_UART USART6`) with IOMCU-side bidirectional dshot (`define HAL_WITH_IO_MCU_BIDIR_DSHOT 1`). One self-contained file (no includes) conveniently exercises both the BOARD_MATCH and IOMCU paths. |
| `navio2/` | `AP_HAL_Linux/hwdef/navio2` | Linux-HAL board: no `MCU`/`FLASH_SIZE_KB` line at all (`mcu_family`/`mcu_part`/`flash_kb` all `None`), `LINUX_SPIDEV` instead of `SPIDEV`, no `SERIAL_ORDER`. Confirms the parser degrades gracefully for the non-ChibiOS platform. |
| `f303-MatekGPS/` | `AP_HAL_ChibiOS/hwdef/f303-MatekGPS` | Peripheral rejected by name: `is_autopilot()` returns `False` because the slug contains `GPS` (one of `PERIPHERAL_PATTERNS`) — rejected before `hwdef.dat` is even read. |
| `CarbonixF405/` | `AP_HAL_ChibiOS/hwdef/CarbonixF405` | Peripheral rejected by content, not name: `is_autopilot("CarbonixF405")` is `True` (no matching name pattern — it's `env AP_PERIPH 1` build, a CAN sensor node with only a compass + baro), but `parse_board()` still returns `None` because it declares no `IMU` line. Distinct code path from `f303-MatekGPS` above (name-pattern rejection happens up front; this is dropped later by the `if not imus: return None` check). |

No bootloader directory (`bootloader*`/`*-bl`) exists in the current
ArduPilot tree to copy for the "starts with `bootloader`" / "ends with
`-bl`" half of `is_autopilot()`; `CarbonixF405` covers the "dropped for
lacking an IMU" half of item (g) instead, and `test_rejects_peripherals`
covers name-pattern rejection generally.

`test_undef_is_honoured` uses a **synthetic** hwdef built in a `tmp_path`
rather than a fixture here — every real `undef IMU`/`undef BARO` hwdef found
in the ArduPilot tree only defines its sensors after including a parent
hwdef (e.g. `KakuteH7v2` → `KakuteH7-bdshot` → `KakuteH7`), so a "minimal"
copy would mean pulling in a multi-file include chain unrelated to what the
test is checking.
