export interface SensorEntry {
  chip: string;
  bus: string;
  // BOARD_MATCH(...) token if this sensor is gated to a hardware variant.
  variant: string | null;
  // Physical socket key like "SPI1/DEVID2". Sensors sharing a slot are
  // mutually exclusive — only one chip is mounted on that chip-select.
  // Null for non-SPI sensors.
  slot: string | null;
  // Friendly chip name derived from the SPIDEV token (e.g. "ICM42688").
  // Falls back to `chip` (the driver class name) when null.
  chip_display: string | null;
}

export interface FirmwareSupport {
  firmware: string;
  maturity: string;
}

export interface BoardIO {
  uart_count: number;
  uart_buses: string[];
  i2c_count: number;
  i2c_buses: string[];
  spi_count: number;
  spi_buses: string[];
  can_count: number;
  can_buses: string[];
  canfd: boolean;
  usb_count: number;
  pwm: { fmu: number; io: number; total: number };
  ethernet: boolean;
  sdcard: boolean;
  sbus_out: boolean;
  iomcu: boolean;
  // Bidirectional DShot in this hwdef (BIDIR-tagged PWM pin or IOMCU flag).
  bdshot: boolean;
  adc_inputs: number;
  // SERIALn (ArduPilot port number) → hardware UART → physical pads.
  serial_ports: SerialPort[];
}

export interface SerialPort {
  serial: number;          // SERIALn parameter number (index in SERIAL_ORDER)
  device: string;          // USART1, UART7, OTG1 …
  usb: boolean;            // OTGn — USB, no pads
  tx: string | null;       // pad, e.g. "PA9"
  rx: string | null;
  rts: string | null;
  cts: string | null;
  inverted: boolean;       // TXINV/RXINV pins
  protocol: { id: number; name: string; from_hwdef: boolean } | null;
  hint: string | null;     // comment the hwdef author wrote above the pins
}

// A "<slug>-bdshot" firmware target folded into its base board: same PCB,
// different pin map. `io` is the target's own io block.
export interface BdshotTarget {
  slug: string;
  notes: string | null;
  io: BoardIO;
}

export interface BecRail {
  rail: string;
  voltage_v: number;
  current_a: number;
  note: string | null;
}

export interface BoardPower {
  monitor_inputs: number;
  bec: BecRail[];
}

export type VehicleType = "copter" | "plane" | "rover" | "sub" | "tracker" | "blimp";

export interface BoardConnector {
  // Function (what the port does) is the primary field — UART, CAN, GPS, etc.
  function: string | null;
  // Physical connector — JST-GH, USB-C, pin header...
  type: string;
  pin_count: number | null;
  // Multiplier: "2× JST-GH 4P (CAN)" is one row with quantity=2.
  quantity: number;
  label: string | null;
}

export interface BoardDimensions {
  length: number | null;
  width: number | null;
  height: number | null;
}

// A vendor-published document for a board: datasheet, manual, pinout sheet.
//
// URLs only — the PDF stays on the vendor's server. We never host or proxy it,
// which keeps them the source of truth and keeps untrusted binaries out of the
// deployment entirely.
//
// Vendor links rot badly (mrobotics.io now redirects elsewhere, several Matek
// product pages are gone), so `source_page` records where the link was found
// and `checked` records when it last resolved. Both exist so a dead link can
// be re-found rather than merely deleted.
export interface BoardDocument {
  // Link text or document title as the vendor prints it.
  title: string;
  // Absolute URL of the document itself.
  url: string;
  kind: "datasheet" | "manual" | "pinout" | "schematic" | "quickstart" | "other";
  // "pdf" for the common case; some vendors publish only an HTML page.
  format: "pdf" | "html" | "zip" | "other";
  // Which retail product this covers. Must match a name in manual.variants,
  // or null when it applies to the whole firmware target. One target can span
  // several products with different datasheets, so a single URL per board
  // would be wrong for most of them.
  variant: string | null;
  // ISO 639-1. Many vendors publish Chinese-only documentation; saying so is
  // more useful than pretending every link is English.
  language: string | null;
  // The page the link was found on — provenance, and the place to look when
  // the document itself moves.
  source_page: string | null;
  // ISO date the URL last resolved. Null means never verified.
  checked: string | null;
}

export type ManualStatus = "not_started" | "partial" | "complete";

// A retail product that ships against this board's firmware target.
//
// ArduPilot builds one firmware per hwdef, but vendors often sell several
// physically different boards against it — the MatekH743 target covers the
// H743-WING, -SLIM, -MINI and -WLITE. Those products have no hwdef of their
// own, so without this they are invisible to search. Human/AI-curated.
export interface BoardVariant {
  // Retail name as the vendor prints it, e.g. "H743-SLIM".
  name: string;
  // Other spellings people search for ("H743 Slim V3", "H743SLIM").
  aliases: string[];
  // What physically differs from the other variants. One line, buyer-facing.
  differences: string | null;
  dimensions_mm: BoardDimensions | null;
  weight_g: number | null;
  mounting: string | null;
  // Vendor product page for this specific variant.
  product_url: string | null;
  discontinued: boolean;
}

