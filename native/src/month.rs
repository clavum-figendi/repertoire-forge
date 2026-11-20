//! Chess.com month JSON is visited one game object at a time.
use anyhow::Result;
use serde::de::{self, DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::{
    fmt,
    io::{Read, Write},
};
struct Games<'a, W> {
    out: &'a mut W,
    count: &'a mut usize,
    limit: usize,
}
impl<'de, W: Write> DeserializeSeed<'de> for Games<'_, W> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de, W: Write> Visitor<'de> for Games<'_, W> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a Chess.com games array")
    }
    fn visit_seq<S: SeqAccess<'de>>(self, mut seq: S) -> std::result::Result<(), S::Error> {
        while let Some(g) = seq.next_element::<Value>()? {
            if self.limit > 0 && *self.count >= self.limit {
                continue;
            }
            let pgn = g["pgn"]
                .as_str()
                .ok_or_else(|| de::Error::custom("Chess.com game omitted PGN"))?;
            // Preserve provider speed, which may differ from inferred PGN clock class.
            if let Some(class) = g["time_class"]
                .as_str()
                .filter(|s| ["bullet", "blitz", "rapid", "daily"].contains(s))
            {
                writeln!(self.out, "[TimeClass \"{class}\"]").map_err(de::Error::custom)?;
            }
            // Preserve the unique provider game URL rather than generic Site "Chess.com".
            if let Some(url) = g["url"].as_str().filter(|s| {
                s.starts_with("https://www.chess.com/game/")
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b":/.-_".contains(&b))
            }) {
                writeln!(self.out, "[Link \"{url}\"]").map_err(de::Error::custom)?;
            }
            writeln!(self.out, "{pgn}\n").map_err(de::Error::custom)?;
            self.out.flush().map_err(de::Error::custom)?;
            *self.count += 1;
        }
        Ok(())
    }
}
struct Month<'a, W> {
    out: &'a mut W,
    count: &'a mut usize,
    limit: usize,
}
impl<'de, W: Write> Visitor<'de> for Month<'_, W> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a Chess.com month object")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<(), M::Error> {
        let mut found = false;
        while let Some(k) = map.next_key::<String>()? {
            if k == "games" {
                if found {
                    return Err(de::Error::custom("Duplicate games array"));
                }
                found = true;
                map.next_value_seed(Games {
                    out: self.out,
                    count: self.count,
                    limit: self.limit,
                })?;
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        if !found {
            return Err(de::Error::custom("Chess.com omitted games array"));
        }
        Ok(())
    }
}
pub fn stream_month(
    reader: impl Read,
    out: &mut impl Write,
    count: &mut usize,
    limit: usize,
) -> Result<()> {
    use serde::Deserializer;
    let mut d = serde_json::Deserializer::from_reader(reader);
    d.deserialize_map(Month { out, count, limit })?;
    d.end()?;
    Ok(())
}
