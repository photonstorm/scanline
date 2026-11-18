//! An MP4 file from encoded video and sound: H.264 with, if there is any, AAC.
//!
//! The browser encodes (WebCodecs, in the page); this writes what it produced into the one
//! container every player and every site takes. It is the plain kind of MP4: the index
//! (`moov`) first, so that a file can start playing before it has all arrived, then the
//! samples (`mdat`) with a second of pictures and a second of sound turn about.
//!
//! Only what such a file needs is written: one video track with no reordered frames, and
//! at most one sound track. ISO/IEC 14496-12 names the boxes; 14496-15 the `avcC` record and
//! 14496-14 the `esds` one, both of which arrive ready-made from the encoder.

use anyhow::{Result, bail};

/// One encoded frame of video or packet of sound.
pub struct Sample {
    pub data: Vec<u8>,
    /// For video: whether the frame can be decoded by itself.
    pub key: bool,
}

pub struct Video {
    pub width: u32,
    pub height: u32,
    /// Frames a second. Every frame lasts exactly 1/fps.
    pub fps: u32,
    /// The decoder's configuration as the encoder gave it: an AVCDecoderConfigurationRecord.
    pub avcc: Vec<u8>,
    pub samples: Vec<Sample>,
}

pub struct Audio {
    pub rate: u32,
    pub channels: u16,
    /// The AudioSpecificConfig the encoder gave.
    pub config: Vec<u8>,
    /// Sample frames in each packet: 1024 for AAC.
    pub packet: u32,
    /// Sample frames at the start that the decoder produces and a player must drop (the
    /// encoder's priming), so that sound and picture start together.
    pub skip: u32,
    /// Sample frames of real sound, after the skip. The last packet may hold more.
    pub length: u64,
    pub bitrate: u32,
    pub samples: Vec<Sample>,
}

/// The movie's own clock: milliseconds.
const MOVIE_SCALE: u32 = 1000;

fn make(kind: &[u8; 4], body: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 0];

    out.extend_from_slice(kind);
    body(&mut out);

    let size = out.len() as u32;

    out[0..4].copy_from_slice(&size.to_be_bytes());
    out
}

/// A box with a version and flags.
fn full(kind: &[u8; 4], version: u8, flags: u32, body: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    make(kind, |out| {
        out.push(version);
        out.extend_from_slice(&flags.to_be_bytes()[1..]);
        body(out);
    })
}

fn u16be(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_be_bytes());
}

fn u32be(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_be_bytes());
}

/// The matrix that leaves a picture as it is.
fn identity(out: &mut Vec<u8>) {
    for value in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
        u32be(out, value);
    }
}

/// Where one track's samples lie in the file: runs of samples (chunks), and each run's offset.
struct Layout {
    /// How many samples are in each chunk.
    chunks: Vec<u32>,
    /// Each chunk's offset from the start of the sample data.
    offsets: Vec<u64>,
}

fn sample_table(entry: Vec<u8>, sizes: &[u32], delta: u32, keys: Option<Vec<u32>>, layout: &Layout, base: u64) -> Vec<u8> {
    make(b"stbl", |out| {
        out.extend(full(b"stsd", 0, 0, |out| {
            u32be(out, 1);
            out.extend(entry);
        }));

        // Every sample lasts the same.
        out.extend(full(b"stts", 0, 0, |out| {
            u32be(out, 1);
            u32be(out, sizes.len() as u32);
            u32be(out, delta);
        }));

        if let Some(keys) = keys {
            out.extend(full(b"stss", 0, 0, |out| {
                u32be(out, keys.len() as u32);

                for key in keys {
                    u32be(out, key);
                }
            }));
        }

        // Which chunk holds how many samples: one entry where the count changes.
        out.extend(full(b"stsc", 0, 0, |out| {
            let mut runs: Vec<(u32, u32)> = Vec::new();

            for (index, count) in layout.chunks.iter().enumerate() {
                if runs.last().is_none_or(|run| run.1 != *count) {
                    runs.push((index as u32 + 1, *count));
                }
            }

            u32be(out, runs.len() as u32);

            for (first, count) in runs {
                u32be(out, first);
                u32be(out, count);
                u32be(out, 1);
            }
        }));

        out.extend(full(b"stsz", 0, 0, |out| {
            u32be(out, 0);
            u32be(out, sizes.len() as u32);

            for size in sizes {
                u32be(out, *size);
            }
        }));

        out.extend(full(b"stco", 0, 0, |out| {
            u32be(out, layout.offsets.len() as u32);

            for offset in &layout.offsets {
                u32be(out, (base + offset) as u32);
            }
        }));
    })
}

