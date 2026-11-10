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

#[cfg(test)]
mod tests {
    use super::*;

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
