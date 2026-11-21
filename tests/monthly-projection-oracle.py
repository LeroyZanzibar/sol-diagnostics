"""Independent day-by-day Fraction oracle, synthetic cases from stdin."""
import calendar
import datetime as dt
from fractions import Fraction
import json
import sys

cases = json.load(sys.stdin)
checked = 0
for case in cases:
    config, rows = case['configuration'], case['rows']
    start = dt.date.fromisoformat(config['operationsStart'])
    factor = 1 - Fraction(config['degradation']) / 100
    for row in rows:
        year, month = map(int, row['month'].split('-'))
        count = calendar.monthrange(year, month)[1]
        production_weight = Fraction(0)
        operating_days = 0
        for day in range(1, count + 1):
            date = dt.date(year, month, day)
            if date < start:
                continue
            operating_days += 1
            completed = 0
            for anniversary_year in range(start.year + 1, year + 1):
                anniversary = dt.date(anniversary_year, start.month, min(start.day, calendar.monthrange(anniversary_year, start.month)[1]))
                if anniversary <= date:
                    completed += 1
            production_weight += factor ** completed
        assert operating_days == row['operationalDays']
        for field in ('production', 'revenue', 'insolation'):
            baseline = config['baselines'][str(month)][field]
            actual = row[field]
            if baseline is None:
                assert actual is None
                continue
            weight = Fraction(operating_days) if field == 'insolation' else production_weight
            expected = Fraction(baseline) * weight / count
            assert expected == Fraction(int(actual['n']), int(actual['d'])), (config['operationsStart'], row['month'], field)
        checked += 1
print(json.dumps({'passed': True, 'cases': len(cases), 'months': checked, 'arithmetic': 'independent Python Fraction day-by-day, exact equality'}))
