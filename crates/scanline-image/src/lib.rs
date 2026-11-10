//! Image services for what Scanline shows an agent.
//!
//! Images are small on purpose (01-PRD.md, principle 4): an agent pays for every pixel, and
//! exact questions are answered with numbers. Every image an agent is shown is also written
//! losslessly to disk.

use anyhow::{Context, Result, bail};

/// An 8-bit RGBA image, rows top to bottom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self> {
        if data.len() != width as usize * height as usize * 4 {
            bail!("An image of {width}x{height} needs {} bytes of RGBA, got {}.", width as usize * height as usize * 4, data.len());
        }

        Ok(Image { width, height, data })
    }

    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = (y as usize * self.width as usize + x as usize) * 4;

        [self.data[i], self.data[i + 1], self.data[i + 2], self.data[i + 3]]
    }

    /// The part of the image inside the rectangle, clipped to the image.
    pub fn crop(&self, x: u32, y: u32, width: u32, height: u32) -> Image {
        let x = x.min(self.width);
        let y = y.min(self.height);
        let width = width.min(self.width - x);
        let height = height.min(self.height - y);
        let mut data = Vec::with_capacity(width as usize * height as usize * 4);

        for row in y..y + height {
            let start = (row as usize * self.width as usize + x as usize) * 4;

            data.extend_from_slice(&self.data[start..start + width as usize * 4]);
        }

        Image { width, height, data }
    }

    /// Each pixel becomes a `factor` x `factor` block, with no blending. With `grid`, a line
    /// one pixel wide separates the blocks so single pixels can be counted.
    pub fn zoom(&self, factor: u32, grid: bool) -> Image {
        let factor = factor.max(1);
        let grid = grid && factor >= 4;
        let width = self.width * factor;
        let height = self.height * factor;
        let mut data = vec![0u8; width as usize * height as usize * 4];

        for y in 0..height {
            for x in 0..width {
                let mut colour = self.pixel(x / factor, y / factor);

                if grid && (x % factor == 0 || y % factor == 0) {
                    // A line that shows on any colour: dark over light, light over dark.
                    let luma = (colour[0] as u32 * 3 + colour[1] as u32 * 6 + colour[2] as u32) / 10;
                    let line = if luma > 110 { 40 } else { 150 };

                    colour = [line, line, line, 255];
                }

                let i = (y as usize * width as usize + x as usize) * 4;

                data[i..i + 4].copy_from_slice(&colour);
            }
        }

        Image { width, height, data }
    }

    /// Shrinks by a whole factor, averaging each block, so that neither edge exceeds `max_edge`.
    /// Returns the image and the factor used (1 when it already fits).
    pub fn fit(&self, max_edge: u32) -> (Image, u32) {
        let longest = self.width.max(self.height);
        let factor = if max_edge == 0 || longest <= max_edge { 1 } else { longest.div_ceil(max_edge) };

        if factor == 1 {
            return (self.clone(), 1);
        }

        let width = (self.width / factor).max(1);
        let height = (self.height / factor).max(1);
        let mut data = Vec::with_capacity(width as usize * height as usize * 4);

        for y in 0..height {
            for x in 0..width {
                let mut sum = [0u32; 4];
                let mut count = 0u32;

                for sy in y * factor..((y + 1) * factor).min(self.height) {
                    for sx in x * factor..((x + 1) * factor).min(self.width) {
                        let pixel = self.pixel(sx, sy);

                        for channel in 0..4 {
                            sum[channel] += pixel[channel] as u32;
                        }

                        count += 1;
                    }
                }

                for channel in sum {
                    data.push(((channel + count / 2) / count.max(1)) as u8);
                }
            }
        }

        (Image { width, height, data }, factor)
    }

    /// Alpha set to opaque. A canvas with premultiplied alpha is otherwise shown dimmer than
    /// it is drawn; the exact stored values are what `pixels` reports.
    pub fn opaque(&self) -> Image {
        let mut data = self.data.clone();

        for pixel in data.chunks_exact_mut(4) {
            pixel[3] = 255;
        }

        Image { width: self.width, height: self.height, data }
    }

    pub fn to_png(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();

        {
            let mut encoder = png::Encoder::new(&mut out, self.width.max(1), self.height.max(1));

            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);

            let mut writer = encoder.write_header().context("writing a PNG header")?;

            if self.width == 0 || self.height == 0 {
                writer.write_image_data(&[0, 0, 0, 0]).context("writing PNG data")?;
            } else {
                writer.write_image_data(&self.data).context("writing PNG data")?;
            }
        }

        Ok(out)
    }

    pub fn from_png(bytes: &[u8]) -> Result<Image> {
        let mut decoder = png::Decoder::new(bytes);

        decoder.set_transformations(png::Transformations::normalize_to_color8() | png::Transformations::ALPHA);

        let mut reader = decoder.read_info().context("reading a PNG header")?;
        let mut buffer = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buffer).context("decoding a PNG")?;

        buffer.truncate(info.buffer_size());

        let data = match info.color_type {
            png::ColorType::Rgba => buffer,
            png::ColorType::GrayscaleAlpha => buffer.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
            other => bail!("Unexpected PNG colour type {other:?} after normalising."),
        };

        Image::new(info.width, info.height, data)
    }
}

