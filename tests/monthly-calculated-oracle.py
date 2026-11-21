"""Independent exact oracle; run with --check to verify the committed fixture.

Python Fraction and a separate half-away-from-zero renderer intentionally do
not import application arithmetic. Node tests consume the JSON, not Python.
"""
from fractions import Fraction as F
from pathlib import Path
import json
import sys

KEYS = ["budgetedSpecificYield", "actualSpecificYield", "specificYieldRatio",
        "budgetedPerformanceRatio", "actualPerformanceRatio", "performanceRatioRatio",
        "insolationRatio", "productionProjectionRatio", "productionExpectedRatio",
        "revenueRatio", "iapr", "iar"]


def packed(x):
    if x is None:
        return None
    return {"n": str(x.numerator), "d": str(x.denominator)}


def display(x, places, percent=False):
    if x is None:
        return "—"
    if percent:
        x *= 100
    scaled = abs(x) * 10**places
    integer, remainder = divmod(scaled.numerator, scaled.denominator)
    if remainder * 2 >= scaled.denominator:
        integer += 1
    digits = str(integer).zfill(places + 1)
    text = (digits[:-places] + "." + digits[-places:]) if places else digits
    return ("-" if x < 0 and integer else "") + text + ("%" if percent else "")


def case(name, modules, production, revenue, projected_insolation, on_peak, off_peak, actual_revenue, expected, actual_insolation, configuration=None, month="2026-01", unpaid_energy=None):
    capacity = sum((F(w) * F(q) / 1000 for w, q in modules), F(0))
    present = [F(x) for x in [on_peak, off_peak, unpaid_energy] if x is not None and x != ""]
    utility = sum(present, F(0)) if present else None
    def divide(n, d):
        return None if n is None or d is None or d == 0 else n / d
    p, r, h, e, a = map(F, [production, revenue, projected_insolation, expected, actual_insolation])
    budget_sy, actual_sy = p / capacity, divide(utility, capacity)
    budget_pr, actual_pr = budget_sy / h, divide(actual_sy, a)
    production_ratio, revenue_ratio, insolation_ratio = divide(utility, p), F(actual_revenue) / r, a / h
    values = [budget_sy, actual_sy, divide(actual_sy, budget_sy), budget_pr, actual_pr, divide(actual_pr, budget_pr),
              insolation_ratio, production_ratio, divide(utility, e), revenue_ratio, divide(production_ratio, insolation_ratio), revenue_ratio / insolation_ratio]
    return {"name": name, "modules": modules, "capacity": packed(capacity), "month": month,
            "projection": {"month": month, "operationalDays": 31, "days": 31, "production": packed(p), "revenue": packed(r), "insolation": packed(h)},
            "configuration": configuration,
            "utility": {"onPeak": on_peak, "offPeak": off_peak, "unpaidEnergy": unpaid_energy, "revenue": actual_revenue, "energyUsed": "0", "invoiceCost": "-0.0001"},
            "expected": packed(e), "insolation": packed(a),
            "values": dict(zip(KEYS, map(packed, values))),
            "formatted": dict(zip(KEYS, [display(v, 2 if i < 2 else 0, i >= 2) for i, v in enumerate(values)]))}


cases = [case("ordinary", [["400", 300]], "12000", "1000", "150", "8000", "4000", "1200", "10000", "125"),
         case("partial-telemetry", [["400", 300]], "12000", "1000", "150", "8000", "4000", "1200", "10000", "1"),
         case("above-100-and-signed-revenue", [["500", 200]], "50", "1", "0.5", "100", None, "-2.125", "25", "1"),
         case("zero-numerators", [["1000", 1]], "1", "1", "1", "0", None, "0", "1", "1")]
for actual in ["0.994999999999999999", "0.995", "0.005", "0.004999999999999999"]:
    cases.append(case("rounding-" + actual, [["1e3", 1]], "1", "1", "1", actual, None, "-" + actual, "1", "1"))
config = {"operationsStart": "2024-03-16", "degradation": "0.123456789012345678", "irradianceChannelId": None,
          "baselines": {str(i): {"production": "3100.123456789012345", "revenue": "310.1234567890123456", "insolation": "31.12345678901234567"} for i in range(1, 13)}}
for month, factor, insolation_factor in [("2024-03", F(16, 31), F(16, 31)),
                                         ("2026-03", (15 * (1 - F(config["degradation"]) / 100) + 16 * (1 - F(config["degradation"]) / 100)**2) / 31, F(1))]:
    base = config["baselines"]["3"]
    cases.append(case("prorated-and-degraded-" + month, [["450.123456789012345678", 1234], ["3.75e2", 321]],
                      F(base["production"]) * factor, F(base["revenue"]) * factor, F(base["insolation"]) * insolation_factor,
                      "123.1234567890123456", "0.000000000000000001", "-0.12345678901234567", "9101.75", "371.5", config, month))
combined_cases = []
# Every presence combination, including all blank and explicit zero, uses the
# same fixed controls. Their expected values come only from Python Fraction.
for mask in range(8):
    components = ["100.1234567890123456", "50.00000000000000001", "25.6250"]
    on, off, unpaid = [x if mask & (1 << i) else None for i, x in enumerate(components)]
    combined_cases.append(case(f"combined-presence-{mask}", [["400", 300]], "12000", "1000", "150",
                               on, off, "-12.3450", "10000", "125", unpaid_energy=unpaid))
combined_cases.append(case("combined-unpaid-zero", [["400", 300]], "12000", "1000", "150",
                           None, None, "-12.3450", "10000", "125", unpaid_energy="0.0000"))
for unpaid in ["0.334999999999999999", "0.335", "0.335000000000000001"]:
    combined_cases.append(case("combined-rounding-" + unpaid, [["1000", 1]], "1", "1", "1",
                               "0.33", "0.33", "-0.995", "1", "1", unpaid_energy=unpaid))
for name, unpaid in [("combined-http-before", "12.6250"), ("combined-http-after", "23.125000000000001")]:
    combined_cases.append(case(name, [["400", 300]], "12000", "1000", "150",
                               "8000.0000", "4000.000000000000000", "1200.000000000000000", "10000", "1", unpaid_energy=unpaid))
for original in cases[-2:]:
    base = config["baselines"]["3"]
    # Reuse the independently computed projection, never production JS.
    unpack = lambda value: F(int(value["n"]), int(value["d"]))
    p, r, h = [unpack(original["projection"][k]) for k in ["production", "revenue", "insolation"]]
    combined_cases.append(case("combined-" + original["name"], original["modules"], p, r, h,
                               original["utility"]["onPeak"], original["utility"]["offPeak"], original["utility"]["revenue"],
                               "9101.75", "371.5", config, original["month"], unpaid_energy="17.99999999999999999"))
path = Path(__file__).with_suffix(".json")
text = json.dumps({"oracle": "Python fractions.Fraction; exact formula and independent display rounding", "keys": KEYS, "cases": cases, "combinedCases": combined_cases}, indent=2) + "\n"
if "--check" in sys.argv:
    assert path.read_text() == text, "Independent oracle fixture differs"
    print(f"Verified {len(cases)} original + {len(combined_cases)} combined cases × {len(KEYS)} exact values and display strings")
else:
    path.write_text(text)
    print(f"Wrote {path}")
