# Hybrid Zone Thermostat

A Home Assistant integration for houses with more than one way to heat or
cool a room: a boiler and radiators, split ACs, electric heaters. You set one
target temperature per room. It heats or cools as needed, with no heat/cool
mode to pick, using the cheapest unit that can keep up, and it says why it's
doing what it's doing.

**Status: early development.** Not ready to run a house yet.

## Install

Through HACS: add `https://github.com/ipeterov/hybrid-zone-thermostat` as a
custom repository of type Integration, then install Hybrid Zone Thermostat
and restart Home Assistant.

By hand: download `hybrid_zone_thermostat.zip` from the latest
[release](https://github.com/ipeterov/hybrid-zone-thermostat/releases),
unzip it into `config/custom_components/hybrid_zone_thermostat/`, and
restart.

Then add the integration under Settings › Devices & services. A Climate
zones page appears in the sidebar; everything is set up there.

## Development

See [CLAUDE.md](CLAUDE.md) for how the code is laid out. In short:

```bash
uv sync --dev && npm ci
uv run dev check        # ruff, mypy, Biome, tsc
uv run dev test         # Python tests
uv run dev test-browser # browser tests of the panel and card
uv run dev ha           # Home Assistant in Docker with this mounted
```

Licensed under MIT.
