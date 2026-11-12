//! Shader source, coloured: GLSL and WGSL, line by line. A small tokenizer, not a parser:
//! comments, preprocessor lines, keywords, types, built-in functions, numbers and attributes.

use std::ops::Range;

use gpui::{HighlightStyle, Hsla};

use crate::theme::*;

const KEYWORDS: &[&str] = &[
    "if",
    "else",
    "for",
    "while",
    "do",
    "return",
    "discard",
    "break",
    "continue",
    "switch",
    "case",
    "default",
    "struct",
    "uniform",
    "in",
    "out",
    "inout",
    "attribute",
    "varying",
    "const",
    "precision",
    "highp",
    "mediump",
    "lowp",
    "layout",
    "flat",
    "smooth",
    "centroid",
    "invariant",
    "var",
    "let",
    "fn",
    "loop",
    "override",
    "alias",
    "enable",
    "requires",
    "true",
    "false",
    "storage",
    "read",
    "write",
    "read_write",
    "function",
    "private",
    "workgroup",
];

const TYPES: &[&str] = &[
    "void",
    "bool",
    "int",
    "uint",
    "float",
    "double",
    "vec2",
    "vec3",
    "vec4",
    "ivec2",
    "ivec3",
    "ivec4",
    "uvec2",
    "uvec3",
    "uvec4",
    "bvec2",
    "bvec3",
    "bvec4",
    "mat2",
    "mat3",
    "mat4",
    "mat2x2",
    "mat3x3",
    "mat4x4",
    "sampler2D",
    "sampler3D",
    "samplerCube",
    "sampler2DArray",
    "sampler2DShadow",
    "samplerCubeShadow",
    "sampler2DArrayShadow",
    "isampler2D",
    "usampler2D",
    "f32",
    "f16",
    "i32",
    "u32",
    "vec2f",
    "vec3f",
    "vec4f",
    "vec2i",
    "vec3i",
    "vec4i",
    "vec2u",
    "vec3u",
    "vec4u",
    "mat2x2f",
    "mat3x3f",
    "mat4x4f",
    "mat3x4f",
    "mat4x3f",
    "array",
    "ptr",
    "atomic",
    "sampler",
    "sampler_comparison",
    "texture_2d",
    "texture_3d",
    "texture_cube",
    "texture_2d_array",
    "texture_depth_2d",
    "texture_depth_cube",
    "texture_multisampled_2d",
    "texture_storage_2d",
    "texture_external",
];

const BUILTINS: &[&str] = &[
    "texture",
    "texture2D",
    "textureCube",
    "texture2DProj",
    "textureLod",
    "textureGrad",
    "texelFetch",
    "textureSize",
    "textureSample",
    "textureSampleLevel",
    "textureSampleCompare",
    "textureSampleBias",
    "textureSampleGrad",
    "textureLoad",
    "textureStore",
    "textureDimensions",
    "mix",
    "clamp",
    "dot",
    "cross",
    "normalize",
    "length",
    "distance",
    "reflect",
    "refract",
    "pow",
    "exp",
    "exp2",
    "log",
    "log2",
    "sqrt",
    "inversesqrt",
    "abs",
    "sign",
    "floor",
    "ceil",
    "fract",
    "mod",
    "min",
    "max",
    "step",
    "smoothstep",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "radians",
    "degrees",
    "transpose",
    "inverse",
    "determinant",
    "dFdx",
    "dFdy",
    "fwidth",
    "dpdx",
    "dpdy",
    "select",
    "saturate",
    "round",
    "trunc",
    "fma",
    "bitcast",
    "arrayLength",
    "all",
    "any",
    "gl_Position",
    "gl_FragColor",
    "gl_FragCoord",
    "gl_FragData",
    "gl_PointSize",
    "gl_VertexID",
    "gl_InstanceID",
    "gl_FrontFacing",
    "gl_PointCoord",
    "gl_FragDepth",
    "pack4x8unorm",
    "unpack4x8unorm",
];

pub fn colour(value: u32) -> Hsla {
    Hsla::from(rgb_value(value))
}

fn rgb_value(value: u32) -> gpui::Rgba {
    gpui::rgb(value)
}

fn style(value: u32) -> HighlightStyle {
    HighlightStyle { color: Some(colour(value)), ..Default::default() }
}

/// The coloured ranges of one line. `in_comment` carries a /* … */ from one line to the next.
pub fn highlight(line: &str, in_comment: &mut bool) -> Vec<(Range<usize>, HighlightStyle)> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;

    while at < bytes.len() {
        if *in_comment {
            let end = line[at..].find("*/").map(|offset| at + offset + 2).unwrap_or(bytes.len());

            out.push((at..end, style(DIM)));
            *in_comment = end == bytes.len() && !line[at..].contains("*/");
            at = end;
            continue;
        }

        let rest = &line[at..];

        if rest.starts_with("//") {
            out.push((at..bytes.len(), style(DIM)));
            break;
        }

        if rest.starts_with("/*") {
            *in_comment = true;
            out.push((at..at + 2, style(DIM)));
            at += 2;
            continue;
        }

        let byte = bytes[at];

        // A preprocessor line, whole.
        if byte == b'#' && line[..at].trim().is_empty() {
            out.push((at..bytes.len(), style(PURPLE)));
            break;
        }

        // A WGSL attribute: @vertex, @group(0).
        if byte == b'@' {
            let end = at + 1 + rest[1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len() - 1);

            out.push((at..end, style(PURPLE)));
            at = end;
            continue;
        }

        if byte.is_ascii_digit() || (byte == b'.' && bytes.get(at + 1).is_some_and(u8::is_ascii_digit)) {
            let end = at + rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '_')).unwrap_or(rest.len());

            out.push((at..end, style(AMBER)));
            at = end;
            continue;
        }

        if byte.is_ascii_alphabetic() || byte == b'_' {
            let end = at + rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
            let word = &line[at..end];

            if KEYWORDS.contains(&word) {
                out.push((at..end, style(RED)));
            } else if TYPES.contains(&word) {
                out.push((at..end, style(CYAN)));
            } else if BUILTINS.contains(&word) {
                out.push((at..end, style(BLUE)));
            } else if word.starts_with("gl_") || word.starts_with("ANGLE") || word.starts_with("_u") {
                out.push((at..end, style(ORANGE)));
            }

            at = end;
            continue;
        }

        // Anything else, one character at a time (a multi-byte character as a whole).
        at += rest.chars().next().map(char::len_utf8).unwrap_or(1);
    }

    out
}

/// A whole source as lines, each with its coloured ranges.
pub fn lines(source: &str) -> Vec<(String, Vec<(Range<usize>, HighlightStyle)>)> {
    let mut in_comment = false;

    source
        .lines()
        .map(|line| {
            // Tabs as four spaces, so the columns line up in the panel's fixed-width face.
            let line = line.replace('\t', "    ");
            let ranges = highlight(&line, &mut in_comment);

            (line, ranges)
        })
        .collect()
}
