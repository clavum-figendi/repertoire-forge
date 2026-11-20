use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use pgn_reader::{RawTag, Reader, SanPlus, Skip, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shakmaty::{
    fen::Fen, san::SanPlus as LegalSan, uci::UciMove, CastlingMode, Chess, EnPassantMode, Position,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    ops::ControlFlow,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Native legal PGN → Stockfish backsolve → Repertoire Forge web backup"
)]
struct Args {
    #[arg(long)]
    input: Option<PathBuf>,
    #[arg(long,default_value="lichess",value_parser=["lichess","chesscom","chess.com"])]
    platform: String,
    #[arg(long, default_value = "")]
    username: String,
    /// Strict minimum: accept only games with plies > 2*N, matching the web archive filters.
    #[arg(long, default_value_t = 0)]
    min_moves: usize,
    /// Optional cap on fetched/scanned games (0 = unlimited). Filters still apply afterward.
    #[arg(long, default_value_t = 0)]
    max_games: usize,
    /// Comma-separated classes (bullet,blitz,rapid,classical,correspondence) or exact PGN controls (600+0).
    #[arg(long, default_value = "")]
    time_controls: String,
    #[arg(long,default_value_t=14,value_parser=clap::value_parser!(u32).range(4..=20))]
    depth: u32,
    #[arg(long,default_value_t=40,value_parser=clap::value_parser!(u32).range(2..=160))]
    max_ply: u32,
    #[arg(long, default_value = "stockfish")]
    stockfish: PathBuf,
    /// Output prefix: writes PREFIX.json, PREFIX.pgn, PREFIX.cache.ndjson.
    #[arg(long, default_value = "repertoire")]
    output: PathBuf,
}
fn key(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}
fn fen(p: &Chess) -> String {
    Fen::from_position(p, EnPassantMode::Legal).to_string()
}
fn board(s: &str) -> Result<Chess> {
    Ok(s.parse::<Fen>()?.into_position(CastlingMode::Standard)?)
}
fn play(p: &mut Chess, s: &str) -> Result<String> {
    let m = s.parse::<UciMove>()?.to_move(p)?;
    let san = LegalSan::from_move(p.clone(), m).to_string();
    p.play_unchecked(m);
    Ok(san)
}
#[derive(Clone, Debug)]
struct Game {
    headers: HashMap<String, String>,
    start: Chess,
    pos: Chess,
    moves: Vec<String>,
    plies: usize,
}
struct PgnVisitor {
    max: usize,
}
impl Visitor for PgnVisitor {
    type Tags = HashMap<String, String>;
    type Movetext = Game;
    type Output = Result<Game>;
    fn begin_tags(&mut self) -> ControlFlow<Self::Output, Self::Tags> {
        ControlFlow::Continue(HashMap::new())
    }
    fn tag(&mut self, t: &mut Self::Tags, n: &[u8], v: RawTag<'_>) -> ControlFlow<Self::Output> {
        t.insert(
            String::from_utf8_lossy(n).into_owned(),
            v.decode_utf8_lossy().into_owned(),
        );
        ControlFlow::Continue(())
    }
    fn begin_movetext(&mut self, t: Self::Tags) -> ControlFlow<Self::Output, Game> {
        let p = match t.get("FEN") {
            Some(s) => match board(s) {
                Ok(p) => p,
                Err(e) => return ControlFlow::Break(Err(e)),
            },
            None => Chess::default(),
        };
        ControlFlow::Continue(Game {
            headers: t,
            start: p.clone(),
            pos: p,
            moves: vec![],
            plies: 0,
        })
    }
    fn begin_variation(&mut self, _: &mut Game) -> ControlFlow<Self::Output, Skip> {
        ControlFlow::Continue(Skip(true))
    }
    fn san(&mut self, g: &mut Game, s: SanPlus) -> ControlFlow<Self::Output> {
        match s.san.to_move(&g.pos) {
            Ok(m) => {
                if g.moves.len() < self.max {
                    g.moves
                        .push(UciMove::from_move(m, CastlingMode::Standard).to_string())
                }
                g.pos.play_unchecked(m);
                g.plies += 1;
                ControlFlow::Continue(())
            }
            Err(e) => ControlFlow::Break(Err(anyhow!("Illegal PGN move {s}: {e}"))),
        }
    }
    fn end_game(&mut self, g: Game) -> Result<Game> {
        Ok(g)
    }
}
fn time_class(tc: &str) -> &str {
    if tc == "-" {
        return "correspondence";
    }
    let part = tc.rsplit(':').next().unwrap_or(tc);
    let mut n = part.split('+');
    let b = n.next().unwrap_or("").parse::<u64>();
    let inc = n.next().unwrap_or("0").parse::<u64>();
    match (b, inc) {
        (Ok(b), Ok(i)) => match b.saturating_add(i.saturating_mul(40)) {
            0..=179 => "bullet",
            180..=479 => "blitz",
            480..=1499 => "rapid",
            _ => "classical",
        },
        _ => "unknown",
    }
}
fn accepts(g: &Game, a: &Args) -> bool {
    if g.headers
        .get("Variant")
        .map(|v| !v.eq_ignore_ascii_case("standard"))
        .unwrap_or(false)
    {
        return false;
    }
    if g.plies <= a.min_moves.saturating_mul(2) {
        return false;
    }
    if a.time_controls.is_empty() {
        return true;
    }
    let tc = g
        .headers
        .get("TimeControl")
        .map(String::as_str)
        .unwrap_or("");
    let class = g
        .headers
        .get("TimeClass")
        .map(String::as_str)
        .unwrap_or_else(|| time_class(tc));
    let class = if class == "daily" {
        "correspondence"
    } else {
        class
    };
    a.time_controls
        .split(',')
        .any(|x| x.trim() == tc || x.trim() == class)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Evaluation {
    source: String,
    score_cp: Option<i64>,
    mate: Option<i64>,
    best_move: Option<String>,
    depth: u32,
}
impl Evaluation {
    fn score(&self) -> i64 {
        match self.mate {
            Some(0) => -1_000_000_000,
            Some(m) => m.signum() * (1_000_000_000 - m.abs().min(10000) * 1000),
            None => self.score_cp.unwrap_or(0),
        }
    }
}
fn mistake(parent: &Evaluation, child: &Evaluation, uci: &str) -> bool {
    parent.best_move.as_deref() != Some(uci) && parent.score() + child.score() > 25
}
struct Engine {
    child: Child,
    input: ChildStdin,
    lines: Receiver<String>,
    identity: String,
}
impl Engine {
    fn start(path: &Path) -> Result<Self> {
        let mut c = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .with_context(|| format!("Cannot launch Stockfish: {}", path.display()))?;
        let input = c.stdin.take().unwrap();
        let out = c.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for s in BufReader::new(out).lines() {
                match s {
                    Ok(s) => {
                        if tx.send(s).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let mut e = Self {
            child: c,
            input,
            lines: rx,
            identity: String::new(),
        };
        e.send("uci")?;
        loop {
            let s = e.line()?;
            if let Some(id) = s.strip_prefix("id name ") {
                e.identity = id.into()
            }
            if s == "uciok" {
                break;
            }
        }
        if !e.identity.to_lowercase().contains("stockfish") {
            bail!("UCI engine does not identify itself as Stockfish")
        }
        e.send("setoption name Threads value 1")?;
        e.send("setoption name Hash value 32")?;
        e.send("isready")?;
        while e.line()? != "readyok" {}
        Ok(e)
    }
    fn send(&mut self, s: &str) -> Result<()> {
        writeln!(self.input, "{s}")?;
        self.input.flush()?;
        Ok(())
    }
    fn line(&self) -> Result<String> {
        self.lines
            .recv_timeout(Duration::from_secs(120))
            .context("Stockfish stopped responding (120-second line timeout)")
    }
    fn evaluate(&mut self, p: &Chess, depth: u32) -> Result<Evaluation> {
        if p.legal_moves().is_empty() {
            return Ok(Evaluation {
                source: "stockfish".into(),
                score_cp: Some(0),
                mate: if p.is_check() { Some(0) } else { None },
                best_move: None,
                depth,
            });
        }
        self.send("ucinewgame")?;
        self.send(&format!("position fen {}", fen(p)))?;
        self.send(&format!("go depth {depth}"))?;
        let mut v = Evaluation {
            source: "stockfish".into(),
            score_cp: None,
            mate: None,
            best_move: None,
            depth: 0,
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        loop {
            if std::time::Instant::now() > deadline {
                bail!("Stockfish search exceeded 120 seconds")
            }
            let line = self.line()?;
            let t = line.split_whitespace().collect::<Vec<_>>();
            if t.first() == Some(&"info")
                && !t.contains(&"lowerbound")
                && !t.contains(&"upperbound")
            {
                if let Some(i) = t.iter().position(|s| *s == "score") {
                    if let (Some(kind), Some(num)) = (t.get(i + 1), t.get(i + 2)) {
                        if let Ok(n) = num.parse::<i64>() {
                            match *kind {
                                "cp" => {
                                    v.score_cp = Some(n);
                                    v.mate = None
                                }
                                "mate" => {
                                    v.mate = Some(n);
                                    v.score_cp = None
                                }
                                _ => {}
                            }
                            if let Some(i) = t.iter().position(|s| *s == "depth") {
                                v.depth = t.get(i + 1).and_then(|x| x.parse().ok()).unwrap_or(0)
                            }
                        }
                    }
                }
            }
            if t.first() == Some(&"bestmove") {
                v.best_move = t.get(1).map(|s| s.to_string());
                break;
            }
        }
        if v.depth < depth || v.score_cp.is_none() && v.mate.is_none() {
            bail!("Stockfish did not return requested depth {depth}: {v:?}")
        }
        let mut check = p.clone();
        play(&mut check, v.best_move.as_deref().context("No best move")?)?;
        Ok(v)
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.send("quit");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Serialize, Deserialize)]
struct Cached {
    scope: String,
    key: String,
    value: Evaluation,
}
struct Analyzer {
    engine: Engine,
    scope: String,
    cache: HashMap<String, Evaluation>,
    file: File,
    analyzed: usize,
    hits: usize,
}
impl Analyzer {
    fn new(a: &Args) -> Result<Self> {
        let engine = Engine::start(&a.stockfish)?;
        let meta = fs::metadata(&a.stockfish).ok();
        let scope = format!(
            "{}|{}|{}|{:?}|{}",
            engine.identity,
            a.stockfish.display(),
            meta.as_ref().map(|m| m.len()).unwrap_or(0),
            meta.and_then(|m| m.modified().ok()),
            a.depth
        );
        let path = a.output.with_extension("cache.ndjson");
        let mut cache = HashMap::new();
        if let Ok(f) = File::open(&path) {
            for l in BufReader::new(f).lines().map_while(std::result::Result::ok) {
                if let Ok(c) = serde_json::from_str::<Cached>(&l) {
                    if c.scope == scope {
                        cache.insert(c.key, c.value);
                    }
                }
            }
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            engine,
            scope,
            cache,
            file,
            analyzed: 0,
            hits: 0,
        })
    }
    fn get(&mut self, p: &Chess, depth: u32) -> Result<Evaluation> {
        let k = key(&fen(p));
        if let Some(v) = self.cache.get(&k) {
            self.hits += 1;
            return Ok(v.clone());
        }
        let v = self.engine.evaluate(p, depth)?;
        serde_json::to_writer(
            &mut self.file,
            &Cached {
                scope: self.scope.clone(),
                key: k.clone(),
                value: v.clone(),
            },
        )?;
        writeln!(self.file)?;
        self.file.flush()?;
        self.cache.insert(k, v.clone());
        self.analyzed += 1;
        Ok(v)
    }
}
fn node(graph: &mut Value, p: &Chess) {
    let f = fen(p);
    let k = key(&f);
    if graph["nodes"].get(&k).is_none() {
        graph["nodes"][&k] = json!({"key":k,"fen":f,"visits":0,"edges":[]})
    }
}
fn connect(graph: &mut Value, p: &mut Chess, uci: &str, refutation: bool) -> Result<()> {
    node(graph, p);
    let k = key(&fen(p));
    let san = play(p, uci)?;
    node(graph, p);
    let to = key(&fen(p));
    let edges = graph["nodes"][&k]["edges"].as_array_mut().unwrap();
    if let Some(e) = edges.iter_mut().find(|e| e["uci"] == uci) {
        e["count"] = json!(e["count"].as_u64().unwrap() + 1);
        if refutation {
            e["refutation"] = json!(true)
        }
    } else {
        let mut e = json!({"uci":uci,"san":san,"to":to,"count":1});
        if refutation {
            e["refutation"] = json!(true)
        }
        edges.push(e)
    }
    Ok(())
}
struct Output {
    graph: Value,
    cards: BTreeMap<String, Value>,
    pgn: String,
    seen_games: HashSet<String>,
    scanned: usize,
    matched: usize,
    mistakes: usize,
    errors: usize,
}
impl Output {
    fn new() -> Self {
        let p = Chess::default();
        let f = fen(&p);
        let mut s = Self {
            graph: json!({"version":1,"root":key(&f),"nodes":{},"games":0,"warnings":[],"lines":[]}),
            cards: BTreeMap::new(),
            pgn: String::new(),
            seen_games: HashSet::new(),
            scanned: 0,
            matched: 0,
            mistakes: 0,
            errors: 0,
        };
        node(&mut s.graph, &p);
        s
    }
    fn warn(&mut self, e: impl std::fmt::Display) {
        eprintln!("Warning: {e}");
        self.errors += 1;
        if self.graph["warnings"].as_array().unwrap().len() < 1000 {
            self.graph["warnings"]
                .as_array_mut()
                .unwrap()
                .push(json!(e.to_string()))
        }
    }
    fn card(&mut self, p: &Chess, v: &Evaluation, g: &Game, a: &Args) -> Result<()> {
        let name = if p.turn().is_white() {
            "White"
        } else {
            "Black"
        };
        if !a.username.is_empty()
            && !g
                .headers
                .get(name)
                .map(|n| n.eq_ignore_ascii_case(&a.username))
                .unwrap_or(false)
        {
            return Ok(());
        }
        if let Some(uci) = &v.best_move {
            let f = fen(p);
            let k = key(&f);
            let mut q = p.clone();
            let san = play(&mut q, uci)?;
            self.cards.entry(k.clone()).or_insert_with(||json!({"id":k,"fen":f,"uci":uci,"san":san,"source":"stockfish","due":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,"interval":0,"repetitions":0,"ease":2.5,"lapses":0}));
        }
        Ok(())
    }
    fn game(&mut self, g: Game, a: &Args, engine: &mut Analyzer) -> Result<()> {
        self.scanned += 1;
        if !accepts(&g, a) || g.moves.is_empty() {
            return Ok(());
        }
        if let Some(id) = g
            .headers
            .get("Link")
            .or_else(|| g.headers.get("Site"))
            .filter(|s| s.starts_with("https://lichess.org/") || s.contains("chess.com/game/"))
        {
            if !self.seen_games.insert(id.clone()) {
                return Ok(());
            }
        }
        let mut p = g.start.clone();
        let start = fen(&p);
        if self.matched == 0 {
            self.graph["root"] = json!(key(&start));
        }
        node(&mut self.graph, &p);
        let mut line = json!({"root":key(&start),"fen":start,"moves":[],"white":g.headers.get("White").cloned().unwrap_or_default(),"black":g.headers.get("Black").cloned().unwrap_or_default(),"result":g.headers.get("Result").cloned().unwrap_or_else(||"*".into()),"game":self.matched});
        let mut seen = HashSet::new();
        let mut visited = HashSet::new();
        let mut text = String::new();
        for uci in &g.moves {
            let k = key(&fen(&p));
            if !seen.insert(k.clone()) {
                break;
            }
            let parent = engine.get(&p, a.depth)?;
            self.graph["nodes"][&k]["analysis"] = serde_json::to_value(&parent)?;
            self.card(&p, &parent, &g, a)?;
            let before = p.clone();
            connect(&mut self.graph, &mut p, uci, false)?;
            visited.insert(k);
            append_pgn(&mut text, &before, uci)?;
            line["moves"].as_array_mut().unwrap().push(json!(uci));
            let child = engine.get(&p, a.depth)?;
            let child_key = key(&fen(&p));
            self.graph["nodes"][&child_key]["analysis"] = serde_json::to_value(&child)?;
            visited.insert(child_key);
            if mistake(&parent, &child, uci) {
                self.mistakes += 1;
                line["mistakePly"] = json!(line["moves"].as_array().unwrap().len() - 1);
                if let Some(reply) = &child.best_move {
                    self.card(&p, &child, &g, a)?;
                    let before = p.clone();
                    connect(&mut self.graph, &mut p, reply, true)?;
                    append_pgn(&mut text, &before, reply)?;
                    line["moves"].as_array_mut().unwrap().push(json!(reply));
                    visited.insert(key(&fen(&p)));
                }
                break;
            }
        }
        for k in visited {
            let n = &mut self.graph["nodes"][&k];
            n["visits"] = json!(n["visits"].as_u64().unwrap_or(0) + 1)
        }
        self.matched += 1;
        self.graph["games"] = json!(self.matched);
        self.graph["lines"].as_array_mut().unwrap().push(line);
        self.pgn
            .push_str("[Event \"Repertoire Forge native\"]\n[Result \"*\"]\n");
        if g.start != Chess::default() {
            self.pgn
                .push_str(&format!("[SetUp \"1\"]\n[FEN \"{}\"]\n", fen(&g.start)))
        }
        self.pgn.push_str(&format!("\n{text}*\n\n"));
        Ok(())
    }
    fn save(&self, a: &Args, engine: &Analyzer, complete: bool) -> Result<()> {
        let settings = json!({"mistakeCp":25,"depth":a.depth,"maxPly":a.max_ply,"theoryPlies":16,"minTheoryGames":20,"maxTheoryDrop":0.05,"trainSide":"both","username":a.username});
        let stats = json!({"scanned":self.scanned,"matched":self.matched,"mistakes":self.mistakes,"cards":self.cards.len(),"analyzed":engine.analyzed,"cacheHits":engine.hits,"errors":self.errors,"complete":complete});
        let backup = json!({"format":"repertoire-forge","version":1,"graph":self.graph,"cards":self.cards.values().collect::<Vec<_>>(),"settings":settings,"book":null,"native":stats});
        let bytes = serde_json::to_vec(&backup)?;
        if bytes.len() > 25 * 1024 * 1024 {
            bail!("Web backup exceeds the web restore 25 MiB limit; previous checkpoint preserved. Split the input.")
        }
        atomic(&a.output.with_extension("pgn"), self.pgn.as_bytes())?;
        atomic(&a.output.with_extension("json"), &bytes)?;
        Ok(())
    }
}
fn append_pgn(text: &mut String, p: &Chess, uci: &str) -> Result<()> {
    let f = fen(p);
    let fields = f.split_whitespace().collect::<Vec<_>>();
    let mut q = p.clone();
    let san = play(&mut q, uci)?;
    text.push_str(&format!(
        "{}{} {} ",
        fields[5],
        if p.turn().is_white() { "." } else { "..." },
        san
    ));
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().unwrap_or_default().to_string_lossy()
    ));
    let mut f = File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(tmp, path)?;
    Ok(())
}
fn run(a: Args) -> Result<()> {
    if let Some(input) = &a.input {
        let source = fs::canonicalize(input)?;
        for ext in ["pgn", "json", "cache.ndjson", "archive.pgn"] {
            if fs::canonicalize(a.output.with_extension(ext)).ok().as_ref() == Some(&source) {
                bail!("Output would overwrite the input PGN; choose a different --output prefix");
            }
        }
    }

    if let Some(parent) = a.output.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?
    }
    let archive = a.output.with_extension("archive.pgn");
    let mut download_error = None;
    let input = if let Some(input) = &a.input {
        input
    } else {
        if let Err(e) = remote(&a, &archive) {
            eprintln!("Fetch error: {e:#}; processing any games already downloaded");
            download_error = Some(e)
        }
        &archive
    };
    if !input.exists() {
        return Err(
            download_error.unwrap_or_else(|| anyhow!("Input does not exist: {}", input.display()))
        );
    }
    let mut reader = Reader::new(File::open(input)?);
    let mut visitor = PgnVisitor {
        max: a.max_ply as usize,
    };
    let mut engine = Analyzer::new(&a)?;
    let mut output = Output::new();
    if let Some(e) = &download_error {
        output.warn(e)
    }
    loop {
        if a.max_games > 0 && output.scanned >= a.max_games {
            break;
        }
        let game = match reader.read_game(&mut visitor) {
            Ok(Some(g)) => g,
            Ok(None) => break,
            Err(e) => {
                output.warn(&e);
                output.save(&a, &engine, false)?;
                return Err(e.into());
            }
        };
        match game {
            Ok(g) => {
                if let Err(e) = output.game(g, &a, &mut engine) {
                    output.warn(&e);
                    output.save(&a, &engine, false)?;
                    return Err(e.context("Partial backup saved"));
                }
            }
            Err(e) => output.warn(e),
        }
        if output.matched % 25 == 0 {
            output.save(&a, &engine, false)?;
        }
        if output.graph["nodes"].as_object().unwrap().len() > 190000
            || output.graph["lines"].as_array().unwrap().len() >= 99000
            || output.cards.len() >= 99000
        {
            bail!("Web restore capacity reached; previous checkpoint preserved. Split the input.")
        }
    }
    output.save(&a, &engine, download_error.is_none())?;
    eprintln!("{} scanned; {} matched; {} mistakes; {} unique cards; {} engine searches; {} cache hits; {} warnings",output.scanned,output.matched,output.mistakes,output.cards.len(),engine.analyzed,engine.hits,output.errors);
    if let Some(e) = download_error {
        return Err(e.context("Partial web backup saved"));
    }
    Ok(())
}
fn stream_lichess(reader: impl BufRead, path: &Path) -> Result<usize> {
    let mut out = File::create(path)?;
    let mut count = 0;
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(&line)
            .context("Invalid Lichess NDJSON; earlier games preserved on disk")?;
        let pgn = v["pgn"]
            .as_str()
            .context("Lichess omitted pgn (pgnInJson required)")?;
        writeln!(out, "{pgn}\n")?;
        out.flush()?;
        count += 1;
        if count % 100 == 0 {
            eprintln!("Downloaded {count} games")
        }
    }
    Ok(count)
}
fn http_get(client: &reqwest::blocking::Client, url: &str) -> Result<reqwest::blocking::Response> {
    for attempt in 0..4 {
        let r = client.get(url).send()?;
        if r.status().as_u16() == 429 && attempt < 3 {
            let delay = r
                .headers()
                .get("retry-after")
                .and_then(|s| s.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(2 << attempt)
                .min(300);
            std::thread::sleep(Duration::from_secs(delay));
            continue;
        }
        return Ok(r.error_for_status()?);
    }
    unreachable!()
}
fn remote(a: &Args, path: &Path) -> Result<()> {
    if a.username.is_empty()
        || a.username.len() > 40
        || !a
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("Remote fetch requires a valid --username")
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent("RepertoireForge-native/0.1 (public chess archive research)")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(3600))
        .build()?;
    if a.platform == "lichess" {
        let mut url=format!("https://lichess.org/api/games/user/{}?pgnInJson=true&ongoing=false&finished=true&clocks=false&evals=false&opening=false&moves=true",a.username);
        if a.max_games > 0 {
            url.push_str(&format!("&max={}", a.max_games));
        }
        let response = client
            .get(url)
            .header("Accept", "application/x-ndjson")
            .send()?
            .error_for_status()?;
        let n = stream_lichess(BufReader::new(response), path)?;
        eprintln!("Downloaded {n} Lichess games");
        return Ok(());
    }
    let url = format!(
        "https://api.chess.com/pub/player/{}/games/archives",
        a.username
    );
    let index: Value = http_get(&client, &url)?.json()?;
    let months = index["archives"]
        .as_array()
        .context("Chess.com omitted archives array")?;
    let mut out = File::create(path)?;
    let mut count = 0;
    for month in months {
        if a.max_games > 0 && count >= a.max_games {
            break;
        }
        let url = month.as_str().context("Invalid Chess.com archive URL")?;
        let parsed = reqwest::Url::parse(url)?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("api.chess.com")
            || !parsed.path().to_ascii_lowercase().starts_with(&format!(
                "/pub/player/{}/games/",
                a.username.to_ascii_lowercase()
            ))
        {
            bail!("Unexpected Chess.com archive URL")
        }
        stream_month(http_get(&client, url)?, &mut out, &mut count, a.max_games)?;
        eprintln!(
            "Downloaded {} months / {count} games",
            months.iter().position(|m| m == month).unwrap_or(0) + 1
        );
    }
    Ok(())
}
mod month;
use month::stream_month;
#[cfg(test)]
mod tests;
fn main() {
    if let Err(e) = run(Args::parse()) {
        eprintln!("Error: {e:#}");
        std::process::exit(1)
    }
}