/// What one channel of a region holds.
#[derive(Debug, Clone, PartialEq)]
pub struct ChannelStats {
    pub min: u8,
    pub max: u8,
    pub mean: f64,
    /// Eight equal buckets from 0–31 to 224–255.
    pub histogram: [u64; 8],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub pixels: u64,
    /// Red, green, blue, alpha.
    pub channels: [ChannelStats; 4],
    /// Pixels with a colour channel at 255: clipped highlights.
    pub saturated: u64,
    /// Pixels whose colour channels are all 0.
    pub black: u64,
    /// Pixels with alpha 0.
    pub transparent: u64,
    /// Distinct RGBA values, counted up to `DISTINCT_LIMIT`.
    pub distinct: usize,
}

pub const DISTINCT_LIMIT: usize = 4096;

/// How two images of the same size differ.
#[derive(Debug, Clone)]
pub struct Difference {
    pub pixels: u64,
    pub changed: u64,
    /// Largest difference in any channel of any pixel.
    pub max: u8,
    /// Mean absolute difference per channel, over every pixel.
    pub mean: f64,
    /// The rectangle containing every changed pixel: x, y, width, height.
    pub bounds: Option<(u32, u32, u32, u32)>,
    /// Separate changed areas, largest first: x, y, width, height, changed pixels.
    pub areas: Vec<(u32, u32, u32, u32, u64)>,
    /// The first image dimmed to grey, with changed pixels from dark red (small) to yellow (large).
    pub heat: Image,
}

impl Image {
    pub fn stats(&self) -> Stats {
        let empty = ChannelStats { min: 255, max: 0, mean: 0.0, histogram: [0; 8] };
        let mut channels = [empty.clone(), empty.clone(), empty.clone(), empty];
        let mut sums = [0u64; 4];
        let mut distinct = std::collections::HashSet::new();
        let (mut saturated, mut black, mut transparent) = (0u64, 0u64, 0u64);

        for pixel in self.data.chunks_exact(4) {
            for (channel, value) in pixel.iter().enumerate() {
                let stats = &mut channels[channel];

                stats.min = stats.min.min(*value);
                stats.max = stats.max.max(*value);
                stats.histogram[(*value >> 5) as usize] += 1;
                sums[channel] += *value as u64;
            }

            saturated += (pixel[0] == 255 || pixel[1] == 255 || pixel[2] == 255) as u64;
            black += (pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0) as u64;
            transparent += (pixel[3] == 0) as u64;

            if distinct.len() < DISTINCT_LIMIT {
                distinct.insert([pixel[0], pixel[1], pixel[2], pixel[3]]);
            }
        }

        let pixels = (self.data.len() / 4) as u64;

        for (channel, stats) in channels.iter_mut().enumerate() {
            stats.mean = if pixels > 0 { sums[channel] as f64 / pixels as f64 } else { 0.0 };

            if pixels == 0 {
                stats.min = 0;
            }
        }

        Stats { pixels, channels, saturated, black, transparent, distinct: distinct.len() }
    }

