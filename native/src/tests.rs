use super::*;
#[test]
fn chesscom_month_streams_games_without_full_month() {
    let wire=br#"{"games":[{"pgn":"1. e4 *","time_class":"rapid"},{"pgn":"1. d4 *","time_class":"blitz"}],"other":true}"#;
    let mut out = Vec::new();
    let mut count = 0;
    stream_month(&wire[..], &mut out, &mut count, 0).unwrap();
    assert_eq!(count, 2);
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("1. d4 *"));
    assert!(text.contains("[TimeClass \"rapid\"]"));
}

#[test]
fn minimum_moves_is_strict_half_move_boundary() {
    let a = Args::try_parse_from(["rf", "--min-moves", "2"]).unwrap();
    let mut reader = Reader::new(&b"1. e4 e5 2. Nf3 Nc6 *"[..]);
    let mut visitor = PgnVisitor { max: 8 };
    let mut g = reader.read_game(&mut visitor).unwrap().unwrap().unwrap();
    assert!(!accepts(&g, &a));
    g.plies = 5;
    assert!(accepts(&g, &a));
    g.headers.insert("Variant".into(), "Atomic".into());
    assert!(!accepts(&g, &a));
}

#[test]
fn bounded_remote_archive_option() {
    assert!(Args::try_parse_from(["rf", "--max-games", "2"]).is_ok());
}

fn eval(cp: i64, best: &str) -> Evaluation {
    Evaluation {
        source: "stockfish".into(),
        score_cp: Some(cp),
        mate: None,
        best_move: Some(best.into()),
        depth: 6,
    }
}
#[test]
fn strict_twenty_five_cp_and_child_opposite_score() {
    assert!(!mistake(&eval(30, "e2e4"), &eval(-5, "e7e5"), "d2d4"));
    assert!(mistake(&eval(30, "e2e4"), &eval(-4, "e7e5"), "d2d4"));
    assert!(!mistake(&eval(30, "e2e4"), &eval(200, "e7e5"), "e2e4"));
}
#[test]
fn fen_key_ignores_only_counters() {
    assert_eq!(
        key("8/8/8/8/8/8/K6k/8 w - - 0 1"),
        key("8/8/8/8/8/8/K6k/8 w - - 99 55")
    );
    assert_ne!(
        key("8/8/8/8/8/8/K6k/8 w - - 0 1"),
        key("8/8/8/8/8/8/K6k/8 b - - 0 1")
    );
}
#[test]
fn legal_mainline_parser_and_invalid_move() {
    let mut v = PgnVisitor { max: 2 };
    let mut r = Reader::new(&b"1. e4 (1. d4 d5) e5 2. Nf3 Nc6 *"[..]);
    let g = r.read_game(&mut v).unwrap().unwrap().unwrap();
    assert_eq!(g.moves, vec!["e2e4", "e7e5"]);
    assert_eq!(g.plies, 4);
    let mut r = Reader::new(&b"1. e5 *"[..]);
    assert!(r.read_game(&mut v).unwrap().unwrap().is_err());
}
#[test]
fn time_controls_include_increment() {
    assert_eq!(time_class("180+0"), "blitz");
    assert_eq!(time_class("180+10"), "rapid");
    assert_eq!(time_class("60+0"), "bullet");
    assert_eq!(time_class("-"), "correspondence");
    let a = Args::try_parse_from(["rf", "--time-controls", "rapid"]).unwrap();
    let mut r = Reader::new(&b"[TimeControl \"3600+0\"]\n[TimeClass \"rapid\"]\n\n1. e4 *"[..]);
    let g = r
        .read_game(&mut PgnVisitor { max: 8 })
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(accepts(&g, &a));
}
#[test]
fn lichess_stream_to_disk() {
    let dir = std::env::temp_dir().join(format!("rf-stream-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("archive.pgn");
    let wire = b"{\"pgn\":\"[Event \\\"one\\\"]\\n\\n1. e4 *\"}\n\n{\"pgn\":\"1. d4 *\"}\n";
    let n = stream_lichess(BufReader::new(&wire[..]), &path).unwrap();
    assert_eq!(n, 2);
    assert!(fs::read_to_string(path).unwrap().contains("1. d4 *"));
}
#[test]
fn interrupted_stream_keeps_usable_games() {
    let dir = std::env::temp_dir().join(format!("rf-partial-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("archive.pgn");
    assert!(stream_lichess(
        BufReader::new(&b"{\"pgn\":\"1. e4 *\"}\nBROKEN\n"[..]),
        &path
    )
    .is_err());
    assert!(fs::read_to_string(path).unwrap().contains("1. e4 *"));
}
