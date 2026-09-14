export const meta = {
  name: 'fc-verify-enrich',
  description: 'Local-first cross-correlate + spec-harvest every FC board cluster (hwdef/README/local wiki/manufacturer)',
  phases: [{ title: 'Verify' }],
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['base', 'manufacturer', 'docs_url_correct', 'discrepancies', 'confidence', 'sources_used'],
  properties: {
    base: { type: 'string' },
    cluster_slugs: { type: 'array', items: { type: 'string' } },
    manufacturer: { type: ['string', 'null'] },
    marketing_name: { type: ['string', 'null'], description: 'vendor product name, e.g. "Holybro Kakute F7 AIO"' },
    family: { type: ['string', 'null'] },
    // wiki
    docs_url_correct: { type: 'boolean', description: 'does our docs_url point to THIS exact board?' },
    correct_wiki_stem: { type: ['string', 'null'], description: 'if wrong, the correct local wiki .rst stem e.g. common-holybro-kakutef7aio' },
    // chips (resolve real part numbers, not driver-family aliases)
    mcu_part: { type: ['string', 'null'] },
    imu_models: { type: 'array', items: { type: 'string' }, description: 'real IMU part numbers physically on the board' },
    baro_models: { type: 'array', items: { type: 'string' } },
    compass_models: { type: 'array', items: { type: 'string' } },
    osd_chip: { type: ['string', 'null'] },
    blackbox_flash: { type: ['string', 'null'], description: 'onboard dataflash, e.g. "16MB" or chip' },
    has_sdcard: { type: ['boolean', 'null'] },
    // physical
    length_mm: { type: ['number', 'null'] },
    width_mm: { type: ['number', 'null'] },
    height_mm: { type: ['number', 'null'] },
    weight_g: { type: ['number', 'null'] },
    mounting_pattern_mm: { type: ['string', 'null'], description: 'hole spacing e.g. "30.5x30.5" or "20x20"' },
    mounting_hole_dia_mm: { type: ['number', 'null'], description: 'e.g. 3 for M3, 2 for M2' },
    // power
    voltage_cells: { type: ['string', 'null'], description: 'e.g. "2-6S"' },
    voltage_min_v: { type: ['number', 'null'] },
    voltage_max_v: { type: ['number', 'null'] },
    bec_outputs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          rail: { type: ['string', 'null'] },
          volts: { type: ['number', 'null'] },
          amps: { type: ['number', 'null'] },
        },
      },
    },
    // io / features
    uart_count: { type: ['number', 'null'] },
    can_count: { type: ['number', 'null'] },
    notable_connectors: { type: 'array', items: { type: 'string' }, description: 'e.g. JST-GH, DJI O3, ELRS pads' },
    has_baro: { type: ['boolean', 'null'] },
    has_osd: { type: ['boolean', 'null'] },
    wireless: { type: ['string', 'null'], description: 'onboard ELRS/Bluetooth/WiFi if any' },
    pinout_notes: { type: ['string', 'null'], description: 'short summary of UART/motor/connector layout' },
    // cross-correlation
    field_checks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['field', 'agree'],
        properties: {
          field: { type: 'string' },
          hwdef: { type: ['string', 'null'] },
          readme: { type: ['string', 'null'] },
          wiki: { type: ['string', 'null'] },
          manufacturer: { type: ['string', 'null'] },
          agree: { type: 'string', enum: ['agree', 'disagree', 'partial', 'unknown'] },
        },
      },
    },
    discrepancies: { type: 'array', items: { type: 'string' } },
    sources_used: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const clusters = typeof args === 'string' ? JSON.parse(args) : args
log(`verifying + enriching ${clusters.length} board clusters (local-first)`)

