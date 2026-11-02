// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
//! The same declared location scope as channel browsing, shared by Guide reads.
use rusqlite::types::Value as SqlValue;
use serde_json::{Map, Value};

const INVALID: &str = "guide-invalid-geography";
pub(crate) fn validate(scope: &Map<String, Value>) -> Result<(), String> {
    let code = |value: &str| {
        !value.is_empty()
            && value.len() <= 32
            && value
                .bytes()
                .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit() || b"_-".contains(&v))
    };
    if let Some(countries) = scope.get("countries") {
        let values: Option<Vec<&str>> = countries
            .as_array()
            .and_then(|values| values.iter().map(Value::as_str).collect());
        if scope.len() != 1
            || !values.is_some_and(|values| {
                (2..=64).contains(&values.len())
                    && values.iter().all(|value| code(value))
                    && values
                        .iter()
                        .collect::<std::collections::HashSet<_>>()
                        .len()
                        == values.len()
            })
        {
            return Err(INVALID.into());
        }
    }
    if scope.iter().any(|(field, value)| {
        field != "countries"
            && (!["country", "region", "state"].contains(&field.as_str())
                || !(value.is_null() || value.as_str().is_some_and(code)))
    }) {
        return Err(INVALID.into());
    }
    Ok(())
}

/// A bound suffix for a trusted channel-table alias. No location value enters SQL.
pub(crate) fn clause(
    scope: &Map<String, Value>,
    alias: &str,
    first_parameter: usize,
) -> Result<(String, Vec<SqlValue>), String> {
    validate(scope)?;
    if first_parameter == 0
        || alias.is_empty()
        || !alias
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_')
    {
        return Err(INVALID.into());
    }
    let mut sql = String::new();
    let mut values = Vec::new();
    if let Some(countries) = scope.get("countries").and_then(Value::as_array) {
        let parameters = countries
            .iter()
            .enumerate()
            .map(|(index, value)| {
                values.push(value.as_str().unwrap().to_owned().into());
                format!("?{}", first_parameter + index)
            })
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" AND {alias}.country IN ({parameters})"));
    }
    for field in ["country", "region", "state"] {
        if let Some(value) = scope.get(field) {
            if value.is_null() {
                sql.push_str(&format!(" AND {alias}.{field} IS NULL"));
            } else {
                sql.push_str(&format!(
                    " AND {alias}.{field}=?{}",
                    first_parameter + values.len()
                ));
                values.push(value.as_str().unwrap().to_owned().into());
            }
        }
    }
    Ok((sql, values))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn binds_country_region_state_and_preserves_unknown() {
        let geo = json!({"country":"US","region":"NA","state":null});
        let (sql, values) = clause(geo.as_object().unwrap(), "c", 6).unwrap();
        assert_eq!(sql, " AND c.country=?6 AND c.region=?7 AND c.state IS NULL");
        assert_eq!(
            values,
            vec![SqlValue::Text("US".into()), SqlValue::Text("NA".into())]
        );
        assert_eq!(
            clause(&Map::new(), "c", 1).unwrap(),
            (String::new(), vec![])
        );
    }
    #[test]
    fn countries_are_one_bounded_union_and_invalid_scopes_are_refused() {
        let geo = json!({"countries":["US","CA"]});
        let (sql, values) = clause(geo.as_object().unwrap(), "c", 8).unwrap();
        assert_eq!(sql, " AND c.country IN (?8,?9)");
        assert_eq!(values.len(), 2);
        for geo in [
            json!({"countries":["US","US"]}),
            json!({"countries":["US"]}),
            json!({"countries":["US","CA"],"state":"US-IL"}),
            json!({"unknown":"US"}),
            json!({"country":"US' OR 1=1"}),
            json!({"region":12}),
        ] {
            assert!(validate(geo.as_object().unwrap()).is_err());
        }
    }
}
