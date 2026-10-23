//! Read-only provenance for the legacy Internet Archive item-year column.
//!
//! The persisted value has no retained source-field authority. It cannot prove
//! original release, upload, episode, or edition dates. Keep that uncertainty
//! explicit without changing the catalogue, filters, or stable media identity.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DateAssessment {
    version: u32,
    provider_listed_year: Option<i64>,
    original_release_year: Option<i64>,
    status: Status,
    provenance: &'static str,
    field: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    UnverifiedItemDate,
    Unknown,
}

/// Only the existing bounded column may supply the listed year. Private fields
/// make contradictory v1 assessments impossible for native output callers.
pub(crate) fn from_legacy_year(year: Option<i64>) -> Result<DateAssessment, String> {
    if year.is_some_and(|value| !(1888..=2100).contains(&value)) {
        return Err("archive-date-assessment-invalid".into());
    }
    Ok(DateAssessment {
        version: 1,
        provider_listed_year: year,
        original_release_year: None,
        status: if year.is_some() {
            Status::UnverifiedItemDate
        } else {
            Status::Unknown
        },
        provenance: "legacy-item-year",
        field: "unknown",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_date_assessment_serializes_exact_contract_at_both_year_bounds() {
        for year in [1888, 2020, 2100] {
            let wire = serde_json::to_value(from_legacy_year(Some(year)).unwrap()).unwrap();
            assert_eq!(
                wire,
                serde_json::json!({"version":1,"providerListedYear":year,
                "originalReleaseYear":null,"status":"unverified-item-date",
                "provenance":"legacy-item-year","field":"unknown"})
            );
        }
    }

    #[test]
    fn archive_date_assessment_unknown_stays_null_with_explicit_unknown_status() {
        assert_eq!(
            serde_json::to_value(from_legacy_year(None).unwrap()).unwrap(),
            serde_json::json!({"version":1,"providerListedYear":null,
                "originalReleaseYear":null,"status":"unknown",
                "provenance":"legacy-item-year","field":"unknown"})
        );
    }

    #[test]
    fn archive_date_assessment_refuses_unrepresentable_legacy_years() {
        for year in [i64::MIN, 0, 1887, 2101, i64::MAX] {
            assert_eq!(
                from_legacy_year(Some(year)).unwrap_err(),
                "archive-date-assessment-invalid"
            );
        }
    }
}
