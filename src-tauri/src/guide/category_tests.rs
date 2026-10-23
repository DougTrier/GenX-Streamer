use crate::guide::{category::*, parser::*};
use std::sync::atomic::AtomicBool;
fn xml(categories: &str) -> String {
    format!("<tv><channel id='c'><display-name>Test</display-name></channel><programme channel='c' start='20261011000000 +0000' stop='20261011010000 +0000'><title>Midnight story</title>{categories}</programme></tv>")
}
#[test]
fn actual_xml_entities_language_and_unknown_are_preserved() {
    let feed=parse_guide(xml("<category lang='en'>Action &amp; Adventure</category><category lang='fr'>Mystère</category>").as_bytes()).unwrap();
    let c = &feed.programs[0].categories;
    assert_eq!(c.len(), 2);
    assert_eq!(c[0].text, "Action & Adventure");
    assert_eq!(c[1].language.as_deref(), Some("fr"));
    assert!(parse_guide(xml("").as_bytes()).unwrap().programs[0]
        .categories
        .is_empty());
}
#[test]
fn raw_count_and_aggregate_overflow_refuse_whole_parse() {
    assert!(parse_guide(xml(&"<category>Action</category>".repeat(32)).as_bytes()).is_ok());
    assert!(parse_guide(xml(&"<category>Action</category>".repeat(33)).as_bytes()).is_err());
    assert!(
        parse_guide(xml(&format!("<category>{}</category>", "a".repeat(513))).as_bytes()).is_err()
    );
    let block = format!("<category>{}</category>", "a".repeat(512));
    assert!(parse_guide(xml(&block.repeat(8)).as_bytes()).is_ok());
    assert!(parse_guide(xml(&(block.repeat(8) + "<category>x</category>")).as_bytes()).is_err());
    assert!(
        parse_guide(xml("<category lang='bad language'>Action</category>").as_bytes()).is_err()
    );
}
#[test]
fn normalized_duplicates_keep_first_display_but_semantic_keys_are_equal() {
    let a = canonicalize(vec![
        GuideCategory {
            text: "Ａｃｔｉｏｎ".into(),
            language: Some("EN".into()),
        },
        GuideCategory {
            text: "action".into(),
            language: Some("en".into()),
        },
    ])
    .unwrap();
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].text, "Ａｃｔｉｏｎ");
    let b = canonicalize(vec![GuideCategory {
        text: "Action".into(),
        language: Some("en".into()),
    }])
    .unwrap();
    assert_eq!(semantic_key(&a).unwrap(), semantic_key(&b).unwrap());
    assert_ne!(
        semantic_key(&a).unwrap(),
        semantic_key(&[GuideCategory {
            text: "Drama".into(),
            language: Some("en".into())
        }])
        .unwrap()
    );
}
#[test]
fn cancellation_and_nested_markup_do_not_admit_partial_category() {
    let flag = AtomicBool::new(true);
    assert!(parse_guide_cancelable(xml("<category>Drama</category>").as_bytes(), &flag).is_err());
    assert!(parse_guide(xml("<category><b>Drama</b></category>").as_bytes()).is_err());
    assert!(parse_guide(xml("<category>&external;</category>").as_bytes()).is_err());
}

#[test]
fn legacy_program_json_without_categories_remains_compatible() {
    let program: GuideProgram = serde_json::from_str(
        r#"{"channel_id":"c","start_ms":1,"stop_ms":2,"title":"Legacy","description":null}"#,
    )
    .unwrap();
    assert!(program.categories.is_empty());
    assert_eq!(
        search_text(&program.title, None, &program.categories),
        "legacy"
    );
}

#[test]
fn reviewed_aliases_require_exact_declared_category_and_do_not_infer_genres() {
    for (tag, word) in [
        ("Animation", "cartoons"),
        ("Cartoons", "animation"),
        ("Kids", "children"),
        ("Children's", "kids"),
    ] {
        let c = vec![GuideCategory {
            text: tag.into(),
            language: None,
        }];
        assert!(search_text("Unrelated", None, &c).contains(word));
    }
    let c = vec![GuideCategory {
        text: "Movies".into(),
        language: None,
    }];
    let text = search_text("Unrelated", None, &c);
    assert!(!text.contains("drama") && !text.contains("action") && !text.contains("mystery"));
    assert_eq!(
        semantic_key(&[
            GuideCategory {
                text: "Ａｃｔｉｏｎ".into(),
                language: None
            },
            GuideCategory {
                text: "Science Fiction".into(),
                language: Some("EN".into())
            }
        ])
        .unwrap(),
        r#"[["action",null],["science fiction","en"]]"#
    );
}
