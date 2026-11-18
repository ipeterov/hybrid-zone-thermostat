# Room climate controller: build or adopt? (research, 2026-11-18)

Goal per room: one target temperature, automatic heat / dead band / cool (no user-picked mode),
staged devices (split AC/heat pump as an HA `climate` entity driven by setpoint offset from an external
room sensor; Zigbee TRVs with boiler demand aggregated across rooms; optional electric backup heater),
per-stage outdoor lockouts, all local in Home Assistant.

## Verdict

Nothing covers it. The missing core (zone state machine + staging + outdoor lockouts + boiler demand)
is exactly the part nobody has built. Writing our own integration is justified; keep the core small and
borrow proven pieces.

## Closest existing projects and what they lack

| Project | Has | Lacks |
|---|---|---|
| Multizone Thermostat v3 (alex-military, MIT, 23 stars, v6.x, single author, fast churn) | split setpoint injection (desired + split sensor - room sensor), boiler demand aggregator, sensor watchdog, window detection | auto heat/cool (global manual season switch), outdoor lockouts, electric backup; split runs on solar/boost policy |
| Dual Smart Thermostat (240 stars, v0.13.2) | heater/cooler can be `climate` entities, heat_cool (range), secondary heater on a timeout, opening detection | multiple TRVs, boiler aggregation, outdoor lockouts, setpoint offset; single-target auto unconfirmed |
| Better Thermostat (1.6k stars, 2.0.0) | multiple TRVs per room, external sensor + calibration, optional cooler with compressor guard | single target (uses min/max band), staging, backup heat |
| Climate Group Helper (140 stars) | mixed members, external sensor override, per-member offsets | staging, lockouts, boiler logic (it groups, doesn't control) |
| Versatile Thermostat | TPI, over_climate regulation, central boiler (count/power threshold + delay), presets, window, safety | one device type per thermostat, no auto changeover, no staging |
| SAT (263 stars) | OpenTherm boiler modulation, heating curve, PID; possible boiler backend later | heat only, no AC |
| Vesta (MIT, 12 stars) | boiler on any demand, window delay, stale-sensor fallback | cooling, offset, staging |
| ZEAL-Heat | multi-TRV scheduling | beta, restrictive licence, heat only |
| Smart Thermostat PID, Smart Climate Control, MXZ Coordinator, generic_thermostat, AHC blueprint, Schedy, Intelligent Heating Pilot | pieces (PID + outdoor gain, controller-chosen heat/cool for multi-splits) | the combination |

Commercial residential: ecobee is conceptually closest (auto heat/cool, compressor min outdoor temp,
aux heat max outdoor temp) but one ducted system and poor local access. tado / Nest / Netatmo / ViCare
are cloud. evohome (local via ramses_cc) is heating only. Daikin hybrid switches heat pump vs boiler
whole-house by COP or a price-derived bivalent temperature.

## Practices to copy (ASHRAE Guideline 36 + residential)

1. One user setpoint; derive heating and cooling setpoints with a dead band (ASHRAE 90.1 minimum is
   about 2.8 C; LBNL warns small dead bands cause heat/cool cycling). Zone state Heating / Deadband /
   Cooling, minimum hold time per state.
2. Separate heating and cooling PI loops (reset integrators on changeover); the controller chooses
   heat or cool, never the AC's own AUTO (MXZ Coordinator pattern).
3. Stage sources by cost (configurable order); escalate on how long the error persists, not just its
   size. Two outdoor lockouts with hysteresis per heat pump: compressor min outdoor temp and a higher
   aux-heat max outdoor temp. Optional price-based switchover.
4. Boiler demand: rooms send requests with an importance weight; fire on count or summed demand with a
   start delay (G36 requests + Trim & Respond, VT central boiler).
5. AC drive: setpoint = desired + (AC's own reading - room reading) (Multizone v3), clamped to the
   AC's range; fall back to the device sensor when the room sensor is stale.
6. Equipment protection: minimum on/off times for compressor and boiler, keep-alive resends.

## Sources

- ASHRAE G36 zone states: https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/g36_2018_h_galley_20200817.pdf
- G36 plant requests: https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/g36_2021_t_20240229.pdf
- LBNL setpoints/dead band: https://smartersmallbuildings.lbl.gov/sites/default/files/2024-10/Setpoints%20and%20Scheduling%20General.pdf
- Trane on G36: https://www.trane.com/content/dam/Trane/Commercial/global/learning-center/engineers-newsletters/ADM-APN078-EN.pdf
- Multizone Thermostat v3: https://github.com/alex-military/multizone-thermostat (split_climate.md, hybrid_energy.md, cooling_season.md)
- Dual Smart Thermostat: https://github.com/swingerman/ha-dual-smart-thermostat
- Better Thermostat: https://github.com/KartoffelToby/better_thermostat
- Climate Group Helper: https://github.com/bjrnptrsn/climate_group_helper
- Versatile Thermostat central boiler: https://raw.githubusercontent.com/jmcollin78/versatile_thermostat/main/documentation/en/feature-central-boiler.md
- SAT: https://github.com/Alexwijn/SAT
- Vesta: https://github.com/portbusy/ha-vesta
- ZEAL-Heat: https://github.com/Buster1959/ZEAL-Heat
- MXZ Coordinator: https://community.home-assistant.io/t/one-temperature-per-room-on-a-mitsubishi-mxz-multi-split-mxz-coordinator-hacs/1018382
- ecobee lockouts: https://www.bpa.gov/-/media/Aep/energy-efficiency/residential/residential-ptcs-essentials/ecobee-3-4-5.pdf
- Forum threads on two heat sources: https://community.home-assistant.io/t/controlling-multiple-heating-and-cooling-devices-in-a-single-room/472488
