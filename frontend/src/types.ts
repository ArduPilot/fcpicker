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
  // Slug of a sibling "<slug>-bdshot" hwdef that adds it, if one exists.
  bdshot_variant: string | null;
  adc_inputs: number;
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

export type ManualStatus = "not_started" | "partial" | "complete";

export interface BoardManual {
  // Explicit completion state — set by the human, not inferred.
  status: ManualStatus;
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
