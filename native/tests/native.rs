use std::{fs, process::Command};
#[test]
fn refuses_to_overwrite_input_pgn() {
    let dir = std::env::temp_dir().join(format!("rf-input-protect-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let input = dir.join("same.pgn");
    fs::write(&input, "1. e4 *").unwrap();
    let engine = format!(
        "{}/vendor/stockfish/usr/games/stockfish",
        env!("CARGO_MANIFEST_DIR")
    );
    let s = Command::new(env!("CARGO_BIN_EXE_repertoire-forge"))
        .args([
            "--input",
            input.to_str().unwrap(),
            "--output",
            dir.join("same").to_str().unwrap(),
            "--stockfish",
            &engine,
            "--depth",
            "4",
        ])
        .status()
        .unwrap();
    assert!(!s.success());
    assert_eq!(fs::read_to_string(input).unwrap(), "1. e4 *");
}

#[test]
fn legal_pgn_filters_export_web_backup() {
    let bin = env!("CARGO_BIN_EXE_repertoire-forge");
    let dir = std::env::temp_dir().join(format!("rf-native-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let input = dir.join("games.pgn");
    let out = dir.join("result");
    fs::write(&input,"[Event \"Fool\"]\n[White \"Tester\"]\n[Black \"Other\"]\n[TimeControl \"600+0\"]\n[Result \"0-1\"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n\n[Event \"short\"]\n[TimeControl \"60+0\"]\n\n1. e4 *\n").unwrap();
    let engine = std::env::var("STOCKFISH").unwrap_or_else(|_| {
        format!(
            "{}/vendor/stockfish/usr/games/stockfish",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let status = Command::new(bin)
        .args([
            "--input",
            input.to_str().unwrap(),
            "--min-moves",
            "1",
            "--time-controls",
            "rapid",
            "--depth",
            "6",
            "--max-ply",
            "8",
            "--stockfish",
            &engine,
            "--output",
            out.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let v: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(out.with_extension("json")).unwrap()).unwrap();
    assert_eq!(v["format"], "repertoire-forge");
    assert_eq!(v["version"], 1);
    assert_eq!(v["graph"]["games"], 1);
    assert!(v["graph"]["lines"][0]["mistakePly"].is_number());
    assert!(v["cards"].as_array().unwrap().len() > 0);
    assert_eq!(v["settings"]["mistakeCp"], 25);
    assert!(fs::read_to_string(out.with_extension("pgn"))
        .unwrap()
        .contains("[Result \"*\"]"));
}
