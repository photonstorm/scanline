//! Where captures live (02-ARCHITECTURE.md, section 4.2).
//!
//! ```text
//! <artefacts>/
//!   blobs/ab/cdef…                 shared, content-addressed (BLAKE3), compressed (zstd)
//!   captures/cap_12/capture.sqlite the tables the query commands read
//!   captures/cap_12/stream.zst     the capture as the replay page takes it
//!   captures/cap_12/final.png      the frame's own final image
//! ```
//!
//! A capture is immutable and stays usable after the page it came from has closed. A texture
//! that does not change is stored once, however many captures use it.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
pub use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

pub struct Store {
    root: PathBuf,
}

/// The rows of one table of a capture's database.
pub struct Table {
    pub name: &'static str,
    /// Column definitions, as SQL: `"draw INTEGER PRIMARY KEY"`.
    pub columns: Vec<&'static str>,
    pub rows: Vec<Vec<Sql>>,
}

/// The result of a query: column names, and rows of values as JSON.
#[derive(Debug)]
pub struct Rows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// True when there were more rows than the limit allowed.
    pub truncated: bool,
}

const ZSTD_LEVEL: i32 = 3;

impl Store {
    pub fn open(root: impl Into<PathBuf>) -> Result<Store> {
        let root = root.into();

        for dir in ["blobs", "captures"] {
            std::fs::create_dir_all(root.join(dir)).with_context(|| format!("creating {}", root.join(dir).display()))?;
        }

        Ok(Store { root })
    }