    /// Compares this image with another of the same size. A pixel counts as changed when any
    /// channel differs by more than `threshold`.
    pub fn difference(&self, other: &Image, threshold: u8) -> Result<Difference> {
        if self.width != other.width || self.height != other.height {
            bail!(
                "The images are different sizes ({}×{} and {}×{}), so they cannot be compared pixel for pixel. Take both with the same region and scale.",
                self.width,
                self.height,
                other.width,
                other.height
            );
        }

        // Changed pixels are gathered into areas on a coarse grid: neighbouring cells with
        // changes belong to one area.
        const CELL: u32 = 8;

        let columns = self.width.div_ceil(CELL).max(1);
        let rows = self.height.div_ceil(CELL).max(1);
        let mut cells = vec![0u64; (columns * rows) as usize];
        let mut heat = Vec::with_capacity(self.data.len());
        let (mut changed, mut max, mut total) = (0u64, 0u8, 0u64);
        let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0u32, 0u32);

        for (index, (a, b)) in self.data.chunks_exact(4).zip(other.data.chunks_exact(4)).enumerate() {
            let mut largest = 0u8;

            for channel in 0..4 {
                let delta = a[channel].abs_diff(b[channel]);

                largest = largest.max(delta);
                total += delta as u64;
            }

            max = max.max(largest);

            if largest > threshold {
                let x = index as u32 % self.width;
                let y = index as u32 / self.width;

                changed += 1;
                left = left.min(x);
                top = top.min(y);
                right = right.max(x);
                bottom = bottom.max(y);
                cells[((y / CELL) * columns + x / CELL) as usize] += 1;

                // Dark red for a small change through to yellow for a full-range one.
                let strength = largest as u32;

                heat.extend_from_slice(&[(128 + strength / 2) as u8, strength as u8, 0, 255]);
            } else {
                let grey = ((a[0] as u32 * 3 + a[1] as u32 * 6 + a[2] as u32) / 10 / 4) as u8;

                heat.extend_from_slice(&[grey, grey, grey, 255]);
            }
        }

        // Flood-fill the grid to find separate areas.
        let mut areas = Vec::new();
        let mut seen = vec![false; cells.len()];