#[allow(clippy::too_many_arguments)]
fn track(id: u32, video: bool, movie_duration: u32, scale: u32, media_duration: u64, size: (u32, u32), edit: Option<(u32, u32)>, table: Vec<u8>) -> Vec<u8> {
    make(b"trak", |out| {
        // Enabled, and part of the movie.
        out.extend(full(b"tkhd", 0, 3, |out| {
            u32be(out, 0);
            u32be(out, 0);
            u32be(out, id);
            u32be(out, 0);
            u32be(out, movie_duration);
            u32be(out, 0);
            u32be(out, 0);
            u16be(out, 0);
            u16be(out, 0);
            u16be(out, if video { 0 } else { 0x0100 });
            u16be(out, 0);
            identity(out);
            u32be(out, size.0 << 16);
            u32be(out, size.1 << 16);
        }));

        // Where in the media the track starts: past what the decoder must drop.
        if let Some((length, start)) = edit {
            out.extend(make(b"edts", |out| {
                out.extend(full(b"elst", 0, 0, |out| {
                    u32be(out, 1);
                    u32be(out, length);
                    u32be(out, start);
                    u16be(out, 1);
                    u16be(out, 0);
                }));
            }));
        }

        out.extend(make(b"mdia", |out| {
            out.extend(full(b"mdhd", 0, 0, |out| {
                u32be(out, 0);
                u32be(out, 0);
                u32be(out, scale);
                u32be(out, media_duration as u32);
                // The language is not said ("und").
                u16be(out, 0x55c4);
                u16be(out, 0);
            }));

            out.extend(full(b"hdlr", 0, 0, |out| {
                u32be(out, 0);
                out.extend_from_slice(if video { b"vide" } else { b"soun" });
                out.extend_from_slice(&[0; 12]);
                out.extend_from_slice(if video { b"Scanline video\0" } else { b"Scanline sound\0" });
            }));

            out.extend(make(b"minf", |out| {
                if video {
                    out.extend(full(b"vmhd", 0, 1, |out| out.extend_from_slice(&[0; 8])));
                } else {
                    out.extend(full(b"smhd", 0, 0, |out| out.extend_from_slice(&[0; 4])));
                }

                // The samples are in this file.
                out.extend(make(b"dinf", |out| {
                    out.extend(full(b"dref", 0, 0, |out| {
                        u32be(out, 1);
                        out.extend(full(b"url ", 0, 1, |_| {}));
                    }));
                }));

                out.extend(table);
            }));
        }));
    })
}

fn video_entry(video: &Video) -> Vec<u8> {
    make(b"avc1", |out| {
        out.extend_from_slice(&[0; 6]);
        u16be(out, 1);
        out.extend_from_slice(&[0; 16]);
        u16be(out, video.width as u16);
        u16be(out, video.height as u16);
        // 72 dots an inch, as every file says.
        u32be(out, 0x0048_0000);
        u32be(out, 0x0048_0000);
        u32be(out, 0);
        u16be(out, 1);
        // The encoder's name: 32 bytes, the first its length.
        out.extend_from_slice(&[0; 32]);
        u16be(out, 0x0018);
        u16be(out, 0xffff);
        out.extend(make(b"avcC", |out| out.extend_from_slice(&video.avcc)));
    })
}

/// A length as an MPEG-4 descriptor writes one.
fn descriptor(tag: u8, body: Vec<u8>) -> Vec<u8> {
    let mut out = vec![tag];
    let mut length = body.len();
    let mut bytes = vec![(length & 0x7f) as u8];

    length >>= 7;

    while length > 0 {
        bytes.insert(0, (length & 0x7f) as u8 | 0x80);
        length >>= 7;
    }

    out.extend(bytes);
    out.extend(body);
    out
}

