use chrono::{Datelike, TimeZone, Timelike, Utc};
use serde_json::Value;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Cadence {
    Off,
    Hourly,
    Every6Hours,
    Daily,
    Weekly,
    Every2Weeks,
    Monthly,
}
impl Cadence {
    pub(crate) fn parse(v: &str) -> Result<Self, String> {
        Ok(match v {
            "off" => Self::Off,
            "hourly" => Self::Hourly,
            "every6hours" => Self::Every6Hours,
            "daily" => Self::Daily,
            "weekly" => Self::Weekly,
            "every2weeks" => Self::Every2Weeks,
            "monthly" => Self::Monthly,
            _ => return Err("record-invalid-source-refresh".into()),
        })
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Hourly => "hourly",
            Self::Every6Hours => "every6hours",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Every2Weeks => "every2weeks",
            Self::Monthly => "monthly",
        }
    }
    pub(crate) fn next(self, last: i64) -> Result<Option<i64>, String> {
        if self == Self::Off {
            return Ok(None);
        }
        if last == 0 {
            return Ok(Some(0));
        }
        let next = if self == Self::Monthly {
            let time = Utc
                .timestamp_millis_opt(last)
                .single()
                .ok_or("guide-clock-unavailable")?;
            let (year, month) = if time.month() == 12 {
                (
                    time.year()
                        .checked_add(1)
                        .ok_or("guide-clock-unavailable")?,
                    1,
                )
            } else {
                (time.year(), time.month() + 1)
            };
            let mut day = time.day();
            let target = loop {
                if let Some(v) = Utc
                    .with_ymd_and_hms(year, month, day, time.hour(), time.minute(), time.second())
                    .single()
                {
                    break v;
                }
                if day == 1 {
                    return Err("guide-clock-unavailable".into());
                }
                day -= 1;
            };
            target
                .timestamp_millis()
                .checked_add(i64::from(time.timestamp_subsec_millis()))
                .ok_or("guide-clock-unavailable")?
        } else {
            let duration = match self {
                Self::Hourly => 3_600_000,
                Self::Every6Hours => 21_600_000,
                Self::Daily => 86_400_000,
                Self::Weekly => 604_800_000,
                Self::Every2Weeks => 1_209_600_000,
                _ => unreachable!(),
            };
            last.checked_add(duration)
                .ok_or("guide-clock-unavailable")?
        };
        if next > 253_402_351_200_000 {
            return Err("guide-clock-unavailable".into());
        }
        Ok(Some(next))
    }
}
pub(crate) fn from_preferences(p: &Value) -> Result<Cadence, String> {
    if p.get("automaticSourceRefresh")
        .is_some_and(|v| v.as_bool().is_none())
    {
        return Err("record-invalid-source-refresh".into());
    }
    match p.get("sourceRefreshCadence") {
        Some(v) => Cadence::parse(v.as_str().ok_or("record-invalid-source-refresh")?),
        None => Ok(
            if p.get("automaticSourceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                Cadence::Daily
            } else {
                Cadence::Off
            },
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_explicit_and_unknown_choice() {
        assert_eq!(
            from_preferences(&serde_json::json!({"automaticSourceRefresh":true})).unwrap(),
            Cadence::Daily
        );
        assert_eq!(
            from_preferences(
                &serde_json::json!({"automaticSourceRefresh":true,"sourceRefreshCadence":"off"})
            )
            .unwrap(),
            Cadence::Off
        );
        assert!(from_preferences(&serde_json::json!({"sourceRefreshCadence":"yearly"})).is_err());
    }
    #[test]
    fn exact_fixed_intervals_and_off() {
        let seed = 1_791_700_000_123;
        for (v, d) in [
            (Cadence::Hourly, 3_600_000),
            (Cadence::Every6Hours, 21_600_000),
            (Cadence::Daily, 86_400_000),
            (Cadence::Weekly, 604_800_000),
            (Cadence::Every2Weeks, 1_209_600_000),
        ] {
            assert_eq!(v.next(seed).unwrap(), Some(seed + d));
            assert_eq!(v.next(0).unwrap(), Some(0));
        }
        assert_eq!(Cadence::Off.next(seed).unwrap(), None);
    }
    #[test]
    fn monthly_utc_day_clamp_preserves_time_and_does_not_stick_end_of_month() {
        for (year, day) in [(2023, 28), (2024, 29)] {
            let jan = Utc
                .with_ymd_and_hms(year, 1, 31, 23, 59, 58)
                .unwrap()
                .timestamp_millis()
                + 123;
            let feb = Cadence::Monthly.next(jan).unwrap().unwrap();
            let f = Utc.timestamp_millis_opt(feb).unwrap();
            assert_eq!(
                (f.month(), f.day(), f.hour(), f.timestamp_subsec_millis()),
                (2, day, 23, 123)
            );
            let march = Utc
                .timestamp_millis_opt(Cadence::Monthly.next(feb).unwrap().unwrap())
                .unwrap();
            assert_eq!((march.month(), march.day()), (3, day));
        }
        let dec = Utc
            .with_ymd_and_hms(2025, 12, 31, 0, 0, 0)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            Utc.timestamp_millis_opt(Cadence::Monthly.next(dec).unwrap().unwrap())
                .unwrap()
                .year(),
            2026
        );
    }
}
