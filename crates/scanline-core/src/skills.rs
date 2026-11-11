//! The skills, held in the binary so that what an agent reads always matches the commands
//! it has (04-AGENT-INTERFACE.md, section 8). The files in `skills/` are the source.

pub struct Skill {
    pub name: &'static str,
    /// The whole file, front matter included: what an agent's skill folder holds.
    pub file: &'static str,
}

macro_rules! skill {
    ($name:literal) => {
        Skill { name: $name, file: include_str!(concat!("../../../skills/", $name, "/SKILL.md")) }
    };
}

pub const SKILLS: &[Skill] = &[
    skill!("scanline"),
    skill!("scanline-wrong-pixels"),
    skill!("scanline-slow-frame"),
    skill!("scanline-memory"),
    skill!("scanline-with-a-person"),
    skill!("scanline-play"),
    skill!("scanline-debuggable-rendering"),
];

impl Skill {
    /// The `description` of the front matter: when to use the skill.
    pub fn description(&self) -> &'static str {
        self.front().lines().find_map(|line| line.strip_prefix("description:")).map(str::trim).unwrap_or("")
    }

    fn front(&self) -> &'static str {
        self.file.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---\n")).map(|(front, _)| front).unwrap_or("")
    }

    /// The skill without its front matter: what is read, as opposed to what is installed.
    pub fn body(&self) -> &'static str {
        self.file.strip_prefix("---\n").and_then(|rest| rest.split_once("\n---\n")).map(|(_, body)| body.trim_start()).unwrap_or(self.file)
    }
}

pub fn find(name: &str) -> Option<&'static Skill> {
    let name = name.trim().to_lowercase().replace('_', "-");

    SKILLS.iter().find(|skill| skill.name == name || skill.name.strip_prefix("scanline-") == Some(name.as_str()))
}

/// The skills by name, each with the first sentence of when to use it.
pub fn list() -> String {
    let mut lines = vec!["Skills: a recipe for each kind of job, matching this version's commands.".to_string(), String::new()];

    for skill in SKILLS {
        let about = skill.description();
        let first = about.split_inclusive(". ").next().unwrap_or(about).trim();

        lines.push(format!("  {:<30} {first}", skill.name));
    }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_skill_has_front_matter_that_names_it() {
        for skill in SKILLS {
            assert!(skill.front().lines().any(|line| line == format!("name: {}", skill.name)), "{} does not name itself", skill.name);
            assert!(skill.description().len() > 80, "{} needs a description that says when to use it", skill.name);
            assert!(skill.description().len() <= 1024, "{}'s description is {} characters; agents cut it at 1024", skill.name, skill.description().len());
            assert!(skill.body().starts_with("# "), "{} should open with its title", skill.name);
        }
    }

    #[test]
    fn a_skill_is_found_by_its_name_or_the_short_form() {
        assert_eq!(find("scanline").unwrap().name, "scanline");
        assert_eq!(find("wrong-pixels").unwrap().name, "scanline-wrong-pixels");
        assert_eq!(find("scanline_slow_frame").unwrap().name, "scanline-slow-frame");
        assert!(find("nothing").is_none());
    }

    /// A skill that names a command the binary does not have sends an agent nowhere.
    #[test]
    fn every_command_a_skill_names_exists() {
        let known: Vec<&str> = crate::TOOLS.iter().map(|tool| tool.name).collect();

        for skill in SKILLS {
            let mut rest = skill.file;

            while let Some(at) = rest.find("gfx_") {
                let name: String = rest[at + 4..].chars().take_while(|c| c.is_ascii_lowercase() || *c == '_').collect();

                // `gfx_*` is the family, not a command.
                if !name.is_empty() {
                    assert!(known.contains(&name.as_str()), "{} names gfx_{name}, which is not a command", skill.name);
                }

                rest = &rest[at + 4..];
            }
        }
    }
}