function buildPrompt(c) {
  const variants = (c.slugs || [c.base]).join(', ')
  // Linux (SoC / Pi-HAT) boards live in AP_HAL_Linux and have only a hwdef.dat.
  const hwdefDir = c.hwdef_dir || `/Users/fred/ardupilot/libraries/AP_HAL_ChibiOS/hwdef/${c.base}`
  const platformNote = c.platform === 'linux'
    ? `\nThis is a LINUX board (SoC / Raspberry-Pi HAT style, not an STM32 flight controller). Its hwdef is ${hwdefDir}/hwdef.dat only (no README, no MCU line); mcu_part is the SoC/companion chip if documented, else null. Physical specs come from the wiki and manufacturer page.`
    : ''
  return `You are verifying AND enriching ArduPilot flight-controller catalog data for board **${c.base}**.${platformNote}
Firmware-identical variants in this cluster (same physical hardware): ${variants}.
Be rigorous, skeptical, and LOCAL-FIRST. Only use the web to fill a physical spec that the local sources lack, or to settle a genuine disagreement. NEVER WebFetch ardupilot.org — read the LOCAL wiki instead (don't load the open-source project's servers).

SOURCES (read in this order with Read/Bash):
1. Our current data: /Users/fred/fcpicker/data/boards/${c.base}.json  (this is what we're verifying).
2. hwdef ground truth + comments: ${hwdefDir}/README.md and hwdef.dat (and hwdef.inc if present). The README usually has the board's real name, pinout, mounting-hole info. IMPORTANT: hwdef driver names are chip *families*, not exact parts — "IMU Invensense SPI:mpu6000" may physically be an ICM20689; "BARO BMP388" may be a BMP390; "MCU STM32H743xx" may be an H753. SPIDEV aliases (e.g. "mpu6000") are legacy bus labels. Resolve the REAL chip from the README text / CS-pin name / wiki / manufacturer — do not trust the alias.
3. LOCAL ArduPilot wiki: derive the stem from our docs_url (e.g. .../common-holybro-kakutef7aio.html -> stem "common-holybro-kakutef7aio") and read /Users/fred/ardupilot_wiki/common/source/docs/<stem>.rst ; if it's a platform page or not found, grep -ril "<board name>" /Users/fred/ardupilot_wiki/*/source/docs/ to locate it. Confirm the page describes THIS exact board (not a different mini/pro/wing/v2 variant). If our docs_url is for the wrong variant, set correct_wiki_stem.
4. Manufacturer website (WebSearch then WebFetch) — ONLY to fill missing physical specs (dimensions, weight, mounting, BEC) or resolve a conflict.

HARVEST into the schema (null/empty when genuinely unknown — do NOT invent):
- identity: manufacturer, marketing_name, family
- chips (REAL parts): mcu_part, imu_models[], baro_models[], compass_models[], osd_chip, blackbox_flash, has_sdcard
- physical: length_mm, width_mm, height_mm, weight_g, mounting_pattern_mm (hole spacing e.g. "30.5x30.5"), mounting_hole_dia_mm (M3=3, M2=2)
- power: voltage_cells (e.g. "2-6S"), voltage_min_v, voltage_max_v, bec_outputs[]
- io/features: uart_count, can_count, notable_connectors[], has_baro, has_osd, wireless, pinout_notes (short)

CROSS-CORRELATE the key fields (mcu, imu, baro, dimensions, weight, uart_count, voltage) across hwdef/readme/wiki/manufacturer into field_checks[] with an agree verdict each, and list concrete discrepancies[] naming which source is wrong (e.g. "wiki lists ICM20689 but current hardware ships ICM42688"). Record sources_used[] (file paths and any URLs) and a confidence.

If WebSearch/WebFetch are not loaded and you need them, load with ToolSearch "select:WebSearch,WebFetch". Return ONLY the structured object.`
}

const results = await parallel(clusters.map(c => () =>
  agent(buildPrompt(c), { label: `verify:${c.base}`, phase: 'Verify', schema: SCHEMA, model: 'sonnet' })
    .then(r => r ? { ...r, base: r.base || c.base, cluster_slugs: c.slugs } : null)
))

return results.filter(Boolean)