export interface BoardManual {
  // Explicit completion state — set by the human, not inferred.
  status: ManualStatus;
  // Vendor name. The top-level `manufacturer` is build-derived and currently
  // always null from hwdef, so this is where a recovered name lives — it
  // survives re-imports, which the top-level key does not.
  manufacturer: string | null;
  form_factor: string | null;
  // Mounting hole pattern (industry standards: 20×20, 30.5×30.5, etc.)
  mounting: string | null;
  // Assembly state: no soldering / headers included / soldering required.
  assembly: string | null;
  dimensions_mm: BoardDimensions | null;
  weight_g: number | null;
  connectors: BoardConnector[];
  // Filenames of images uploaded via the admin UI. Served from
  // /board-images/<slug>/<filename>. Shown alongside hwdef images.
  images: string[];
  // Direct link to the board's source in the ArduPilot repo (or vendor docs).
  ardupilot_repo_url: string | null;
  // If true, hide from the public selector by default.
  discontinued: boolean;
  // Manual override for the IMU slot count. Used when the hwdef structure
  // doesn't map cleanly to physical reality (alt chips with idiosyncratic
  // SPIDEV layouts, etc). null = use the parser's slot count.
  imu_count: number | null;
  // Retail products covered by this firmware target. Empty = the board is
  // sold as a single product under its own name.
  variants: BoardVariant[];
  // Vendor datasheets and manuals. Human-curated: promoted from ai.documents
  // once the link has been opened and confirmed to be the right board.
  documents: BoardDocument[];
  notes: string | null;
}

export interface BecOutput {
  rail: string | null;
  volts: number | null;
  amps: number | null;
}

// AI-gathered enrichment (vendor pages + docs + local wiki). NON-authoritative:
// a discovery aid only. Chip-level fields are intentionally not surfaced in the
// UI — they're unreliable for multi-revision boards. Verify against docs.
export interface BoardAi {
  manufacturer?: string | null;
  marketing_name?: string | null;
  family?: string | null;
  dimensions_mm?: { length: number | null; width: number | null; height: number | null };
  weight_g?: number | null;
  mounting_pattern_mm?: string | null;
  mounting_hole_dia_mm?: number | null;
  voltage_cells?: string | null;
  voltage_min_v?: number | null;
  voltage_max_v?: number | null;
  bec_outputs?: BecOutput[];
  notable_connectors?: string[];
  blackbox_flash?: string | null;
  osd_chip?: string | null;
  has_osd?: boolean | null;
  wireless?: string | null;
  pinout_notes?: string | null;
  // Documents the extraction pass found on vendor pages. Suggestions only —
  // promoted into manual.documents after a human opens the link.
  documents?: BoardDocument[];
  confidence?: "high" | "medium" | "low";
  sources_used?: string[];
}

export type Platform = "chibios" | "linux";

export interface Board {
  slug: string;
  name: string;
  // HAL family: "chibios" (STM32 flight controllers) or "linux" (SoC/Pi-HAT
  // boards). Linux boards have no MCU line, so `mcu` fields are null.
  platform: Platform;
  manufacturer: string | null;
  mcu: { family: string | null; part: string | null };
  flash_kb: number | null;
  io: BoardIO;
  // "<slug>-bdshot" firmware target folded into this board, or null.
  bdshot_target: BdshotTarget | null;
  power: BoardPower;
  imus: SensorEntry[];
  baros: SensorEntry[];
  compasses: SensorEntry[];
  firmware_support: FirmwareSupport[];
  vehicles: VehicleType[];
  docs_url: string | null;
  repo_url: string | null;
  manual?: BoardManual;
  ai?: BoardAi;
}

// One company, keyed by a canonical id. `aliases` fold the free-text spellings
// that appear in hwdef comments ("Matek", "Mateksys", "Matek Systems") onto a
// single entry, so the filter lists each company once and purchase links
// resolve regardless of which spelling a board carries.
export interface Manufacturer {
  id: string;
  name: string;
  // Normalised alias keys (lowercase, non-alphanumerics collapsed to spaces).
  aliases: string[];
  // Company home page.
  website: string | null;
  // Where to buy direct. Null when the vendor sells only via distributors.
  store_url: string | null;
  // Vendor page listing authorised resellers — the right link for companies
  // with a large distribution network and no meaningful direct store.
  distributors_url: string | null;
  country: string | null;
  // False until a human has confirmed the URLs resolve to the right company.
  verified: boolean;
  // Listed as a Corporate Partner on ArduPilot's own partners page. Matched by
  // domain (or name where the logo filename differs) against
  // common-partners.rst in the wiki — see tools/partners.py.
  ardupilot_partner: boolean;
}

export interface ManufacturersPayload {
  manufacturers: Manufacturer[];
}

export interface BoardsPayload {
  boards: Board[];
}

export type RangefinderKind = "rangefinder" | "proximity";
export type RangefinderDirectionality = "unidirectional" | "omnidirectional";
export type RangefinderTech =
  | "lidar" | "sonar" | "ultrasonic" | "radar" | "tof"
  | "external" | "scripted" | "simulated";

export interface RangefinderTypeId {
  enum: string;
  param_value: number;
}

export interface RangefinderManual {
  status: "not_started" | "partial" | "complete";
  manufacturer: string | null;
  product_url: string | null;
  accuracy_cm: number | null;
  update_rate_hz: number | null;
  min_voltage_v: number | null;
  max_voltage_v: number | null;
  current_ma: number | null;
  weight_g_override: number | null;
  range_min_m_override: number | null;
  range_max_m_override: number | null;
  fov_deg_override: number | null;
  notes: string | null;
}

export interface Rangefinder {
  slug: string;
  kind: RangefinderKind;
  directionality: RangefinderDirectionality;
  display_name: string;
  class_name: string;
  bus: string | null;
  tech: RangefinderTech | null;
  type_ids: RangefinderTypeId[];
  docs_url: string | null;
  wiki_range_min_m: number | null;
  wiki_range_max_m: number | null;
  wiki_weight_g: number | null;
  wiki_fov_deg: number | null;
  manual?: RangefinderManual;
}

export interface RangefindersPayload {
  rangefinders: Rangefinder[];
}
