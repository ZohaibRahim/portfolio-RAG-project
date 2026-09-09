# Python Security Log Analyzer

Parses a log file and classifies repeated failure patterns by source IP
using a two-tier severity model: **WARNING** and **CONFIRMED**, rather
than a single pass/fail threshold.

## Why two tiers, not one

A single threshold forces a bad trade-off. Set it low and a normal
mistyped password gets flagged as suspicious. Set it high and you're
slower to catch a real brute-force attempt in progress. This script
flags a lower repeat count as a **WARNING** (worth watching) and
escalates to **CONFIRMED** at a higher repeat count (high-confidence
pattern) — the same graduated-severity approach used in production
SIEM and alerting tools, instead of a binary flag/no-flag cutoff.

The first version of this script used a single `--threshold` flag.
It was rebuilt with the two-tier model after reasoning through the
false-positive/false-negative trade-off of a single cutoff.

## Usage

```
python alert_summary.py sample.log
python alert_summary.py sample.log --warn-threshold 2 --confirm-threshold 4
```

## Files

- `alert_summary.py` — main script
- `sample.log` — sample log data for testing

## Example output

```
Total 'FAILED' entries: 7
Entries with no IP address: 2

Failures by source IP:
  192.168.1.45: 2  <-- WARNING, monitor
  10.0.0.88: 1
  203.0.113.7: 1
  198.51.100.22: 1

0 IP(s) CONFIRMED, 1 IP(s) at WARNING level.
```
