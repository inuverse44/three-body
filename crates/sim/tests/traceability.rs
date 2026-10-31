//! テストの名前と計画書（docs/plan.md §6）の対応（issue #10）。
//! `fn vNN_…` のテストは、説明の最初の行が `V-NN` で始まり、計画書の V-NN の行の方法が Rust のテストであること。
//! 番号が計画書の別の Rust のテストの行と偶然合う取り違えは、この照合では見つけられない（内容は人が照らす）

const PLAN: &str = include_str!("../../../docs/plan.md");
const SOURCES: [(&str, &str); 3] = [
    ("verification.rs", include_str!("verification.rs")),
    ("presets.rs", include_str!("presets.rs")),
    ("recording.rs", include_str!("recording.rs")),
];
const TRAIL_TS: &str = include_str!("../../../src/lib/trail.ts");

/// 1 回に記録できる時刻の数は、計算部分（RECORD_CAPACITY）と Web ページ（src/lib/trail.ts の MAX_TIMES）で同じ
#[test]
fn record_capacity_matches_page() {
    let line = TRAIL_TS
        .lines()
        .find(|l| l.starts_with("export const MAX_TIMES = "))
        .expect("trail.ts に MAX_TIMES がある");
    let value: usize = line
        .trim_start_matches("export const MAX_TIMES = ")
        .trim_end_matches(';')
        .parse()
        .expect("MAX_TIMES は整数");
    assert_eq!(value, sim::integrators::RECORD_CAPACITY);
}

#[test]
fn v_test_names_match_plan_rows() {
    let mut wrong = Vec::new();
    let mut checked = 0;
    for (file, source) in SOURCES {
        let lines: Vec<&str> = source.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            let Some(rest) = line.strip_prefix("fn v") else {
                continue;
            };
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if digits.len() != 2 || !rest[2..].starts_with('_') {
                continue;
            }
            checked += 1;
            let id = format!("V-{digits}");
            let at = format!("{file}:{}", i + 1);
            // 説明の最初の行（#[test] と説明の行をさかのぼった、いちばん上の説明の行）
            let doc = lines[..i]
                .iter()
                .rev()
                .take_while(|l| l.starts_with("///") || l.starts_with("#["))
                .filter(|l| l.starts_with("///"))
                .last();
            if !doc.is_some_and(|d| d.starts_with(&format!("/// {id} "))) {
                wrong.push(format!("{at}：説明が {id} で始まらない"));
            }
            match PLAN.lines().find(|l| l.starts_with(&format!("| {id} |"))) {
                None => wrong.push(format!("{at}：計画書に {id} の行がない")),
                Some(row) => {
                    let method = row
                        .trim_end()
                        .trim_end_matches('|')
                        .rsplit('|')
                        .next()
                        .unwrap_or("");
                    if !method.contains("Rust") {
                        wrong.push(format!(
                            "{at}：計画書の {id} の方法が Rust のテストでない（{}）",
                            method.trim()
                        ));
                    }
                }
            }
        }
    }
    // 名前の読み取りが働いていること（2 つのファイルに vNN_ のテストは 20 以上ある）
    assert!(checked >= 20, "照合したテストが {checked} 件しかない");
    assert!(wrong.is_empty(), "{wrong:#?}");
}