    // ---- Blobs ----

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.root.join("blobs").join(&hash[..2]).join(&hash[2..])
    }

    /// Stores bytes and returns their name. Bytes already stored are not written again.
    pub fn put_blob(&self, bytes: &[u8]) -> Result<String> {
        let hash = blake3::hash(bytes).to_hex().to_string();
        let path = self.blob_path(&hash);

        if !path.exists() {
            std::fs::create_dir_all(path.parent().unwrap()).with_context(|| format!("creating {}", path.parent().unwrap().display()))?;

            // Written under another name first, so a blob is never seen half-written.
            let partial = path.with_extension("partial");

            std::fs::write(&partial, zstd::encode_all(bytes, ZSTD_LEVEL).context("compressing a blob")?)
                .with_context(|| format!("writing {}", partial.display()))?;
            std::fs::rename(&partial, &path).with_context(|| format!("naming {}", path.display()))?;
        }

        Ok(hash)
    }

    pub fn get_blob(&self, hash: &str) -> Result<Vec<u8>> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("\"{hash}\" is not the name of a blob.");
        }

        let path = self.blob_path(hash);
        let packed = std::fs::read(&path).with_context(|| format!("The capture store is missing blob {hash} ({})", path.display()))?;
        let bytes = zstd::decode_all(packed.as_slice()).with_context(|| format!("unpacking blob {hash}"))?;

        // Content-addressed means checkable: a blob that does not hash to its name is damaged.
        if blake3::hash(&bytes).to_hex().as_str() != hash {
            bail!("Blob {hash} in the capture store is damaged: its contents no longer match its name.");
        }

        Ok(bytes)
    }

    // ---- Captures ----

    pub fn capture_dir(&self, handle: &str) -> PathBuf {
        self.root.join("captures").join(handle)
    }

    fn check_handle(handle: &str) -> Result<()> {
        if handle.strip_prefix("cap_").is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())) {
            Ok(())
        } else {
            bail!("\"{handle}\" is not a capture handle. Capture handles look like cap_3; call captures to list them.")
        }
    }

    /// Every capture on disk, oldest first.
    pub fn handles(&self) -> Vec<String> {
        let mut numbers: Vec<u32> = std::fs::read_dir(self.root.join("captures"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().join("capture.sqlite").exists())
            .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("cap_")?.parse().ok())
            .collect();

        numbers.sort_unstable();
        numbers.into_iter().map(|number| format!("cap_{number}")).collect()
    }

    /// A handle no capture has had: one more than the highest on disk, used or not.
    pub fn next_handle(&self) -> String {
        let highest = std::fs::read_dir(self.root.join("captures"))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("cap_")?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);

        format!("cap_{}", highest + 1)
    }

    /// Takes a handle for a new capture, so that two captures taken at once cannot be given
    /// the same one. The handle is held by its directory existing.
    pub fn reserve_handle(&self) -> Result<String> {
        for _ in 0..1000 {
            let handle = self.next_handle();

            match std::fs::create_dir(self.capture_dir(&handle)) {
                Ok(()) => return Ok(handle),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error).with_context(|| format!("creating {}", self.capture_dir(&handle).display())),
            }
        }

        bail!("Could not take a handle for a new capture in {}.", self.root.join("captures").display())
    }

    // ---- Recordings ----
    //
    // A flight recording is a run of consecutive frames kept as one stream. It has no
    // tables of its own: any one of its frames can be made into a capture.

    pub fn recording_dir(&self, handle: &str) -> PathBuf {
        self.root.join("recordings").join(handle)
    }

    fn check_recording(handle: &str) -> Result<()> {
        if handle.strip_prefix("rec_").is_some_and(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())) {
            Ok(())
        } else {
            bail!("\"{handle}\" is not a recording handle. Recording handles look like rec_2; call recording with no handle to list them.")
        }
    }

    /// Every recording on disk, oldest first.
    pub fn recordings(&self) -> Vec<String> {
        let mut numbers: Vec<u32> = std::fs::read_dir(self.root.join("recordings"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().join("meta.json").exists())
            .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("rec_")?.parse().ok())
            .collect();

        numbers.sort_unstable();
        numbers.into_iter().map(|number| format!("rec_{number}")).collect()
    }

    /// Takes a handle for a new recording. The handle is held by its directory existing.
    pub fn reserve_recording(&self) -> Result<String> {
        let root = self.root.join("recordings");

        std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;

        for _ in 0..1000 {
            let highest = std::fs::read_dir(&root)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|entry| entry.file_name().to_str()?.strip_prefix("rec_")?.parse::<u32>().ok())
                .max()
                .unwrap_or(0);
            let handle = format!("rec_{}", highest + 1);

            match std::fs::create_dir(self.recording_dir(&handle)) {
                Ok(()) => return Ok(handle),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error).with_context(|| format!("creating {}", self.recording_dir(&handle).display())),
            }
        }

        bail!("Could not take a handle for a new recording in {}.", root.display())
    }

    pub fn write_recording(&self, handle: &str, stream: &Value, meta: &Value) -> Result<()> {
        Self::check_recording(handle)?;

        let dir = self.recording_dir(handle);

        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        std::fs::write(dir.join("stream.zst"), zstd::encode_all(serde_json::to_vec(stream)?.as_slice(), 3)?)
            .with_context(|| format!("writing {}", dir.display()))?;
        std::fs::write(dir.join("meta.json"), serde_json::to_vec_pretty(meta)?).with_context(|| format!("writing {}", dir.display()))?;

        Ok(())
    }

    pub fn recording_meta(&self, handle: &str) -> Result<Value> {
        Self::check_recording(handle)?;

        let path = self.recording_dir(handle).join("meta.json");

        if !path.exists() {
            let known = self.recordings();

            bail!(
                "No recording \"{handle}\". {}",
                match known.last() {
                    Some(latest) => format!("The most recent of {} is {latest}.", known.len()),
                    None => "None have been kept: a recording is made when Debug is pressed after request_human.".to_string(),
                }
            );
        }

        serde_json::from_slice(&std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?).context("reading the recording's facts")
    }

    /// The recording as the replay page takes it.
    pub fn recording_stream(&self, handle: &str) -> Result<Value> {
        Self::check_recording(handle)?;

        let path = self.recording_dir(handle).join("stream.zst");
        let packed = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;

        serde_json::from_slice(&zstd::decode_all(packed.as_slice()).context("unpacking the recording")?).context("reading the recording")
    }

    /// Writes a capture: its stream for replay, its tables for queries, its facts.
    pub fn write_capture(&self, handle: &str, stream: &Value, meta: &Value, tables: Vec<Table>) -> Result<()> {
        Self::check_handle(handle)?;

        let dir = self.capture_dir(handle);

        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;

        let packed = zstd::encode_all(serde_json::to_vec(stream)?.as_slice(), ZSTD_LEVEL).context("compressing the capture")?;

        std::fs::write(dir.join("stream.zst"), packed).with_context(|| format!("writing {}", dir.join("stream.zst").display()))?;

        // The database is the last thing written: its presence is what makes the capture exist.
        let partial = dir.join("capture.partial");
        let _ = std::fs::remove_file(&partial);

        {
            let mut db = Connection::open(&partial).with_context(|| format!("creating {}", partial.display()))?;
            let tx = db.transaction()?;

            tx.execute("CREATE TABLE capture (key TEXT PRIMARY KEY, value TEXT)", [])?;

            for (key, value) in meta.as_object().into_iter().flatten() {
                let text = match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };

                tx.execute("INSERT INTO capture VALUES (?1, ?2)", (key, text))?;
            }

            for table in &tables {
                tx.execute(&format!("CREATE TABLE {} ({})", table.name, table.columns.join(", ")), [])?;

                let places = vec!["?"; table.columns.len()].join(", ");
                let mut insert = tx.prepare(&format!("INSERT INTO {} VALUES ({places})", table.name))?;

                for row in &table.rows {
                    insert.execute(rusqlite::params_from_iter(row.iter())).with_context(|| format!("writing a row of {}", table.name))?;
                }
            }

            tx.commit()?;
        }

        std::fs::rename(&partial, dir.join("capture.sqlite")).with_context(|| format!("naming {}", dir.join("capture.sqlite").display()))?;

        Ok(())
    }

    fn database(&self, handle: &str) -> Result<Connection> {
        Self::check_handle(handle)?;

        let path = self.capture_dir(handle).join("capture.sqlite");

        if !path.exists() {
            let known = self.handles();

            bail!(
                "No capture \"{handle}\". {}",
                if known.is_empty() {
                    "None have been taken; call capture with a session.".to_string()
                } else {
                    format!("Captures on disk: {}.", known.join(", "))
                }
            );
        }

        // Read-only, so a query can do no harm whatever it says.
        Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .with_context(|| format!("opening {}", path.display()))
    }

    /// The capture's facts, as written at capture time.
    pub fn meta(&self, handle: &str) -> Result<Value> {
        let db = self.database(handle)?;
        let mut statement = db.prepare("SELECT key, value FROM capture")?;
        let mut out = serde_json::Map::new();

        let pairs = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;

        for pair in pairs {
            let (key, text) = pair?;

            // Numbers, lists and objects were stored as JSON text; plain text stays text.
            out.insert(key, serde_json::from_str(&text).unwrap_or(Value::String(text)));
        }

        Ok(Value::Object(out))
    }

    /// The capture as the replay page takes it.
    pub fn stream(&self, handle: &str) -> Result<Value> {
        Self::check_handle(handle)?;

        let path = self.capture_dir(handle).join("stream.zst");
        let packed = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;

        serde_json::from_slice(&zstd::decode_all(packed.as_slice()).context("unpacking the capture")?).context("reading the capture")
    }

    /// Runs one SQL statement against a capture's tables. The database is opened read-only.
    pub fn query(&self, handle: &str, sql: &str, parameters: &[Sql], limit: usize) -> Result<Rows> {
        let db = self.database(handle)?;
        let mut statement = db.prepare(sql).map_err(|error| anyhow!("SQL error: {error}"))?;
        let columns: Vec<String> = statement.column_names().into_iter().map(str::to_string).collect();
        let mut rows = Vec::new();
        let mut truncated = false;
        let mut cursor = statement.query(rusqlite::params_from_iter(parameters.iter())).map_err(|error| anyhow!("SQL error: {error}"))?;

        while let Some(row) = cursor.next().map_err(|error| anyhow!("SQL error: {error}"))? {
            if rows.len() >= limit {
                truncated = true;
                break;
            }

            rows.push(
                (0..columns.len())
                    .map(|index| match row.get_ref(index) {
                        Ok(rusqlite::types::ValueRef::Integer(value)) => json!(value),
                        Ok(rusqlite::types::ValueRef::Real(value)) => json!(value),
                        Ok(rusqlite::types::ValueRef::Text(text)) => json!(String::from_utf8_lossy(text)),
                        Ok(rusqlite::types::ValueRef::Blob(bytes)) => json!(format!("({} bytes)", bytes.len())),
                        _ => Value::Null,
                    })
                    .collect(),
            );
        }

        Ok(Rows { columns, rows, truncated })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary() -> (Store, PathBuf) {
        let root = std::env::temp_dir().join(format!("scanline-store-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&root);

        (Store::open(&root).unwrap(), root)
    }

    #[test]
    fn blobs_are_named_by_their_contents_and_stored_once() {
        let (store, root) = temporary();
        let bytes = vec![7u8; 100_000];
        let first = store.put_blob(&bytes).unwrap();
        let again = store.put_blob(&bytes).unwrap();

        assert_eq!(first, again);
        assert_eq!(first.len(), 64);
        assert_eq!(store.get_blob(&first).unwrap(), bytes);

        let path = store.blob_path(&first);

        assert!(std::fs::metadata(&path).unwrap().len() < 1000, "a hundred thousand equal bytes compress to very little");

        // A damaged blob is noticed, not returned.
        std::fs::write(&path, zstd::encode_all(&b"something else"[..], 3).unwrap()).unwrap();

        assert!(store.get_blob(&first).unwrap_err().to_string().contains("damaged"));
        assert!(store.get_blob("../../etc/passwd").unwrap_err().to_string().contains("not the name of a blob"));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_capture_is_written_listed_queried_and_read_only() {
        let (store, root) = temporary();

        assert_eq!(store.next_handle(), "cap_1");
        assert!(store.handles().is_empty());

        // A reserved handle is not given out again, and is not a capture until it is written.
        assert_eq!(store.reserve_handle().unwrap(), "cap_1");
        assert_eq!(store.reserve_handle().unwrap(), "cap_2");
        assert!(store.handles().is_empty());

        let tables = vec![Table {
            name: "draws",
            columns: vec!["draw INTEGER PRIMARY KEY", "program TEXT", "blend INTEGER"],
            rows: vec![vec![Sql::Integer(0), Sql::Text("prg_1".into()), Sql::Integer(0)], vec![Sql::Integer(1), Sql::Text("prg_2".into()), Sql::Integer(1)]],
        }];

        store.write_capture("cap_1", &json!({ "commands": [[1, []]] }), &json!({ "api": "webgl2", "width": 320, "notes": ["a"] }), tables).unwrap();

        assert_eq!(store.handles(), vec!["cap_1"]);
        assert_eq!(store.next_handle(), "cap_3");
        assert_eq!(store.meta("cap_1").unwrap(), json!({ "api": "webgl2", "width": 320, "notes": ["a"] }));
        assert_eq!(store.stream("cap_1").unwrap()["commands"][0][0], 1);

        let rows = store.query("cap_1", "SELECT draw, program FROM draws WHERE blend = ?1", &[Sql::Integer(1)], 10).unwrap();

        assert_eq!(rows.columns, vec!["draw", "program"]);
        assert_eq!(rows.rows, vec![vec![json!(1), json!("prg_2")]]);

        let limited = store.query("cap_1", "SELECT draw FROM draws", &[], 1).unwrap();

        assert_eq!(limited.rows.len(), 1);
        assert!(limited.truncated);

        // Writes are refused by the database itself.
        assert!(store.query("cap_1", "DELETE FROM draws", &[], 10).unwrap_err().to_string().contains("SQL error"));
        assert!(store.query("cap_1", "SELEC nonsense", &[], 10).unwrap_err().to_string().starts_with("SQL error"));

        let missing = store.query("cap_9", "SELECT 1", &[], 1).unwrap_err().to_string();

        assert!(missing.contains("No capture \"cap_9\". Captures on disk: cap_1."), "{missing}");
        assert!(store.meta("../x").unwrap_err().to_string().contains("not a capture handle"));

        std::fs::remove_dir_all(root).unwrap();
    }
}