        for start in 0..cells.len() {
            if cells[start] == 0 || seen[start] {
                continue;
            }

            let mut stack = vec![start];
            let (mut x0, mut y0, mut x1, mut y1, mut count) = (u32::MAX, u32::MAX, 0u32, 0u32, 0u64);

            seen[start] = true;

            while let Some(cell) = stack.pop() {
                let (cx, cy) = (cell as u32 % columns, cell as u32 / columns);

                x0 = x0.min(cx);
                y0 = y0.min(cy);
                x1 = x1.max(cx);
                y1 = y1.max(cy);
                count += cells[cell];

                for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)] {
                    let (nx, ny) = (cx as i64 + dx, cy as i64 + dy);

                    if nx < 0 || ny < 0 || nx >= columns as i64 || ny >= rows as i64 {
                        continue;
                    }

                    let next = (ny as u32 * columns + nx as u32) as usize;

                    if cells[next] > 0 && !seen[next] {
                        seen[next] = true;
                        stack.push(next);
                    }
                }
            }

            let x = x0 * CELL;
            let y = y0 * CELL;

            areas.push((x, y, ((x1 + 1) * CELL).min(self.width) - x, ((y1 + 1) * CELL).min(self.height) - y, count));
        }

        areas.sort_by_key(|area| std::cmp::Reverse(area.4));

        let pixels = (self.data.len() / 4) as u64;

        Ok(Difference {
            pixels,
            changed,
            max,
            mean: if pixels > 0 { total as f64 / (pixels * 4) as f64 } else { 0.0 },
            bounds: (changed > 0).then(|| (left, top, right - left + 1, bottom - top + 1)),
            areas,
            heat: Image { width: self.width, height: self.height, data: heat },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_describe_each_channel() {
        let stats = checker().stats();

        assert_eq!(stats.pixels, 8);
        assert_eq!((stats.channels[0].min, stats.channels[0].max), (0, 255));
        assert_eq!(stats.channels[0].mean, 255.0 * 3.0 / 8.0);
        assert_eq!(stats.channels[0].histogram, [5, 0, 0, 0, 0, 0, 0, 3]);
        assert_eq!(stats.channels[3].min, 255);
        assert_eq!(stats.saturated, 7);
        assert_eq!(stats.black, 1);
        assert_eq!(stats.transparent, 0);
        assert_eq!(stats.distinct, 5);
    }

    #[test]
    fn difference_counts_changes_and_finds_separate_areas() {
        let a = Image::new(40, 20, vec![10; 40 * 20 * 4]).unwrap();
        let mut b = a.clone();

        // Two changes far apart: a 2×2 block near the top-left, one pixel near the bottom-right.
        for (x, y, value) in [(1, 1, 200), (2, 1, 200), (1, 2, 200), (2, 2, 200), (38, 18, 13)] {
            let i = (y * 40 + x) * 4;

            b.data[i] = value;
        }

        let same = a.difference(&a, 0).unwrap();

        assert_eq!((same.changed, same.max, same.bounds), (0, 0, None));
        assert!(same.areas.is_empty());

        let diff = a.difference(&b, 0).unwrap();

        assert_eq!(diff.changed, 5);
        assert_eq!(diff.max, 190);
        assert_eq!(diff.bounds, Some((1, 1, 38, 18)));
        assert_eq!(diff.areas.len(), 2);
        assert_eq!(diff.areas[0], (0, 0, 8, 8, 4));
        assert_eq!(diff.areas[1], (32, 16, 8, 4, 1));
        assert_eq!(diff.heat.pixel(1, 1), [223, 190, 0, 255]);
        assert_eq!(diff.heat.pixel(20, 10), [2, 2, 2, 255]);

        // A threshold ignores the small change.
        let coarse = a.difference(&b, 8).unwrap();

        assert_eq!(coarse.changed, 4);
        assert_eq!(coarse.areas.len(), 1);

        let wrong = a.difference(&Image::new(2, 2, vec![0; 16]).unwrap(), 0).unwrap_err().to_string();

        assert!(wrong.contains("different sizes (40×20 and 2×2)"), "{wrong}");
    }

    fn checker() -> Image {
        // 4x2: red, green, blue, white / black, red, green, blue
        let rows: [[u8; 4]; 8] =
            [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];

        Image::new(4, 2, rows.concat()).unwrap()
    }

    #[test]
    fn crop_is_clipped_to_the_image() {
        let image = checker();
        let part = image.crop(2, 1, 10, 10);

        assert_eq!((part.width, part.height), (2, 1));
        assert_eq!(part.pixel(0, 0), [0, 255, 0, 255]);
        assert_eq!(part.pixel(1, 0), [0, 0, 255, 255]);
        assert_eq!(image.crop(9, 9, 1, 1).data.len(), 0);
    }

    #[test]
    fn zoom_repeats_pixels_exactly_and_draws_a_grid() {
        let image = checker();
        let plain = image.zoom(3, false);

        assert_eq!((plain.width, plain.height), (12, 6));
        assert_eq!(plain.pixel(0, 0), [255, 0, 0, 255]);
        assert_eq!(plain.pixel(2, 2), [255, 0, 0, 255]);
        assert_eq!(plain.pixel(3, 0), [0, 255, 0, 255]);
        assert_eq!(plain.pixel(11, 5), [0, 0, 255, 255]);

        let gridded = image.zoom(8, true);

        // Cell interiors keep the pixel's colour; the first row and column of each cell are the line.
        assert_eq!(gridded.pixel(4, 4), [255, 0, 0, 255]);
        assert_eq!(gridded.pixel(0, 4), [150, 150, 150, 255], "a light line over a red pixel");
        assert_eq!(gridded.pixel(16, 4), [150, 150, 150, 255], "a light line over a blue pixel");
        assert_eq!(gridded.pixel(28, 4), [255, 255, 255, 255]);
        assert_eq!(gridded.pixel(24, 4), [40, 40, 40, 255], "a dark line over a white pixel");
        assert_eq!(gridded.pixel(8, 4), [40, 40, 40, 255], "a dark line over a green pixel");
    }

    #[test]
    fn fit_averages_blocks_and_reports_the_factor() {
        let image = checker();
        let (same, one) = image.fit(8);

        assert_eq!(one, 1);
        assert_eq!(same, image);

        let (small, factor) = image.fit(2);

        assert_eq!(factor, 2);
        assert_eq!((small.width, small.height), (2, 1));
        // red, green, black, red averaged.
        assert_eq!(small.pixel(0, 0), [128, 64, 0, 255]);
    }

    #[test]
    fn png_round_trip_is_lossless() {
        let image = checker();
        let decoded = Image::from_png(&image.to_png().unwrap()).unwrap();

        assert_eq!(decoded, image);
    }
}
