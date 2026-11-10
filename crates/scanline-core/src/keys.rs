//! Key names an agent may use, and what the browser needs to synthesise each.

/// What `Input.dispatchKeyEvent` needs. No native key code is ever sent: on macOS it left
/// the next mouse event unacknowledged (spike S4).
pub struct Key {
    pub key: String,
    pub code: String,
    pub windows_code: u32,
    /// The text a key press types, for printable keys.
    pub text: Option<String>,
}

const NAMED: &[(&str, &str, &str, u32)] = &[
    // name an agent writes, DOM key, DOM code, Windows virtual key
    ("ArrowLeft", "ArrowLeft", "ArrowLeft", 37),
    ("ArrowUp", "ArrowUp", "ArrowUp", 38),
    ("ArrowRight", "ArrowRight", "ArrowRight", 39),
    ("ArrowDown", "ArrowDown", "ArrowDown", 40),
    ("Left", "ArrowLeft", "ArrowLeft", 37),
    ("Up", "ArrowUp", "ArrowUp", 38),
    ("Right", "ArrowRight", "ArrowRight", 39),
    ("Down", "ArrowDown", "ArrowDown", 40),
    ("Enter", "Enter", "Enter", 13),
    ("Escape", "Escape", "Escape", 27),
    ("Esc", "Escape", "Escape", 27),
    ("Tab", "Tab", "Tab", 9),
    ("Backspace", "Backspace", "Backspace", 8),
    ("Delete", "Delete", "Delete", 46),
    ("Shift", "Shift", "ShiftLeft", 16),
    ("ShiftLeft", "Shift", "ShiftLeft", 16),
    ("ShiftRight", "Shift", "ShiftRight", 16),
    ("Control", "Control", "ControlLeft", 17),
    ("ControlLeft", "Control", "ControlLeft", 17),
    ("ControlRight", "Control", "ControlRight", 17),
    ("Alt", "Alt", "AltLeft", 18),
    ("AltLeft", "Alt", "AltLeft", 18),
    ("Meta", "Meta", "MetaLeft", 91),
    ("Home", "Home", "Home", 36),
    ("End", "End", "End", 35),
    ("PageUp", "PageUp", "PageUp", 33),
    ("PageDown", "PageDown", "PageDown", 34),
];

/// Resolves a key by its DOM `key` or `code` name: "ArrowRight", "Space", "a", "KeyA", "Digit1", "F5".
pub fn lookup(name: &str) -> Option<Key> {
    if name == " " || name.eq_ignore_ascii_case("space") {
        return Some(Key { key: " ".into(), code: "Space".into(), windows_code: 32, text: Some(" ".into()) });
    }

    if let Some((_, key, code, windows_code)) = NAMED.iter().find(|entry| entry.0.eq_ignore_ascii_case(name)) {
        let text = (*key == "Enter").then(|| "\r".to_string());

        return Some(Key { key: key.to_string(), code: code.to_string(), windows_code: *windows_code, text });
    }

    let letter = |c: char| Key {
        key: c.to_ascii_lowercase().to_string(),
        code: format!("Key{}", c.to_ascii_uppercase()),
        windows_code: c.to_ascii_uppercase() as u32,
        text: Some(c.to_ascii_lowercase().to_string()),
    };

    let digit = |c: char| Key { key: c.to_string(), code: format!("Digit{c}"), windows_code: c as u32, text: Some(c.to_string()) };

    let mut chars = name.chars();

    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphabetic() => return Some(letter(c)),
        (Some(c), None) if c.is_ascii_digit() => return Some(digit(c)),
        _ => {}
    }

    if let Some(rest) = name.strip_prefix("Key") {
        if let (Some(c), None) = (rest.chars().next(), rest.chars().nth(1)) {
            if c.is_ascii_alphabetic() {
                return Some(letter(c));
            }
        }
    }

    if let Some(rest) = name.strip_prefix("Digit") {
        if let (Some(c), None) = (rest.chars().next(), rest.chars().nth(1)) {
            if c.is_ascii_digit() {
                return Some(digit(c));
            }
        }
    }

    if let Some(number) = name.strip_prefix('F').and_then(|rest| rest.parse::<u32>().ok()) {
        if (1..=12).contains(&number) {
            return Some(Key { key: name.to_string(), code: name.to_string(), windows_code: 111 + number, text: None });
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_resolve_by_key_or_code() {
        let right = lookup("ArrowRight").unwrap();

        assert_eq!((right.key.as_str(), right.code.as_str(), right.windows_code), ("ArrowRight", "ArrowRight", 39));
        assert!(right.text.is_none());

        let space = lookup("Space").unwrap();

        assert_eq!((space.key.as_str(), space.code.as_str(), space.windows_code), (" ", "Space", 32));

        for name in ["a", "A", "KeyA"] {
            let a = lookup(name).unwrap();

            assert_eq!((a.key.as_str(), a.code.as_str(), a.windows_code, a.text.as_deref()), ("a", "KeyA", 65, Some("a")));
        }

        assert_eq!(lookup("Digit7").unwrap().windows_code, 55);
        assert_eq!(lookup("F5").unwrap().windows_code, 116);
        assert!(lookup("NotAKey").is_none());
        assert!(lookup("F13").is_none());
    }
}