fn audio_entry(audio: &Audio) -> Vec<u8> {
    make(b"mp4a", |out| {
        out.extend_from_slice(&[0; 6]);
        u16be(out, 1);
        out.extend_from_slice(&[0; 8]);
        u16be(out, audio.channels);
        u16be(out, 16);
        u32be(out, 0);
        u32be(out, audio.rate << 16);

        out.extend(full(b"esds", 0, 0, |out| {
            // MPEG-4 audio (0x40), an audio stream (0x15), then the encoder's own configuration.
            let mut decoder = vec![0x40, 0x15, 0, 0, 0];

            decoder.extend_from_slice(&audio.bitrate.to_be_bytes());
            decoder.extend_from_slice(&audio.bitrate.to_be_bytes());
            decoder.extend(descriptor(0x05, audio.config.clone()));

            let mut stream = vec![0, 0, 0];

            stream.extend(descriptor(0x04, decoder));
            stream.extend(descriptor(0x06, vec![2]));
            out.extend(descriptor(0x03, stream));
        }));
    })
}

/// Writes the file. The video's frames are in the order they are shown.
pub fn write(video: &Video, audio: Option<&Audio>) -> Result<Vec<u8>> {
    if video.samples.is_empty() {
        bail!("There are no frames to put in the file.");
    }

    if video.avcc.is_empty() {
        bail!("The video encoder gave no configuration, so nothing could play the file.");
    }

    if !video.samples[0].key {
        bail!("The first frame is not one a player can start from.");
    }

    let fps = video.fps.max(1);
    let frames = video.samples.len() as u64;
    let audio = audio.filter(|audio| !audio.samples.is_empty() && !audio.config.is_empty());

    // A second of pictures, then the sound that goes with it, and so on.
    let mut order: Vec<(bool, usize, usize)> = Vec::new();
    let per_second = audio.map(|audio| (audio.rate / audio.packet.max(1)).max(1) as usize).unwrap_or(1);
    let (mut next_frame, mut next_packet) = (0usize, 0usize);

    while next_frame < video.samples.len() || audio.is_some_and(|audio| next_packet < audio.samples.len()) {
        if next_frame < video.samples.len() {
            let end = (next_frame + fps as usize).min(video.samples.len());

            order.push((true, next_frame, end));
            next_frame = end;
        }

        if let Some(audio) = audio {
            if next_packet < audio.samples.len() {
                // What is left of the sound goes after the last pictures.
                let end = if next_frame >= video.samples.len() { audio.samples.len() } else { (next_packet + per_second).min(audio.samples.len()) };

                order.push((false, next_packet, end));
                next_packet = end;
            }
        }
    }

    let mut layouts = [Layout { chunks: Vec::new(), offsets: Vec::new() }, Layout { chunks: Vec::new(), offsets: Vec::new() }];
    let mut at = 0u64;

    for (is_video, from, to) in &order {
        let layout = &mut layouts[if *is_video { 0 } else { 1 }];

        layout.chunks.push((to - from) as u32);
        layout.offsets.push(at);

        at += if *is_video {
            video.samples[*from..*to].iter().map(|sample| sample.data.len() as u64).sum::<u64>()
        } else {
            audio.map_or(0, |audio| audio.samples[*from..*to].iter().map(|sample| sample.data.len() as u64).sum::<u64>())
        };
    }

    let data_size = at;

    // The index says where every sample is, and its own size decides that: so it is made
    // once to be measured, and again with the offsets it then knows.
    let moov = |base: u64| -> Vec<u8> {
        let movie_duration = (frames * MOVIE_SCALE as u64).div_ceil(fps as u64) as u32;

        make(b"moov", |out| {
            out.extend(full(b"mvhd", 0, 0, |out| {
                u32be(out, 0);
                u32be(out, 0);
                u32be(out, MOVIE_SCALE);
                u32be(out, movie_duration);
                u32be(out, 0x0001_0000);
                u16be(out, 0x0100);
                out.extend_from_slice(&[0; 10]);
                identity(out);
                out.extend_from_slice(&[0; 24]);
                u32be(out, if audio.is_some() { 3 } else { 2 });
            }));

            let sizes: Vec<u32> = video.samples.iter().map(|sample| sample.data.len() as u32).collect();
            let keys: Vec<u32> = video.samples.iter().enumerate().filter(|(_, sample)| sample.key).map(|(index, _)| index as u32 + 1).collect();

            out.extend(track(
                1,
                true,
                movie_duration,
                fps * 1000,
                frames * 1000,
                (video.width, video.height),
                None,
                sample_table(video_entry(video), &sizes, 1000, Some(keys), &layouts[0], base),
            ));

            if let Some(audio) = audio {
                let sizes: Vec<u32> = audio.samples.iter().map(|sample| sample.data.len() as u32).collect();
                // No longer than the pictures, and starting past what the decoder drops.
                let heard = audio.length.min(frames * audio.rate as u64 / fps as u64);
                let length = (heard * MOVIE_SCALE as u64 / audio.rate as u64) as u32;

                out.extend(track(
                    2,
                    false,
                    length,
                    audio.rate,
                    audio.samples.len() as u64 * audio.packet as u64,
                    (0, 0),
                    Some((length, audio.skip)),
                    sample_table(audio_entry(audio), &sizes, audio.packet, None, &layouts[1], base),
                ));
            }
        })
    };

    let ftyp = make(b"ftyp", |out| {
        out.extend_from_slice(b"isom");
        u32be(out, 0x200);

        for brand in [b"isom", b"iso2", b"avc1", b"mp41"] {
            out.extend_from_slice(brand);
        }
    });

    let base = (ftyp.len() + moov(0).len() + 8) as u64;

    if base + data_size > u32::MAX as u64 {
        bail!("The film is over 4 GB, which this file cannot hold. Film fewer frames, or at a lower bitrate.");
    }

    let mut out = ftyp;

    out.extend(moov(base));
    u32be(&mut out, data_size as u32 + 8);
    out.extend_from_slice(b"mdat");

    for (is_video, from, to) in order {
        if is_video {
            for sample in &video.samples[from..to] {
                out.extend_from_slice(&sample.data);
            }
        } else if let Some(audio) = audio {
            for sample in &audio.samples[from..to] {
                out.extend_from_slice(&sample.data);
            }
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The boxes of a file, as (path, offset of the body, length of the body).
    fn boxes(data: &[u8], from: usize, to: usize, path: &str, out: &mut Vec<(String, usize, usize)>) {
        let mut at = from;

        while at + 8 <= to {
            let size = u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize;
            let kind = String::from_utf8_lossy(&data[at + 4..at + 8]).to_string();
            let here = format!("{path}/{kind}");

            assert!(size >= 8 && at + size <= to, "{here} has a size that does not fit: {size}");
            out.push((here.clone(), at + 8, size - 8));

            if ["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts"].contains(&kind.as_str()) {
                boxes(data, at + 8, at + size, &here, out);
            }

            at += size;
        }

        assert_eq!(at, to, "{path} is not filled exactly by its boxes");
    }

    fn u32at(data: &[u8], at: usize) -> u32 {
        u32::from_be_bytes(data[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn a_film_is_laid_out_so_that_every_sample_is_where_the_index_says() {
        // 150 frames at 60 a second (2.5 s), each frame's bytes its own number; and 118
        // packets of sound at 48 kHz (1024 frames each: 2.52 s).
        let video = Video {
            width: 320,
            height: 240,
            fps: 60,
            avcc: vec![1, 100, 0, 31, 0xff, 0xe1, 0, 2, 0x67, 0x64, 1, 0, 2, 0x68, 0xee],
            samples: (0..150u32).map(|frame| Sample { data: vec![frame as u8; 10 + frame as usize % 7], key: frame % 60 == 0 }).collect(),
        };
        let audio = Audio {
            rate: 48000,
            channels: 2,
            config: vec![0x11, 0x90],
            packet: 1024,
            skip: 2112,
            length: 120_000,
            bitrate: 160_000,
            samples: (0..118u32).map(|packet| Sample { data: vec![200 + (packet % 50) as u8; 5 + packet as usize % 3], key: true }).collect(),
        };
        let file = write(&video, Some(&audio)).unwrap();
        let mut found = Vec::new();

        boxes(&file, 0, file.len(), "", &mut found);

        let names: Vec<&str> = found.iter().map(|entry| entry.0.as_str()).collect();

        assert_eq!(&names[..3], ["/ftyp", "/moov", "/moov/mvhd"], "the index comes before the samples");
        assert_eq!(names.last(), Some(&"/mdat"));
        assert_eq!(names.iter().filter(|name| **name == "/moov/trak").count(), 2);

        let all = |name: &str| -> Vec<(usize, usize)> { found.iter().filter(|entry| entry.0 == name).map(|entry| (entry.1, entry.2)).collect() };
        let stbl = "/moov/trak/mdia/minf/stbl";

        // The movie lasts 2.5 s; the video's own clock counts 1000 a frame at 60000 a second.
        assert_eq!((u32at(&file, all("/moov/mvhd")[0].0 + 12), u32at(&file, all("/moov/mvhd")[0].0 + 16)), (1000, 2500));
        assert_eq!((u32at(&file, all("/moov/trak/mdia/mdhd")[0].0 + 12), u32at(&file, all("/moov/trak/mdia/mdhd")[0].0 + 16)), (60000, 150_000));
        assert_eq!((u32at(&file, all("/moov/trak/mdia/mdhd")[1].0 + 12), u32at(&file, all("/moov/trak/mdia/mdhd")[1].0 + 16)), (48000, 118 * 1024));

        // The sound starts past the 2112 frames the decoder drops, and lasts as long as the pictures.
        let elst = all("/moov/trak/edts/elst")[0].0;

        assert_eq!((u32at(&file, elst + 8), u32at(&file, elst + 12)), (2500, 2112));

        // Key frames at 1, 61 and 121.
        let stss = all(&format!("{stbl}/stss"))[0].0;

        assert_eq!((u32at(&file, stss + 4), u32at(&file, stss + 8), u32at(&file, stss + 12), u32at(&file, stss + 16)), (3, 1, 61, 121));

        // Walk each track's chunks and sizes: every sample is where it is said to be.
        let expected: [(usize, usize, fn(usize) -> u8); 2] = [(0, 150, |index| index as u8), (1, 118, |index| 200 + (index % 50) as u8)];

        for (track, count, first) in expected {
            let stsz = all(&format!("{stbl}/stsz"))[track].0;
            let stco = all(&format!("{stbl}/stco"))[track].0;
            let stsc = all(&format!("{stbl}/stsc"))[track].0;

            assert_eq!(u32at(&file, stsz + 8) as usize, count);

            let sizes: Vec<usize> = (0..count).map(|index| u32at(&file, stsz + 12 + index * 4) as usize).collect();
            let offsets: Vec<usize> = (0..u32at(&file, stco + 4) as usize).map(|index| u32at(&file, stco + 8 + index * 4) as usize).collect();
            let runs: Vec<(usize, usize)> = (0..u32at(&file, stsc + 4) as usize)
                .map(|index| (u32at(&file, stsc + 8 + index * 12) as usize, u32at(&file, stsc + 12 + index * 12) as usize))
                .collect();
            let mut sample = 0;

            for (chunk, offset) in offsets.iter().enumerate() {
                let per = runs.iter().rev().find(|run| run.0 <= chunk + 1).unwrap().1;
                let mut at = *offset;

                for _ in 0..per {
                    assert!(file[at..at + sizes[sample]].iter().all(|byte| *byte == first(sample)), "track {track} sample {sample} is not at {at}");
                    at += sizes[sample];
                    sample += 1;
                }
            }

            assert_eq!(sample, count, "track {track}: every sample is in a chunk");
        }

        // With no sound there is one track, and nothing is written for the other.
        let silent = write(&video, None).unwrap();
        let mut found = Vec::new();

        boxes(&silent, 0, silent.len(), "", &mut found);
        assert_eq!(found.iter().filter(|entry| entry.0 == "/moov/trak").count(), 1);

        // What cannot be played is refused.
        assert!(write(&Video { samples: Vec::new(), ..video }, None).is_err());
    }
}
